import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
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
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-phase5-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "phase5 observability" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;

		// On slow CI (Windows), the completed run's event log may take a moment to
		// become fully visible to a concurrent read. Poll until BOTH the manifest
		// reports status='completed' AND the cursor reflects the expected stream
		// (run-started at seq 1, then ≥2 more events → nextSeq ≥ 3).
		//
		// History:
		//   ce0c2e4 (2026-06-22) added 10s timeout. Insufficient on the slowest
		//     windows-latest GH Actions runners (~10x slower than Linux; observed
		//     test duration 13.27s vs typical 1.5s on POSIX).
		//   <this commit> bumps timeout to 30s AND gates on manifest.status so we
		//     exit as soon as the run has truly completed, not on a wall-clock tick.
		//     On fast runners the manifest gate fires after 1–2 polls.
		const manifestPath = path.join(cwd, ".crew", "state", "runs", runId, "manifest.json");
		let eventPayload: { events: unknown[]; nextSeq: number } = { events: [], nextSeq: 0 };
		const pollDeadline = Date.now() + 30_000;
		let cursorReady = false;
		let manifestCompleted = false;
		for (;;) {
			manifestCompleted = false;
			try {
				const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
				if (manifest.status === "completed") manifestCompleted = true;
			} catch {
				// manifest not yet written — keep polling.
			}

			const events = await handleTeamTool(
				{
					action: "api",
					runId,
					config: { operation: "read-events", sinceSeq: 1, limit: 2 },
				},
				{ cwd },
			);
			eventPayload = JSON.parse(firstText(events));
			if (eventPayload.events.length === 2 && eventPayload.nextSeq >= 3) {
				cursorReady = true;
				break;
			}
			// Once manifest is completed, give a short grace window (1s) for the
			// terminal event to flush, then assert.
			if (manifestCompleted && eventPayload.events.length >= 1 && Date.now() > pollDeadline - 29_000) break;
			if (Date.now() > pollDeadline) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(
			cursorReady,
			`events cursor never reached nextSeq >= 3 within 30s ` +
				`(manifest.status=${manifestCompleted ? "completed" : "pending"}, ` +
				`last length=${eventPayload.events.length}, nextSeq=${eventPayload.nextSeq})`,
		);
		assert.equal(eventPayload.events.length, 2);
		assert.ok(eventPayload.nextSeq >= 3);

		const agentsResult = await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd });
		const agents = JSON.parse(firstText(agentsResult));
		const first = agents[0];

		const agentCursor = readCrewAgentEventsCursor(
			JSON.parse(fs.readFileSync(path.join(cwd, ".crew", "state", "runs", runId, "manifest.json"), "utf-8")),
			first.taskId,
			{ sinceSeq: 0, limit: 1 },
		);
		assert.equal(agentCursor.events.length, 1);

		const agentEvents = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "read-agent-events",
					agentId: first.taskId,
					sinceSeq: 0,
					limit: 1,
				},
			},
			{ cwd },
		);
		const agentEventPayload = JSON.parse(firstText(agentEvents));
		assert.equal(agentEventPayload.events.length, 1);
		assert.ok(agentEventPayload.nextSeq >= 1);

		const output = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "read-agent-output",
					agentId: first.taskId,
					maxBytes: 10_000,
				},
			},
			{ cwd },
		);
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
