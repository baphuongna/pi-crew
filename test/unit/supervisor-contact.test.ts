import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisorContactFromLine } from "../../src/runtime/supervisor-contact.ts";

describe("parseSupervisorContactFromLine", () => {
	it("parses valid supervisor_contact JSON", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "task-1",
			reason: "decision_needed",
			message: "Should I proceed with option A or B?",
		}));
		assert.ok(result);
		assert.equal(result.taskId, "task-1");
		assert.equal(result.reason, "decision_needed");
		assert.equal(result.message, "Should I proceed with option A or B?");
	});

	it("parses crew_supervisor_contact variant", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "crew_supervisor_contact",
			taskId: "task-2",
			reason: "clarification",
			message: "Need more context",
		}));
		assert.ok(result);
		assert.equal(result.taskId, "task-2");
	});

	it("returns undefined for non-JSON lines", () => {
		assert.equal(parseSupervisorContactFromLine("regular stdout output"), undefined);
	});

	it("returns undefined for JSON without supervisor type", () => {
		assert.equal(parseSupervisorContactFromLine(JSON.stringify({ type: "tool_call" })), undefined);
	});

	it("defaults reason to custom for unknown reasons", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "task-3",
			reason: "unknown_reason",
			message: "test",
		}));
		assert.ok(result);
		assert.equal(result.reason, "custom");
	});

	it("handles missing fields gracefully", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
		}));
		assert.ok(result);
		assert.equal(result.taskId, "");
		assert.equal(result.reason, "custom");
		assert.equal(result.message, "");
	});

	it("returns undefined for empty lines", () => {
		assert.equal(parseSupervisorContactFromLine(""), undefined);
		assert.equal(parseSupervisorContactFromLine("  "), undefined);
	});
});
