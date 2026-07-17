import assert from "node:assert/strict";
import test from "node:test";
import { type DriftReport, detectDrift, formatDriftReport } from "../../src/config/drift-detector.ts";

test("detectDrift returns no drift when everything matches", () => {
	const report = detectDrift(
		{
			agents: ["explorer", "planner"],
			teams: ["implementation"],
			workflows: ["default"],
		},
		{},
	);
	assert.equal(report.hasDrift, false);
	assert.deepEqual(report.items, []);
	assert.deepEqual(report.summary, { missing: 0, extra: 0, mismatched: 0 });
});

test("detectDrift detects missing agent referenced in overrides", () => {
	const report = detectDrift(
		{ agents: ["explorer"], teams: [], workflows: [] },
		{ agents: { overrides: { "nonexistent-agent": { disabled: true } } } },
	);
	assert.equal(report.hasDrift, true);
	assert.equal(report.summary.missing, 1);
	const item = report.items.find((i) => i.name === "nonexistent-agent" && i.status === "missing");
	assert.ok(item);
	assert.equal(item.kind, "agent");
	assert.equal(item.severity, "error");
});

test("detectDrift detects extra config keys not in schema", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {
		unknownKey: true,
		anotherBadKey: 42,
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	assert.equal(report.hasDrift, true);
	const extraKeys = report.items.filter((i) => i.kind === "config-key" && i.status === "extra");
	assert.equal(extraKeys.length, 2);
	assert.ok(extraKeys.some((i) => i.name === "unknownKey"));
	assert.ok(extraKeys.some((i) => i.name === "anotherBadKey"));
	for (const item of extraKeys) {
		assert.equal(item.severity, "warning");
	}
});

test("detectDrift detects unknown nested config keys through depth 3", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {
		runtime: {
			maxTurns: 4,
			unknownRuntimeKey: true,
			yield: {
				enabled: true,
				unknownYieldKey: "unexpected",
			},
		},
		reliability: {
			retryPolicy: {
				maxAttempts: 2,
				unknownRetryKey: 123,
			},
		},
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	const names = report.items.filter((item) => item.kind === "config-key").map((item) => item.name);
	assert.deepEqual(names.sort(), [
		"reliability.retryPolicy.unknownRetryKey",
		"runtime.unknownRuntimeKey",
		"runtime.yield.unknownYieldKey",
	]);
});

test("detectDrift traverses record-valued config and checks keys inside depth-3 objects", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {
		goalWrap: {
			implementation: {
				enabled: true,
				unknownWorkflowKey: true,
				verification: {
					commands: ["npm test"],
					unknownVerificationKey: true,
				},
			},
		},
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	const names = report.items.filter((item) => item.kind === "config-key").map((item) => item.name);
	assert.deepEqual(names.sort(), [
		"goalWrap.implementation.unknownWorkflowKey",
		"goalWrap.implementation.verification.unknownVerificationKey",
	]);
});

test("detectDrift accepts known nested config keys", () => {
	const report = detectDrift(
		{ agents: [], teams: [], workflows: [] },
		{
			runtime: { yield: { enabled: true, maxReminders: 2 } },
			reliability: { retryPolicy: { maxAttempts: 2, backoffMs: 100 } },
			goalWrap: { implementation: { verification: { commands: ["npm test"], mode: "text-only" } } },
		},
	);
	assert.deepEqual(report.items, []);
});

test("detectDrift detects mismatched agent override keys", () => {
	const report = detectDrift({ agents: ["explorer"], teams: [], workflows: [] }, {
		agents: {
			overrides: {
				explorer: {
					unknownProp: "value",
					anotherBadProp: 123,
				} as Record<string, unknown>,
			},
		},
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	assert.equal(report.hasDrift, true);
	const mismatched = report.items.filter((i) => i.status === "mismatched");
	assert.equal(mismatched.length, 1);
	assert.equal(mismatched[0]?.name, "explorer");
	assert.equal(mismatched[0]?.severity, "warning");
	assert.ok(mismatched[0]?.actual?.includes("unknownProp"));
});

test("detectDrift summary counts are correct", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {
		agents: { overrides: { "missing-agent": { model: "gpt-4" } } },
		bogusKey: true,
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	assert.equal(report.summary.missing, 1);
	assert.equal(report.summary.extra, 1);
	assert.equal(report.summary.mismatched, 0);
	assert.equal(report.items.length, 2);
});

test("detectDrift handles empty config gracefully", () => {
	const report = detectDrift(
		{
			agents: ["explorer", "planner"],
			teams: ["default"],
			workflows: ["run"],
		},
		{},
	);
	assert.equal(report.hasDrift, false);
	assert.deepEqual(report.summary, { missing: 0, extra: 0, mismatched: 0 });
});

test("detectDrift handles empty discovered gracefully", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {});
	assert.equal(report.hasDrift, false);
	assert.deepEqual(report.items, []);
});

test("detectDrift missing agent has correct severity error", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, { agents: { overrides: { ghost: { model: "test" } } } });
	const missing = report.items.filter((i) => i.status === "missing");
	assert.equal(missing.length, 1);
	assert.equal(missing[0]?.severity, "error");
});

test("detectDrift config-key extra has severity warning", () => {
	const report = detectDrift({ agents: [], teams: [], workflows: [] }, {
		totallyUnknown: 123,
	} as Record<string, unknown> as Parameters<typeof detectDrift>[1]);
	const extras = report.items.filter((i) => i.kind === "config-key");
	assert.equal(extras.length, 1);
	assert.equal(extras[0]?.severity, "warning");
});

test("detectDrift agent override with valid keys is not mismatched", () => {
	const report = detectDrift(
		{ agents: ["explorer"], teams: [], workflows: [] },
		{
			agents: {
				overrides: {
					explorer: { model: "claude-3", disabled: false },
				},
			},
		},
	);
	const mismatched = report.items.filter((i) => i.status === "mismatched");
	assert.equal(mismatched.length, 0);
});

test("detectDrift multiple missing agents from overrides", () => {
	const report = detectDrift(
		{ agents: [], teams: [], workflows: [] },
		{
			agents: {
				overrides: {
					agent1: { model: "a" },
					agent2: { model: "b" },
					agent3: { model: "c" },
				},
			},
		},
	);
	assert.equal(report.summary.missing, 3);
	const missingNames = report.items.filter((i) => i.status === "missing").map((i) => i.name);
	assert.deepEqual(missingNames.sort(), ["agent1", "agent2", "agent3"]);
});

test("formatDriftReport returns no-drift message when clean", () => {
	const report: DriftReport = {
		hasDrift: false,
		items: [],
		summary: { missing: 0, extra: 0, mismatched: 0 },
	};
	const text = formatDriftReport(report);
	assert.equal(text, "No drift detected.");
});

test("formatDriftReport formats drift items correctly", () => {
	const report: DriftReport = {
		hasDrift: true,
		items: [
			{
				kind: "agent",
				name: "ghost",
				status: "missing",
				expected: "agent file discovered",
				actual: "not found",
				severity: "error",
			},
			{
				kind: "config-key",
				name: "badKey",
				status: "extra",
				expected: "key not in schema",
				actual: "present in config",
				severity: "warning",
			},
		],
		summary: { missing: 1, extra: 1, mismatched: 0 },
	};
	const text = formatDriftReport(report);
	assert.ok(text.includes("1 missing, 1 extra, 0 mismatched"));
	assert.ok(text.includes("ERROR [agent] ghost: missing"));
	assert.ok(text.includes("WARN [config-key] badKey: extra"));
});
