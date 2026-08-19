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

import type { SpecGateResult, SpecSnapshot } from "../../state/types.ts";

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
		return { mode: "coverage", applicable: false, footerPresent: footer.present, citedIds: footer.citedIds, missingMustIds: [], unknownIds: [], evidence: footer.entries };
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
