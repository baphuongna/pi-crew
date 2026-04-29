import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { readCrewAgentEventsCursor } from "../../src/runtime/crew-agent-records.ts";
import { appendEvent, readEventsCursor } from "../../src/state/event-log.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("run event cursor returns only events after sinceSeq", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-cursor-"));
	try {
		const eventsPath = path.join(dir, "events.jsonl");
		appendEvent(eventsPath, { type: "one", runId: "run" });
		appendEvent(eventsPath, { type: "two", runId: "run" });
		appendEvent(eventsPath, { type: "three", runId: "run" });
		const cursor = readEventsCursor(eventsPath, { sinceSeq: 1, limit: 1 });
		assert.equal(cursor.events.length, 1);
		assert.equal(cursor.events[0]!.type, "two");
		assert.equal(cursor.nextSeq, 2);
		assert.equal(cursor.total, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("observability API supports event cursors, agent output tail, and dashboard summary", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-phase5-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "phase5 observability" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;

		const events = await handleTeamTool({ action: "api", runId, config: { operation: "read-events", sinceSeq: 1, limit: 2 } }, { cwd });
		const eventPayload = JSON.parse(firstText(events));
		assert.equal(eventPayload.events.length, 2);
		assert.ok(eventPayload.nextSeq >= 3);

		const agentsResult = await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd });
		const agents = JSON.parse(firstText(agentsResult));
		const first = agents[0];

		const agentCursor = readCrewAgentEventsCursor(JSON.parse(fs.readFileSync(path.join(cwd, ".crew", "state", "runs", runId, "manifest.json"), "utf-8")), first.taskId, { sinceSeq: 0, limit: 1 });
		assert.equal(agentCursor.events.length, 1);

		const agentEvents = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-events", agentId: first.taskId, sinceSeq: 0, limit: 1 } }, { cwd });
		const agentEventPayload = JSON.parse(firstText(agentEvents));
		assert.equal(agentEventPayload.events.length, 1);
		assert.ok(agentEventPayload.nextSeq >= 1);

		const output = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-output", agentId: first.taskId, maxBytes: 10_000 } }, { cwd });
		const outputPayload = JSON.parse(firstText(output));
		assert.equal(outputPayload.truncated, false);
		assert.match(outputPayload.text, /success|mock/i);

		const dashboard = await handleTeamTool({ action: "api", runId, config: { operation: "agent-dashboard" } }, { cwd });
		assert.match(firstText(dashboard), /Crew agents/);
		assert.match(firstText(dashboard), /Recent/);
	} finally {
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

