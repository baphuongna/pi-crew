/**
 * spec-evidence footer parser + coverage-gate matrix (ADR-6 §2/§3 + erratum §11.8).
 *
 * Erratum semantics under test: the footer is the TRAILING region (markers/
 * entries/blanks reaching EOF); repeated markers are block separators with
 * citations UNIONED across blocks; prose interrupts the region (a footer must
 * be terminal per the executor contract); quoted mid-text markers are ignored.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSpecCoverage, mergeFooters, parseSpecEvidenceFooter } from "../../../../src/runtime/task-runner/spec-evidence.ts";
import type { SpecSnapshot } from "../../../../src/state/types.ts";

function makeSnapshots(): SpecSnapshot[] {
	return [
		{
			specId: "spec-login",
			version: 1,
			frozenAt: "2026-08-20T00:00:00.000Z",
			trustedAtFreeze: false,
			items: [
				{
					requirement: { id: "req-1", text: "User can log in", priority: "must" },
					acceptance: { id: "acc-1", requirementId: "req-1", check: "login succeeds" },
				},
				{
					requirement: { id: "req-2", text: "Nice error message", priority: "should" },
					acceptance: { id: "acc-2", requirementId: "req-2", check: "error shown" },
				},
			],
		},
	];
}

const VALID_FOOTER = `
Work done. Tests added and passing.

SPEC-EVIDENCE:
acc-1: tests/unit/login.test.ts 12/12 pass; manual login probe OK
`;

// --- Parser matrix (erratum §11.8 semantics) ---

test("parser: valid footer at end → entries + citedIds", () => {
	const f = parseSpecEvidenceFooter(VALID_FOOTER);
	assert.equal(f.present, true);
	assert.equal(f.entries["acc-1"], "tests/unit/login.test.ts 12/12 pass; manual login probe OK");
	assert.deepEqual(f.citedIds, ["acc-1"]);
});

test("parser: missing footer → present:false, never throws", () => {
	assert.equal(parseSpecEvidenceFooter("All done, no footer here.").present, false);
	assert.deepEqual(parseSpecEvidenceFooter("All done, no footer here.").citedIds, []);
	assert.equal(parseSpecEvidenceFooter("").present, false);
});

test("parser: a quoted MID-TEXT marker followed by prose is ignored — the trailing footer wins", () => {
	const text = `Instructions said:

SPEC-EVIDENCE:
acc-fake: quoted from instructions

Real result follows.

SPEC-EVIDENCE:
acc-1: real evidence
`;
	const f = parseSpecEvidenceFooter(text);
	assert.equal(f.present, true);
	assert.deepEqual(f.citedIds, ["acc-1"], "only the trailing region is the footer");
});

test("parser: prose between footer and EOF invalidates the footer (contract: result must END with footer)", () => {
	const f = parseSpecEvidenceFooter(`SPEC-EVIDENCE:
acc-1: evidence
Summary paragraph without colon-id shape.
acc-2: after-prose citation is NOT a footer
`);
	assert.equal(f.present, false, "trailing region contains no marker → not a footer");
	assert.deepEqual(f.citedIds, []);
});

test("parser: trailing 'word: text' prose line after the footer reads as an (unknown) citation — surfaced, not swallowed", () => {
	const f = parseSpecEvidenceFooter(`Result.

SPEC-EVIDENCE:
acc-1: evidence one
postscript: not a citation
`);
	assert.equal(f.present, true);
	assert.deepEqual(f.citedIds, ["acc-1", "postscript"], "entry-shaped trailing lines are citations; unknown ids surface as gaps");
});

test("parser: repeated markers in the trailing region are block separators — citations UNION across blocks", () => {
	const f = parseSpecEvidenceFooter(`Result.

SPEC-EVIDENCE:
acc-1: from block one

SPEC-EVIDENCE:
acc-2: from block two
acc-1: corrected from block two
`);
	assert.equal(f.present, true);
	assert.deepEqual(f.citedIds, ["acc-1", "acc-2", "acc-1"], "multi-spec footers keep ALL citations (duplicates preserved)");
	assert.equal(f.entries["acc-1"], "corrected from block two", "later block wins per-id");
});

test("parser: duplicate citations → last evidence wins, citedIds preserved in order", () => {
	const f = parseSpecEvidenceFooter(`SPEC-EVIDENCE:
acc-1: first attempt
acc-1: corrected evidence
`);
	assert.equal(f.entries["acc-1"], "corrected evidence");
	assert.deepEqual(f.citedIds, ["acc-1", "acc-1"]);
});

test("parser: CRLF and trailing blank lines tolerated", () => {
	const f = parseSpecEvidenceFooter("text\r\n\r\nSPEC-EVIDENCE:\r\nacc-1: crlf evidence\r\n\r\n\r\n");
	assert.equal(f.present, true);
	assert.deepEqual(f.citedIds, ["acc-1"]);
});

test("mergeFooters: unions sources, first-seen evidence wins (artifact-chain priority)", () => {
	const a = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: from rawFinalText");
	const b = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: from finalText\nacc-2: from finalText");
	const merged = mergeFooters([a, b]);
	assert.deepEqual(merged.citedIds, ["acc-1", "acc-2"]);
	assert.equal(merged.entries["acc-1"], "from rawFinalText");
});

// --- Coverage-gate matrix (B4 case c, non-strict column) ---

test("gate: all musts cited → pass, NO badge (coverage-only trusts nothing about content)", () => {
	const f = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ran the login probe\n");
	const r = evaluateSpecCoverage(makeSnapshots(), f);
	assert.equal(r.applicable, true);
	assert.equal(r.badge, undefined, "complete coverage → no badge, even if the evidence text is fabricated");
});

test("gate: missing footer with musts → badge unverified (never blocks)", () => {
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("Done, no footer."));
	assert.equal(r.badge, "unverified");
	assert.equal(r.footerPresent, false);
	assert.deepEqual(r.missingMustIds, ["acc-1"]);
});

test("gate: must id NOT cited → badge + missingMustIds", () => {
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-2: only the should-acceptance cited\n"));
	assert.equal(r.badge, "unverified");
	assert.deepEqual(r.missingMustIds, ["acc-1"], "acc-1 is must; acc-2 covers only a should requirement");
});

test("gate: unknown id cited → badge + unknownIds (fabrication signal)", () => {
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: ok\nacc-999: invented acceptance\n"));
	assert.equal(r.badge, "unverified");
	assert.deepEqual(r.unknownIds, ["acc-999"]);
});

test("gate: should/could NEVER block — should-only coverage flagged by the MISSING must, not the should", () => {
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-2: error message shown\n"));
	assert.equal(r.badge, "unverified");
	assert.deepEqual(r.missingMustIds, ["acc-1"]);
	assert.deepEqual(r.unknownIds, []);
});

test("gate: should-only spec (no musts at all) + missing footer → NO badge", () => {
	const snapshots: SpecSnapshot[] = [
		{
			specId: "spec-soft",
			version: 1,
			frozenAt: "2026-08-20T00:00:00.000Z",
			trustedAtFreeze: false,
			items: [
				{
					requirement: { id: "req-s", text: "soft", priority: "should" },
					acceptance: { id: "acc-s", requirementId: "req-s", check: "soft check" },
				},
			],
		},
	];
	const r = evaluateSpecCoverage(snapshots, parseSpecEvidenceFooter("no footer at all"));
	assert.equal(r.applicable, true);
	assert.equal(r.badge, undefined, "no musts → nothing mechanically detectable → no badge");
});

test("gate: spec-less task (no snapshots) → not applicable, untouched (B4-j)", () => {
	const r = evaluateSpecCoverage(undefined, parseSpecEvidenceFooter("nothing"));
	assert.equal(r.applicable, false);
	assert.equal(r.badge, undefined);
	assert.equal(evaluateSpecCoverage([], parseSpecEvidenceFooter("")).applicable, false);
});

test("gate: fabricated-but-KNOWN id cited → covered, no badge (ADR §3 honesty — undetectable passes)", () => {
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: totally made up but id is known\n"));
	assert.equal(r.badge, undefined);
	assert.equal(r.evidence["acc-1"], "totally made up but id is known", "evidence preserved for the verifier advisory (§5)");
});
