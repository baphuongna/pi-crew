import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSupervisorContactFromLine, recordSupervisorContact } from "../../src/runtime/supervisor-contact.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("parseSupervisorContactFromLine edge cases", () => {
	it("handles data field as object", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "t-1",
			reason: "decision_needed",
			message: "test",
			data: { context: "some info" },
		}));
		assert.ok(result);
		assert.equal(result.data?.context, "some info");
	});

	it("ignores data field as array", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "t-1",
			reason: "custom",
			message: "test",
			data: [1, 2, 3],
		}));
		assert.ok(result);
		assert.equal(result.data, undefined);
	});

	it("handles valid reason: approval", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "t-1",
			reason: "approval",
			message: "Need approval to proceed",
		}));
		assert.ok(result);
		assert.equal(result.reason, "approval");
	});

	it("handles valid reason: error_escalation", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "t-1",
			reason: "error_escalation",
			message: "Fatal error occurred",
		}));
		assert.ok(result);
		assert.equal(result.reason, "error_escalation");
	});

	it("handles non-string taskId (number)", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: 12345,
			reason: "custom",
			message: "test",
		}));
		assert.ok(result);
		assert.equal(result.taskId, "");
	});

	it("handles non-string message (number)", () => {
		const result = parseSupervisorContactFromLine(JSON.stringify({
			type: "supervisor_contact",
			taskId: "t-1",
			reason: "custom",
			message: 42,
		}));
		assert.ok(result);
		assert.equal(result.message, "42");
	});

	it("returns undefined for JSON array", () => {
		assert.equal(parseSupervisorContactFromLine("[1,2,3]"), undefined);
	});
});

describe("recordSupervisorContact", () => {
	it("writes contact event to event log", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sc-"));
		const eventsPath = path.join(tmpDir, "events.jsonl");
		fs.writeFileSync(eventsPath, "", "utf-8");

		recordSupervisorContact(
			{ eventsPath } as any,
			{
				runId: "run-1",
				taskId: "task-1",
				reason: "decision_needed",
				message: "Should I proceed?",
			},
		);

		const content = fs.readFileSync(eventsPath, "utf-8").trim();
		assert.ok(content.length > 0);
		const event = JSON.parse(content);
		assert.equal(event.type, "supervisor.contact");
		assert.equal(event.taskId, "task-1");
		assert.equal(event.data.reason, "decision_needed");
		fs.rmSync(tmpDir, { recursive: true });
	});

	it("handles missing eventsPath gracefully", () => {
		// Should not throw
		recordSupervisorContact(
			{ eventsPath: "/nonexistent/path/events.jsonl" } as any,
			{
				runId: "run-1",
				taskId: "task-1",
				reason: "custom",
				message: "test",
			},
		);
	});
});
