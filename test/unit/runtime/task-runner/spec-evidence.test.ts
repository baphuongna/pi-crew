/**
 * spec-evidence footer parser + coverage-gate matrix (ADR-6 §2/§3, WP-6 step 3).
 * Mirrors the B4 case (c) matrix at unit level:
 *   valid → pass, no badge · missing footer w/ musts → badge · unknown id →
 *   badge · fabricated-but-KNOWN id cited → covered, no badge (honesty AC).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSpecCoverage, parseSpecEvidenceFooter } from "../../../../src/runtime/task-runner/spec-evidence.ts";
import type { SpecSnapshot } from "../../../../src/state/types.ts";

function makeSnapshots(): SpecSnapshot[] {
	return [
		{
			specId: "spec-login",
			version: 1,
			frozenAt: "2026-08-20T00:00:00.000Z",
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

// --- Parser matrix ---

test("parser: valid footer at end → entries + citedIds", () => {
	const f = parseSpecEvidenceFooter(VALID_FOOTER);
	assert.equal(f.present, true);
	assert.equal(f.entries["acc-1"], "tests/unit/login.test.ts 12/12 pass; manual login probe OK");
	assert.deepEqual(f.citedIds, ["acc-1"]);
});

test("parser: missing footer → present:false, never throws", () => {
	const f = parseSpecEvidenceFooter("All done, no footer here.");
	assert.equal(f.present, false);
	assert.deepEqual(f.citedIds, []);
	const empty = parseSpecEvidenceFooter("");
	assert.equal(empty.present, false);
});

test("parser: LAST marker wins — a quoted earlier marker must not shadow the real footer", () => {
	const text = `Instructions said:

SPEC-EVIDENCE:
acc-fake: quoted from instructions

Real result follows.

SPEC-EVIDENCE:
acc-1: real evidence
`;
	const f = parseSpecEvidenceFooter(text);
	assert.equal(f.present, true);
	assert.deepEqual(f.citedIds, ["acc-1"]);
});

test("parser: block ends at blank line / non-entry line — later prose is not swallowed", () => {
	const f = parseSpecEvidenceFooter(`Result.

SPEC-EVIDENCE:
acc-1: evidence one

postscript: not a citation
`);
	assert.deepEqual(f.citedIds, ["acc-1"]);
	const g = parseSpecEvidenceFooter(`SPEC-EVIDENCE:
acc-1: evidence
Summary paragraph without colon-id shape.
acc-2: after-prose citation NOT part of footer
`);
	assert.deepEqual(g.citedIds, ["acc-1"], "footer block ended at the prose line");
});

test("parser: duplicate citations → last evidence wins, citedIds preserved in order", () => {
	const f = parseSpecEvidenceFooter(`SPEC-EVIDENCE:
acc-1: first attempt
acc-1: corrected evidence
`);
	assert.equal(f.entries["acc-1"], "corrected evidence");
	assert.deepEqual(f.citedIds, ["acc-1", "acc-1"]);
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

test("gate: should/could NEVER block — should-only coverage with missing must still flagged by the MISSING must, not the should", () => {
	const f = parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-2: error message shown\n");
	const r = evaluateSpecCoverage(makeSnapshots(), f);
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
	// acc-1 exists in the snapshot; the worker cites it with invented text.
	// Non-strict mode mechanically cannot detect this — no badge, by design.
	const r = evaluateSpecCoverage(makeSnapshots(), parseSpecEvidenceFooter("SPEC-EVIDENCE:\nacc-1: totally made up but id is known\n"));
	assert.equal(r.badge, undefined);
	assert.equal(r.evidence["acc-1"], "totally made up but id is known", "evidence preserved for the verifier advisory (§5)");
});
