/**
 * Complementary tests for src/runtime/yield-handler.ts
 * Focuses on validateYieldData, extractYieldDataFromArgs, and edge cases
 * not covered by the primary yield-handler.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildYieldReminder,
	DEFAULT_YIELD_CONFIG,
	extractYieldDataFromArgs,
	extractYieldResult,
	isYieldEvent,
	validateYieldData,
	YIELD_TOOL_NAME,
} from "../../src/runtime/yield-handler.ts";

// ─── validateYieldData ───────────────────────────────────────────────────

describe("validateYieldData returns valid for null schema", () => {
	it("accepts any data when schema is null/undefined", async () => {
		const result = await validateYieldData({ foo: "bar" }, null);
		assert.equal(result.valid, true);
	});
});

describe("validateYieldData returns valid for undefined schema", () => {
	it("accepts any data when schema is undefined", async () => {
		const result = await validateYieldData({ foo: "bar" }, undefined);
		assert.equal(result.valid, true);
	});
});

describe("validateYieldData rejects null/undefined data", () => {
	it("returns invalid for null data", async () => {
		const result = await validateYieldData(null, { type: "object" });
		assert.equal(result.valid, false);
		assert.ok(result.error);
	});
});

describe("validateYieldData rejects undefined data", () => {
	it("returns invalid for undefined data", async () => {
		const result = await validateYieldData(undefined, { type: "object" });
		assert.equal(result.valid, false);
		assert.ok(result.error);
	});
});

describe("validateYieldData validates object type", () => {
	it("accepts a plain object when type is object", async () => {
		const result = await validateYieldData({ key: "value" }, { type: "object" });
		assert.equal(result.valid, true);
	});
});

describe("validateYieldData rejects array when type is object", () => {
	it("returns invalid for array when type is object", async () => {
		const result = await validateYieldData([1, 2, 3], { type: "object" });
		assert.equal(result.valid, false);
		assert.ok(result.error);
	});
});

describe("validateYieldData validates string type", () => {
	it("accepts string when type is string", async () => {
		const result = await validateYieldData("hello", { type: "string" });
		assert.equal(result.valid, true);
	});
});

describe("validateYieldData rejects number when type is string", () => {
	it("returns invalid for number when type is string", async () => {
		const result = await validateYieldData(42, { type: "string" });
		assert.equal(result.valid, false);
		assert.ok(result.error);
	});
});

describe("validateYieldData validates required fields", () => {
	it("accepts data with all required fields", async () => {
		const result = await validateYieldData({ name: "test", value: 42 }, { type: "object", required: ["name", "value"] });
		assert.equal(result.valid, true);
	});
});

describe("validateYieldData rejects missing required fields", () => {
	it("returns invalid when required field is missing", async () => {
		const result = await validateYieldData({ name: "test" }, { type: "object", required: ["name", "missing"] });
		assert.equal(result.valid, false);
		assert.ok(result.error?.includes("missing"));
	});
});

// ─── extractYieldDataFromArgs ─────────────────────────────────────────────

describe("extractYieldDataFromArgs returns undefined for non-object args", () => {
	it("returns undefined for null args", () => {
		assert.equal(extractYieldDataFromArgs(null, "call-1"), undefined);
	});
});

describe("extractYieldDataFromArgs returns undefined for empty summary", () => {
	it("returns undefined when summary is empty string", () => {
		assert.equal(extractYieldDataFromArgs({ summary: "" }, "call-1"), undefined);
	});
});

describe("extractYieldDataFromArgs returns undefined when summary is missing", () => {
	it("returns undefined when no summary field", () => {
		assert.equal(extractYieldDataFromArgs({ foo: "bar" }, "call-1"), undefined);
	});
});

describe("extractYieldDataFromArgs extracts structured result correctly", () => {
	it("returns result with summary and toolCallId", () => {
		const result = extractYieldDataFromArgs(
			{
				summary: "Task done",
				artifacts: { "a.txt": "/path/a" },
				structuredData: { count: 5 },
			},
			"call-123",
		);
		assert.ok(result);
		assert.equal(result!.summary, "Task done");
		assert.equal(result!.toolCallId, "call-123");
		assert.deepEqual(result!.artifacts, { "a.txt": "/path/a" });
		assert.deepEqual(result!.structuredData, { count: 5 });
	});
});

describe("extractYieldDataFromArgs rejects non-string artifacts", () => {
	it("skips artifacts when values are not all strings", () => {
		const result = extractYieldDataFromArgs({ summary: "Done", artifacts: { "a.txt": 123 } }, "call-1");
		assert.ok(result);
		assert.equal(result!.artifacts, undefined, "non-string artifact values should be rejected");
	});
});

describe("extractYieldDataFromArgs rejects non-object structuredData", () => {
	it("skips structuredData when it is not a plain object", () => {
		const result = extractYieldDataFromArgs({ summary: "Done", structuredData: "not-an-object" }, "call-1");
		assert.ok(result);
		assert.equal(result!.structuredData, undefined);
	});
});

// ─── isYieldEvent edge cases ─────────────────────────────────────────────

describe("isYieldEvent handles various tool name fields", () => {
	it("checks toolName, name, and tool fields", () => {
		assert.equal(
			isYieldEvent({
				type: "tool_execution_start",
				toolName: YIELD_TOOL_NAME,
			}),
			true,
		);
		assert.equal(isYieldEvent({ type: "toolCall", name: YIELD_TOOL_NAME }), true);
		assert.equal(isYieldEvent({ type: "tool_call", tool: YIELD_TOOL_NAME }), true);
		assert.equal(isYieldEvent({ type: "tool_execution_start", toolName: "other" }), false);
	});
});

// ─── extractYieldResult with missing toolCallId ───────────────────────────

describe("extractYieldResult uses empty string for missing toolCallId", () => {
	it("extracts result with empty toolCallId when field is missing", () => {
		const event = {
			type: "tool_execution_start",
			toolName: YIELD_TOOL_NAME,
			args: { summary: "Done" },
		};
		const result = extractYieldResult(event);
		assert.ok(result);
		assert.equal(result!.toolCallId, "");
	});
});

// ─── buildYieldReminder custom prompt ─────────────────────────────────────

describe("buildYieldReminder uses custom prompt", () => {
	it("includes custom reminder text when provided", () => {
		const reminder = buildYieldReminder(2, 5, "Custom prompt here");
		assert.ok(reminder.includes("2/5"));
		assert.ok(reminder.includes("Custom prompt here"));
	});
});

// ─── DEFAULT_YIELD_CONFIG ─────────────────────────────────────────────────

describe("DEFAULT_YIELD_CONFIG has expected defaults", () => {
	it("enabled is true, maxReminders is 3, reminderPrompt is set", () => {
		assert.equal(DEFAULT_YIELD_CONFIG.enabled, true);
		assert.equal(DEFAULT_YIELD_CONFIG.maxReminders, 3);
		assert.ok(DEFAULT_YIELD_CONFIG.reminderPrompt.length > 0);
	});
});
