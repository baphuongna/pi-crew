/**
 * spec-evidence.ts — SPEC-EVIDENCE footer parser + coverage/strict gates
 * (ADR-6 §2/§3/§4, WP-6 steps 3-4; round-1 review fixes).
 *
 * Footer contract (executor prompt, §2): the result must END with
 *
 * ```
 * SPEC-EVIDENCE:
 * <acceptanceId>: <one-line evidence>
 * ```
 *
 * Parser semantics (round-1): the footer is the TRAILING region of the text —
 * the contiguous run of marker lines, entry lines, and blank lines that
 * reaches EOF. Earlier/quoted markers followed by prose are ignored (a quoted
 * dependency footer cannot shadow or pollute the real one); repeated markers
 * inside the trailing region are block separators, and citations UNION across
 * blocks (a worker emitting one block per spec keeps ALL citations).
 *
 * Non-strict default (§3): mechanical coverage only — must-acceptance ids
 * cited >= 1 time; gaps surface as an `unverified` badge, never a block.
 * Strict (§4): coverage AND machine-check; trust is read from the snapshot's
 * frozen `trustedAtFreeze` bit (provenance v2 — the live sidecar is never
 * consulted at finalize, closing the TOCTOU window).
 */

import type { SpecGateResult, SpecSnapshot, TaskPacket } from "../../state/types.ts";
import { isSpecSandboxSupported, runSpecCheck, type SpecCheckOutcome } from "../verification/spec-sandbox.ts";

const FOOTER_MARKER = "SPEC-EVIDENCE:";
/** Acceptance ids are minted by the spec store; the parser stays mechanical —
 *  any `<token>:` line in the footer region is a citation, unknown tokens
 *  surface as unknownIds rather than being rejected here. */
const ENTRY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):\s?(.*)$/;

export interface SpecEvidenceFooter {
	present: boolean;
	/** acceptanceId → last one-line evidence text for that id. */
	entries: Record<string, string>;
	/** Cited ids in citation order (duplicates preserved for diagnostics). */
	citedIds: string[];
}

const isBlank = (line: string): boolean => line.trim() === "";
const isMarker = (line: string): boolean => line.trim() === FOOTER_MARKER;

/** Parse the trailing SPEC-EVIDENCE footer region (see module header). */
export function parseSpecEvidenceFooter(text: string): SpecEvidenceFooter {
	const lines = (text ?? "").split(/\r?\n/);
	// Walk back over trailing blanks to the last content line.
	let end = lines.length;
	while (end > 0 && isBlank(lines[end - 1] ?? "")) end--;
	// Extend the region backward over footer material (markers/entries/blanks).
	let start = end;
	while (start > 0) {
		const line = lines[start - 1] ?? "";
		if (isBlank(line) || isMarker(line) || ENTRY_PATTERN.test(line.trim())) {
			start--;
			continue;
		}
		break;
	}
	// Parse forward; require at least one marker INSIDE the region.
	const entries: Record<string, string> = {};
	const citedIds: string[] = [];
	let sawMarker = false;
	for (let i = start; i < end; i++) {
		const line = lines[i] ?? "";
		if (isMarker(line)) {
			sawMarker = true;
			continue; // block separator
		}
		if (isBlank(line)) continue;
		const match = ENTRY_PATTERN.exec(line.trim());
		if (!match) continue; // unreachable given the backward scan; defensive
		citedIds.push(match[1]);
		entries[match[1]] = match[2].trim();
	}
	if (!sawMarker) return { present: false, entries: {}, citedIds: [] };
	return { present: true, entries, citedIds };
}

/** Union footers parsed from several authoritative result sources (round-1:
 *  a footer may live in rawFinalText OR finalText OR finalStdout — child
 *  compaction can empty finalText while the footer survives elsewhere).
 *  First-seen evidence wins; citedIds keep first-seen order. */
export function mergeFooters(footers: SpecEvidenceFooter[]): SpecEvidenceFooter {
	const entries: Record<string, string> = {};
	const seen = new Set<string>();
	const citedIds: string[] = [];
	let present = false;
	for (const f of footers) {
		present = present || f.present;
		for (const id of f.citedIds) {
			if (!seen.has(id)) {
				seen.add(id);
				citedIds.push(id);
				entries[id] = f.entries[id] ?? "";
			}
		}
	}
	return { present, entries, citedIds };
}

/** Collect every acceptance id a snapshot pair exposes, split by the
 *  requirement's priority. Only `must` participates in coverage. */
function snapshotAcceptances(snapshots: SpecSnapshot[]): {
	mustIds: string[];
	knownIds: Set<string>;
} {
	const mustIds: string[] = [];
	const knownIds = new Set<string>();
	for (const snap of snapshots) {
		for (const item of snap.items) {
			knownIds.add(item.acceptance.id);
			if (item.requirement.priority === "must") mustIds.push(item.acceptance.id);
		}
	}
	return { mustIds, knownIds };
}

/** Coverage-only evaluation (§3). */
export function evaluateSpecCoverage(snapshots: SpecSnapshot[] | undefined, footer: SpecEvidenceFooter): SpecGateResult {
	if (!snapshots || snapshots.length === 0) {
		// Spec-less tasks are untouched (regression guard, B4-j).
		return {
			mode: "coverage",
			applicable: false,
			footerPresent: footer.present,
			citedIds: footer.citedIds,
			missingMustIds: [],
			unknownIds: [],
			evidence: footer.entries,
		};
	}
	const { mustIds, knownIds } = snapshotAcceptances(snapshots);
	const cited = new Set(footer.citedIds);
	const missingMustIds = mustIds.filter((id) => !cited.has(id));
	const unknownIds = footer.citedIds.filter((id) => !knownIds.has(id));
	// §2: a missing footer is a gate event ONLY where the task has
	// must-acceptances; should/could-only specs never produce a badge.
	const complete = (mustIds.length === 0 || (footer.present && missingMustIds.length === 0)) && unknownIds.length === 0;
	return {
		mode: "coverage",
		applicable: true,
		footerPresent: footer.present,
		citedIds: footer.citedIds,
		missingMustIds,
		unknownIds,
		// Badge fires ONLY on mechanically-detectable gaps: missing footer,
		// missing must-ids, unknown ids. Full-coverage fabrication passes
		// WITHOUT a badge (§3 honesty rule).
		...(complete ? {} : { badge: "unverified" as const }),
		evidence: footer.entries,
	};
}

// ── §4: strict mode — coverage AND machine-check ─────────────────────────

/** Per-acceptance strict outcome. Sandbox failures carry digest-only fields
 *  (leak discipline — raw output never persists). */
export type StrictCheckKind =
	| "passed"
	| "degraded-untrusted-spec"
	| "degraded-non-idempotent"
	| "degraded-no-command"
	| "degraded-scaffold-mode"
	| "degraded-already-failed"
	| "failed";

export interface StrictCheckResult {
	specId: string;
	acceptanceId: string;
	result: StrictCheckKind;
	/** Sandbox outcome kind when result === "failed" (ADR §4 payload schema). */
	outcome?: SpecCheckOutcome["outcome"];
	expectedDigest?: string;
	actualDigest?: string;
	exitCode?: number | null;
	signal?: string;
	durationMs?: number;
	stderrLength?: number;
}

export interface StrictGateReport {
	checks: StrictCheckResult[];
	/** Strict pass = coverage complete AND zero failed checks. Degradations
	 *  badge the task but never fail it (the §4 compromise path). */
	passed: boolean;
	/** True when the platform cannot host the re-run sandbox (macOS/Windows) —
	 *  every check fails closed; callers emit a loud platform warning. */
	platformUnsupported: boolean;
}

export interface StrictEvalOptions {
	/** Command cwd — the TASK's workspace (worktree-aware), not the run root. */
	cwd: string;
	/** "scaffold" (dry-run / executeWorkers=false) skips ALL machine-checks —
	 *  the documented disable switch must reach the sandbox (round-1 P2). */
	mode?: "run" | "scaffold";
	/** Task already failed upstream (empty-result classifier / mutation guard):
	 *  machine-checks are skipped — they cannot un-fail the task and re-running
	 *  adds up to 60s × N to finalizing a dead task (round-1 P3). */
	alreadyFailed?: boolean;
}

/** Strict-mode gate (§4): coverage (§3) AND machine-check of every
 *  machine-checkable must-acceptance. Executes ONLY snapshot-frozen commands
 *  — never the live state/specs/<id>.json (B4-k). Provenance v2: trust is the
 *  snapshot's `trustedAtFreeze` bit, minted from the user-store digest sidecar
 *  AT FREEZE — worker-authored specs, hand-forged workspace records, and
 *  post-freeze sidecar tampering all degrade to coverage-only. */
export async function evaluateSpecStrict(
	snapshots: SpecSnapshot[] | undefined,
	footer: SpecEvidenceFooter,
	options: StrictEvalOptions,
): Promise<SpecGateResult & { strict: StrictGateReport }> {
	const coverage = evaluateSpecCoverage(snapshots, footer);
	if (!coverage.applicable) {
		return {
			...coverage,
			mode: "strict",
			strict: { checks: [], passed: true, platformUnsupported: !isSpecSandboxSupported() },
		};
	}
	const platformUnsupported = !isSpecSandboxSupported();
	const checks: StrictCheckResult[] = [];
	let failed = false;
	let degraded = false;
	const skipMachineChecks = options.mode === "scaffold" || options.alreadyFailed === true;
	for (const snap of snapshots ?? []) {
		for (const item of snap.items) {
			if (item.requirement.priority !== "must") continue; // should/could never block
			if (snap.trustedAtFreeze !== true) {
				// NEW-2: re-running a generated/unattested spec's commands would be a
				// privilege-escalation vector — degrade to coverage-only.
				degraded = true;
				checks.push({ specId: snap.specId, acceptanceId: item.acceptance.id, result: "degraded-untrusted-spec" });
				continue;
			}
			if (skipMachineChecks) {
				degraded = true;
				checks.push({
					specId: snap.specId,
					acceptanceId: item.acceptance.id,
					result: options.mode === "scaffold" ? "degraded-scaffold-mode" : "degraded-already-failed",
				});
				continue;
			}
			if (!item.acceptance.command) {
				degraded = true;
				checks.push({ specId: snap.specId, acceptanceId: item.acceptance.id, result: "degraded-no-command" });
				continue;
			}
			if (item.acceptance.idempotent !== true) {
				// Non-idempotent musts cannot be machine-re-run (§4).
				degraded = true;
				checks.push({ specId: snap.specId, acceptanceId: item.acceptance.id, result: "degraded-non-idempotent" });
				continue;
			}
			const outcome = await runSpecCheck(
				{
					command: item.acceptance.command,
					expectedDigest: item.acceptance.expectedDigest,
					expectedExitCode: item.acceptance.expectedExitCode,
				},
				{ cwd: options.cwd },
			);
			if (outcome.outcome === "passed") {
				checks.push({
					specId: snap.specId,
					acceptanceId: item.acceptance.id,
					result: "passed",
					exitCode: outcome.exitCode,
					durationMs: outcome.durationMs,
				});
			} else {
				failed = true;
				checks.push({
					specId: snap.specId,
					acceptanceId: item.acceptance.id,
					result: "failed",
					outcome: outcome.outcome,
					expectedDigest: item.acceptance.expectedDigest,
					actualDigest: outcome.actualDigest,
					exitCode: outcome.exitCode,
					signal: outcome.signal,
					durationMs: outcome.durationMs,
					stderrLength: outcome.stderrLength,
				});
			}
		}
	}
	// Missing footer w/ musts ⇒ missingMustIds is non-empty (nothing cited),
	// so strict coverage-completeness = no missing musts AND no unknown ids.
	// (A should-only spec with no footer has no musts → nothing to fail.)
	const coverageComplete = coverage.missingMustIds.length === 0 && coverage.unknownIds.length === 0;
	const passed = !failed && coverageComplete;
	const result: SpecGateResult & { strict: StrictGateReport } = {
		...coverage,
		mode: "strict",
		// In strict mode a coverage gap FAILS the gate (B4-c strict column) —
		// the badge still rides along for UI visibility.
		...(coverageComplete && !degraded ? {} : { badge: "unverified" as const }),
		strict: { checks, passed, platformUnsupported },
	};
	return result;
}

// ── finalize-time orchestration (extracted for testability, round-1 P3) ────

export interface SpecGateEventData {
	type: "task.spec_gate" | "spec.strict_platform_warning" | "spec.check_failed" | "spec.freeze_failed";
	data: Record<string, unknown>;
}

export interface SpecGateOutcome {
	specGate: (SpecGateResult & { strict?: StrictGateReport }) | undefined;
	/** Events the caller must append (payloads digest-only / ids only). */
	events: SpecGateEventData[];
	/** Set when the write-gate must fail (strict). The caller PREFIXES this to
	 *  any pre-existing error instead of replacing it (round-1 P3). */
	gateError?: string;
}

/** Compute the finalize-time spec gate for one task. Pure-ish orchestration:
 *  no manifest/event-log coupling so the wiring is unit-testable. Footer is
 *  the union of every authoritative result source (artifact-chain order). */
export async function computeSpecGate(args: {
	packet: TaskPacket;
	rawFinalText?: string;
	finalText?: string;
	finalStdout?: string;
	/** Task workspace (worktree-aware) — sandbox cwd. */
	sandboxCwd: string;
	runtimeKind: string;
	/** True when the task already failed upstream (classifier/mutation guard). */
	alreadyFailed: boolean;
}): Promise<SpecGateOutcome> {
	const packet = args.packet;
	const hasSpecRefs =
		(packet.specRefs?.length ?? 0) > 0 || (packet.specSnapshots?.length ?? 0) > 0 || (packet.unresolvedSpecRefs?.length ?? 0) > 0;
	if (!hasSpecRefs) return { specGate: undefined, events: [] }; // spec-less: untouched (B4-j)
	const footer = mergeFooters([
		parseSpecEvidenceFooter(args.rawFinalText ?? ""),
		parseSpecEvidenceFooter(args.finalText ?? ""),
		parseSpecEvidenceFooter(args.finalStdout ?? ""),
	]);
	const events: SpecGateEventData[] = [];
	const unresolved = packet.unresolvedSpecRefs ?? [];
	if (unresolved.length > 0) {
		events.push({ type: "spec.freeze_failed", data: { unresolvedSpecRefs: unresolved } });
	}
	if (packet.specStrict === true) {
		const strictResult = await evaluateSpecStrict(packet.specSnapshots, footer, {
			cwd: args.sandboxCwd,
			mode: args.runtimeKind === "scaffold" ? "scaffold" : "run",
			alreadyFailed: args.alreadyFailed,
		});
		const specGate =
			unresolved.length > 0
				? { ...strictResult, badge: "unverified" as const, missingMustIds: strictResult.missingMustIds }
				: strictResult;
		if (strictResult.strict.platformUnsupported) {
			events.push({
				type: "spec.strict_platform_warning",
				data: { platform: process.platform, effect: "strict checks fail closed (no unshare)" },
			});
		}
		for (const check of strictResult.strict.checks) {
			if (check.result !== "failed") continue;
			events.push({
				type: "spec.check_failed",
				data: {
					specId: check.specId,
					acceptanceId: check.acceptanceId,
					outcome: check.outcome,
					expectedDigest: check.expectedDigest,
					actualDigest: check.actualDigest,
					exitCode: check.exitCode,
					signal: check.signal,
					durationMs: check.durationMs,
				},
			});
		}
		const strictPassed = strictResult.strict.passed && unresolved.length === 0;
		if (!strictPassed) {
			const reasons = [
				...(unresolved.length ? [`unresolved specRefs at freeze: ${unresolved.join(", ")}`] : []),
				...(strictResult.missingMustIds.length
					? [`missing must-acceptance evidence: ${strictResult.missingMustIds.join(", ")}`]
					: []),
				...(strictResult.unknownIds.length ? [`unknown acceptance ids cited: ${strictResult.unknownIds.join(", ")}`] : []),
				...strictResult.strict.checks.filter((c) => c.result === "failed").map((c) => `${c.acceptanceId}: ${c.outcome}`),
			].join("; ");
			return { specGate, events, gateError: `Spec strict gate failed (${reasons || "machine-check failure"})` };
		}
		return { specGate, events };
	}
	// Non-strict: coverage only; unresolved refs badge but never block.
	const coverage = evaluateSpecCoverage(packet.specSnapshots, footer);
	const specGate = unresolved.length > 0 ? { ...coverage, applicable: true, badge: "unverified" as const } : coverage;
	return { specGate, events };
}
