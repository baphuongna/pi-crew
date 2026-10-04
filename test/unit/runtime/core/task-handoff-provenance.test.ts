// R3-2 (Pi 1.0.0 deep-learn round 3): worker self-report contract. The handoff
// template asks the worker to echo the PI_* session env (pre-set per command in
// the bash/powershell tool, SDK environment-variables.md) in a Provenance
// section — giving the leader model-provenance + session identity directly in
// the result, no log parsing, no stdout inference. Contract template ONLY:
// parseHandoffFromOutput deliberately ignores the section (no hard parser).
import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_TEMPLATE, parseHandoffFromOutput } from "../../../../src/runtime/task-packet.ts";

const SELF_REPORT_VARS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"];

test("R3-2: handoff template carries the PI_* self-report provenance contract", () => {
	assert.ok(HANDOFF_TEMPLATE.includes("### Provenance"), "Provenance section present");
	for (const v of SELF_REPORT_VARS) {
		assert.ok(HANDOFF_TEMPLATE.includes(v), `${v} named in the template`);
	}
	// Section ordering: Provenance last, so the parser's Follow-ups extraction
	// (stops at the next ### heading) is unaffected.
	assert.ok(HANDOFF_TEMPLATE.indexOf("### Follow-ups") < HANDOFF_TEMPLATE.indexOf("### Provenance"), "Provenance after Follow-ups");
});

test("R3-2: parser ignores the Provenance section (contract-only, no hard parser)", () => {
	const output = [HANDOFF_TEMPLATE.replace(/<!--[^>]*-->/g, ""), "session=abc model=prov/m-1 reasoning=high"].join("\n");
	const parsed = parseHandoffFromOutput(output);
	assert.deepEqual(parsed.summary, []);
	assert.deepEqual(parsed.followups, []);
});

test("R3-2: a worker emitting the provenance values keeps the other sections parseable", () => {
	const output = [
		"## Handoff",
		"",
		"### Summary",
		"- did the thing",
		"",
		"### Files Changed",
		"- a.ts: change",
		"",
		"### Tests / Verification",
		"- pass",
		"",
		"### Follow-ups",
		"- none",
		"",
		"### Provenance",
		"- session=abc-123 model=prov/m-1 reasoning=high file=/tmp/s.jsonl",
	].join("\n");
	const parsed = parseHandoffFromOutput(output);
	assert.deepEqual(parsed.summary, ["did the thing"]);
	assert.deepEqual(parsed.filesChanged, ["a.ts: change"]);
	assert.deepEqual(parsed.tests, ["pass"]);
	assert.deepEqual(parsed.followups, ["none"]);
});
