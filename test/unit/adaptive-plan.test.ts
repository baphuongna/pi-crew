import assert from "node:assert/strict";
import test from "node:test";
import {
	__test__parseAdaptivePlan,
	__test__repairAdaptivePlan,
	extractAdaptivePlanJson,
	parseAdaptivePlan,
	repairAdaptivePlan,
	slug,
} from "../../src/runtime/goal-workflow/adaptive-plan.ts";

/**
 * Round 25 (test coverage gaps): `adaptive-plan.ts` provides the adaptive
 * planner's JSON extraction, parsing, validation, and repair logic for the
 * `implementation` workflow. All tested functions are pure — no file I/O.
 */

// ─── slug ──────────────────────────────────────────────────────────────────

test("slug: lowercases and replaces non-alphanumeric with hyphens", () => {
	assert.equal(slug("Hello World"), "hello-world");
});

test("slug: strips leading/trailing hyphens", () => {
	assert.equal(slug("---foo---"), "foo");
});

test("slug: truncates to 32 characters", () => {
	const long = "a".repeat(64);
	assert.equal(slug(long).length, 32);
});

test("slug: returns 'task' for empty/whitespace input", () => {
	assert.equal(slug(""), "task");
	assert.equal(slug("   "), "task");
});

test("slug: handles numbers", () => {
	assert.equal(slug("Phase 2"), "phase-2");
});

// ─── extractAdaptivePlanJson ───────────────────────────────────────────────

test("extractAdaptivePlanJson: extracts between START/END markers", () => {
	const text = `Some preamble
ADAPTIVE_PLAN_JSON_START
{"phases":[{"name":"p1","tasks":[{"role":"executor","task":"do it"}]}]}
ADAPTIVE_PLAN_JSON_END
After`;
	const json = extractAdaptivePlanJson(text);
	assert.ok(json);
	assert.ok(JSON.parse(json!));
});

test("extractAdaptivePlanJson: extracts from code fence when no markers", () => {
	const text = 'Here\'s the plan:\n```json\n{"phases":[]}\n```\nDone.';
	const json = extractAdaptivePlanJson(text);
	assert.ok(json);
	assert.ok(JSON.parse(json!), "should parse as JSON");
});

test("extractAdaptivePlanJson: extracts from code fence without json hint", () => {
	const text = '```\n{"phases":[]}\n```';
	const json = extractAdaptivePlanJson(text);
	assert.ok(json);
	assert.ok(JSON.parse(json!), "should parse as JSON");
});

test("extractAdaptivePlanJson: prefers markers over fences", () => {
	const text = `\`\`\`
{"fenced": true}
\`\`\`
ADAPTIVE_PLAN_JSON_START
{"marker": true}
ADAPTIVE_PLAN_JSON_END`;
	const json = extractAdaptivePlanJson(text);
	assert.match(json!, /"marker": true/);
});

test("extractAdaptivePlanJson: returns undefined when no JSON found", () => {
	assert.equal(extractAdaptivePlanJson("just plain text"), undefined);
});

test("extractAdaptivePlanJson: strips code fences inside START/END markers", () => {
	const text = `ADAPTIVE_PLAN_JSON_START
\`\`\`json
{"phases":[]}
\`\`\`
ADAPTIVE_PLAN_JSON_END`;
	const json = extractAdaptivePlanJson(text);
	assert.ok(json, "should extract content");
	assert.doesNotThrow(() => JSON.parse(json!), `should be valid JSON, got: ${json}`);
	const parsed = JSON.parse(json!);
	assert.ok(Array.isArray(parsed.phases));
});

test("extractAdaptivePlanJson: strips code fence without json hint inside markers", () => {
	const text = `ADAPTIVE_PLAN_JSON_START
\`\`\`
{"phases":[{"name":"p1","tasks":[]}]}
\`\`\`
ADAPTIVE_PLAN_JSON_END`;
	const json = extractAdaptivePlanJson(text);
	assert.ok(json);
	const parsed = JSON.parse(json!);
	assert.equal(parsed.phases[0].name, "p1");
});

test("extractAdaptivePlanJson: works without markers when no END present", () => {
	const text = `ADAPTIVE_PLAN_JSON_START
\`\`\`json
{"phases":[]}
\`\`\``;
	const json = extractAdaptivePlanJson(text);
	assert.ok(json, "should extract via fallback path");
	assert.doesNotThrow(() => JSON.parse(json!), `should be valid JSON, got: ${json}`);
});

// ─── parseAdaptivePlan ─────────────────────────────────────────────────────

test("parseAdaptivePlan: parses valid single-phase plan", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [
				{
					name: "build",
					tasks: [{ role: "executor", task: "Implement X" }],
				},
			],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const plan = parseAdaptivePlan(text, ["executor"]);
	assert.ok(plan);
	assert.equal(plan!.phases.length, 1);
	assert.equal(plan!.phases[0]!.tasks.length, 1);
	assert.equal(plan!.phases[0]!.tasks[0]!.role, "executor");
	assert.equal(plan!.phases[0]!.tasks[0]!.task, "Implement X");
});

test("parseAdaptivePlan: parses multi-phase plan", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [
				{
					name: "research",
					tasks: [{ role: "explorer", task: "Investigate" }],
				},
				{
					name: "implement",
					tasks: [
						{ role: "executor", task: "Build" },
						{ role: "reviewer", task: "Review" },
					],
				},
			],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const plan = parseAdaptivePlan(text, ["explorer", "executor", "reviewer"]);
	assert.ok(plan);
	assert.equal(plan!.phases.length, 2);
	assert.equal(plan!.phases[0]!.tasks.length, 1);
	assert.equal(plan!.phases[1]!.tasks.length, 2);
});

test("parseAdaptivePlan: rejects unknown role", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "hacker", task: "do bad" }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	assert.equal(parseAdaptivePlan(text, ["executor"]), undefined);
});

test("parseAdaptivePlan: rejects empty task text", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "executor", task: "  " }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	assert.equal(parseAdaptivePlan(text, ["executor"]), undefined);
});

test("parseAdaptivePlan: accepts tasks-only format (auto-wraps in phase)", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			tasks: [{ role: "executor", task: "Do something" }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const plan = parseAdaptivePlan(text, ["executor"]);
	assert.ok(plan);
	assert.equal(plan!.phases.length, 1);
	assert.equal(plan!.phases[0]!.name, "adaptive");
});

test("parseAdaptivePlan: returns undefined for empty text", () => {
	assert.equal(parseAdaptivePlan("", ["executor"]), undefined);
});

test("parseAdaptivePlan: returns undefined when no JSON markers", () => {
	assert.equal(parseAdaptivePlan("no json here", ["executor"]), undefined);
});

test("parseAdaptivePlan: returns undefined for invalid JSON", () => {
	const text = "ADAPTIVE_PLAN_JSON_START\n{not valid json}\nADAPTIVE_PLAN_JSON_END";
	assert.equal(parseAdaptivePlan(text, ["executor"]), undefined);
});

test("parseAdaptivePlan: caps at MAX_ADAPTIVE_TASKS (12)", () => {
	const tasks = Array.from({ length: 13 }, (_, i) => ({
		role: "executor",
		task: `Task ${i}`,
	}));
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "big", tasks }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	assert.equal(parseAdaptivePlan(text, ["executor"]), undefined);
});

test("parseAdaptivePlan: trims task text", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "executor", task: "  do it  " }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const plan = parseAdaptivePlan(text, ["executor"]);
	assert.ok(plan);
	assert.equal(plan!.phases[0]!.tasks[0]!.task, "do it");
});

test("parseAdaptivePlan: auto-names unnamed phases", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ tasks: [{ role: "executor", task: "Do it" }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const plan = parseAdaptivePlan(text, ["executor"]);
	assert.ok(plan);
	assert.equal(plan!.phases[0]!.name, "phase-1");
});

// ─── repairAdaptivePlan ────────────────────────────────────────────────────

test("repairAdaptivePlan: returns original for valid plan", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "executor", task: "Fix bug" }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const result = repairAdaptivePlan(text, ["executor"]);
	assert.ok(result.plan);
	assert.equal(result.repaired, true);
	assert.equal(result.plan!.phases[0]!.tasks[0]!.role, "executor");
});

test("repairAdaptivePlan: repairs truncated JSON (missing closing brackets)", () => {
	const json = `{"phases":[{"name":"build","tasks":[{"role":"executor","task":"Implement X"}]}`;
	// Missing closing ] and }
	const text = `ADAPTIVE_PLAN_JSON_START\n${json}\nADAPTIVE_PLAN_JSON_END`;
	const result = repairAdaptivePlan(text, ["executor"]);
	assert.ok(result.plan, "should repair truncated JSON");
	assert.equal(result.repaired, true);
});

test("repairAdaptivePlan: uses role aliases (developer → executor)", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "developer", task: "Code it" }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const result = repairAdaptivePlan(text, ["executor"]);
	assert.ok(result.plan);
	assert.equal(result.plan!.phases[0]!.tasks[0]!.role, "executor");
});

test("repairAdaptivePlan: skips tasks with unknown roles", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [
				{ name: "p1", tasks: [{ role: "unknown", task: "Bad" }] },
				{ name: "p2", tasks: [{ role: "executor", task: "Good" }] },
			],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const result = repairAdaptivePlan(text, ["executor"]);
	assert.ok(result.plan);
	assert.equal(result.plan!.phases.length, 1);
	assert.equal(result.plan!.phases[0]!.name, "p2");
});

test("repairAdaptivePlan: returns empty for missing JSON", () => {
	const result = repairAdaptivePlan("no json at all", ["executor"]);
	assert.equal(result.plan, undefined);
	assert.equal(result.repaired, false);
	assert.equal(result.reason, "missing-json");
});

test("repairAdaptivePlan: returns empty for empty plan", () => {
	const text =
		"ADAPTIVE_PLAN_JSON_START\n" +
		JSON.stringify({
			phases: [{ name: "p", tasks: [{ role: "unknown", task: "Bad" }] }],
		}) +
		"\nADAPTIVE_PLAN_JSON_END";
	const result = repairAdaptivePlan(text, ["executor"]);
	assert.equal(result.plan, undefined);
	assert.equal(result.repaired, false);
});

test("__test__ exports: parseAdaptivePlan matches parseAdaptivePlan", () => {
	assert.equal(__test__parseAdaptivePlan, parseAdaptivePlan);
});

test("__test__ exports: repairAdaptivePlan matches repairAdaptivePlan", () => {
	assert.equal(__test__repairAdaptivePlan, repairAdaptivePlan);
});
