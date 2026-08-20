/**
 * spec-evidence.ts — SPEC-EVIDENCE footer parser + coverage gate (ADR-6 §2/§3,
 * WP-6 step 3).
 *
 * The footer contract (executor prompt, SPEC contract section — step 5):
 * the result must END with
 *
 * ```
 * SPEC-EVIDENCE:
 * <acceptanceId>: <one-line evidence>
 * ```
 *
 * The parser is MECHANICAL: a map of acceptanceId → evidence. Footer lines
 * citing non-existent ids, or a missing footer where the task has
 * must-acceptances, are gate events — never crashes (§2).
 *
 * Non-strict default (§3): coverage ONLY — every must-acceptance id cited
 * ≥ 1 time. The gate never claims to verify truth. Missing footer / missing
 * ids / unknown ids → task passes with an `unverified` badge; never blocks.
 * Full-coverage fabrication is mechanically undetectable in non-strict mode
 * and passes WITHOUT a badge (the honest signal: coverage-only trusts
 * nothing about content). `should/could` requirements NEVER block any gate.
 */

import { isSpecTrusted } from "../../state/stores/spec-store.ts";
import type { SpecGateResult, SpecSnapshot } from "../../state/types.ts";
import { isSpecSandboxSupported, runSpecCheck, type SpecCheckOutcome } from "../verification/spec-sandbox.ts";

const FOOTER_MARKER = "SPEC-EVIDENCE:";
/** Acceptance ids are minted by the spec store (SPEC_ID_PATTERN-adjacent);
 *  the parser stays mechanical — any `<token>:` line is a citation, unknown
 *  tokens surface as unknownIds rather than being rejected here. */
const ENTRY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):\s?(.*)$/;

export interface SpecEvidenceFooter {
	present: boolean;
	/** acceptanceId → last one-line evidence text for that id. */
	entries: Record<string, string>;
	/** Cited ids in citation order (duplicates preserved for diagnostics). */
	citedIds: string[];
}

/** Parse the SPEC-EVIDENCE footer. The LAST `SPEC-EVIDENCE:` marker wins
 *  (a stray earlier mention — e.g. in quoted instructions — must not shadow
 *  the actual footer at the end). Entry lines stop at the first blank line
 *  or non-`id: text` line. */
export function parseSpecEvidenceFooter(text: string): SpecEvidenceFooter {
	const lines = (text ?? "").split(/\r?\n/);
	let markerIndex = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === FOOTER_MARKER) {
			markerIndex = i;
			break;
		}
	}
	if (markerIndex === -1) return { present: false, entries: {}, citedIds: [] };
	const entries: Record<string, string> = {};
	const citedIds: string[] = [];
	for (let i = markerIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") break; // footer block ends at a blank line
		const match = ENTRY_PATTERN.exec(line.trim());
		if (!match) break; // any non-entry line ends the footer block
		citedIds.push(match[1]);
		entries[match[1]] = match[2].trim();
	}
	return { present: true, entries, citedIds };
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

/** Coverage-only evaluation (§3). `strict` arrives with the sandbox in
 *  step 4 — it changes the OUTCOME mapping (fail instead of badge), never
 *  the mechanical inputs. */
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
export interface StrictCheckResult {
	specId: string;
	acceptanceId: string;
	result: "passed" | "degraded-untrusted-spec" | "degraded-non-idempotent" | "degraded-no-command" | "failed";
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
	/** Strict pass = coverage complete AND zero failed checks. Degrades badge
	 *  the task but never fail it (the §4 compromise path). */
	passed: boolean;
	/** True when the platform cannot host the re-run sandbox (macOS/Windows) —
	 *  every check fails closed; callers emit a loud platform warning. */
	platformUnsupported: boolean;
}

/** Strict-mode gate (§4): coverage (§3) AND machine-check of every
 *  machine-checkable must-acceptance. Executes ONLY snapshot-frozen commands
 *  — never the live state/specs/<id>.json (B4-k). Provenance: the re-run
 *  sandbox unlocks ONLY for specs whose store-minted trust sidecar exists
 *  (worker-authored/hand-forged manual claims degrade to coverage-only). */
export async function evaluateSpecStrict(
	snapshots: SpecSnapshot[] | undefined,
	footer: SpecEvidenceFooter,
	options: { cwd: string },
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
	for (const snap of snapshots ?? []) {
		const trusted = isSpecTrusted(options.cwd, snap.specId);
		for (const item of snap.items) {
			if (item.requirement.priority !== "must") continue; // should/could never block
			if (!trusted) {
				// NEW-2: re-running a generated/unattested spec's commands would be a
				// privilege-escalation vector — degrade to coverage-only.
				degraded = true;
				checks.push({ specId: snap.specId, acceptanceId: item.acceptance.id, result: "degraded-untrusted-spec" });
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
