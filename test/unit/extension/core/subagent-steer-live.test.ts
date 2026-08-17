/**
 * WP-1/R1 (H6) — live one-shot steer: `steer_subagent` becomes real.
 *
 * Regression test for the real steer path (previously a registered STUB that
 * emitted "Steering request noted" + "not available yet" and wrote NOTHING).
 *
 * Flow (mock-worker pattern from `resume-cancel.test.ts` + the Agent-tool
 * background recipe from `subagent-tools-integration.test.ts`):
 *   1. Dispatch a one-shot background subagent through the real Agent tool with
 *      the mock child-process runtime (`PI_TEAMS_MOCK_CHILD_PI=json-success`).
 *   2. The runner resolves → the spawn route writes the identity link
 *      (record.taskId/depth) + the ownership-map entry (task ⇄ subagentId ⇄
 *      artifactsDir). Poll until the in-memory record carries taskId.
 *   3. Steer mid-run via `steer_subagent` → must resolve → append
 *      `<artifactsRoot>/steering/<taskId>.jsonl` with the exact `team steer`
 *      JSONL schema `{type:"steer", message, ts}`.
 *   4. Negative: steering a record owned by another session is refused (P2.3
 *      cross-session guard precedent, subagent-tools.ts).
 *
 * Regression discriminators (both FAIL on pre-fix code):
 *   - pre-fix spawn route never sets record.taskId → the poll times out;
 *   - pre-fix steer stub never writes the steering file → the file assertion
 *     fails (and the stub emits "not available yet", which we assert is absent).
 *
 * Teardown: resume-cancel retry-rmSync helper (ENOTEMPTY race on macOS CI) +
 * best-effort run cancel so the manager's poll loop does not linger.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { registerSubagentTools } from "../../../../src/extension/registration/subagent-tools.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { SubagentManager, savePersistedSubagentRecord } from "../../../../src/runtime/subagent-manager.ts";
import { resolveEntryBySubagentId } from "../../../../src/state/stores/ownership-map.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { firstText, textFromToolResult } from "../../../fixtures/tool-result-helpers.ts";

// ── Harness (subagent-cross-session.test.ts pattern) ──────────────────────

/** Minimal fake pi with just enough to register tools. */
function createFakePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		api: {
			events: {
				on: () => () => undefined,
				emit: (_event?: unknown, _data?: unknown) => undefined,
			},
			on: () => () => undefined,
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		},
	};
}

/** Fake tool-execution ctx with a sessionManager returning a fixed id. */
function fakeCtx(cwd: string, sessionId: string | undefined): any {
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: false,
		ui: {
			notify() {
				/* no-op */
			},
			setWidget() {
				/* no-op */
			},
			setStatus() {
				/* no-op */
			},
		},
	};
	if (sessionId !== undefined) {
		ctx.sessionManager = { getSessionId: () => sessionId };
	}
	return ctx;
}

/**
 * macOS-CI teardown hardening (resume-cancel.test.ts pattern): the spawned
 * mock worker's final writes can race the recursive rmdir — rimrafSync throws
 * ENOTEMPTY (not swallowed by force:true) when a file lands between its unlink
 * pass and a directory rmdir. Retry briefly; the worker has exited by then, so
 * the next attempt succeeds. Best-effort: a persistent ENOTEMPTY is NOT a test
 * failure — the assertions already passed, and /tmp is swept by the OS.
 */
function removeDirWithRetry(dir: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") || attempt === 4) {
				console.error(`subagent-steer-live teardown: unable to remove ${dir}: ${String(error)}`);
				return;
			}
			sleepSync(200);
		}
	}
}

/** Best-effort: cancel a run so the manager's poll loop does not linger. */
async function cancelRunBestEffort(cwd: string, runId: string | undefined): Promise<void> {
	if (!runId) return;
	try {
		await handleTeamTool({ action: "cancel", runId, force: true }, { cwd });
	} catch {
		/* best-effort — the test already asserted what it needed */
	}
}

// ── Live one-shot steer ───────────────────────────────────────────────────

test("dispatch one-shot → identity link → steer resolves → steering file appended", async () => {
	// Mock child-process runtime recipe (subagent-tools-integration.test.ts):
	// real Agent tool dispatch, but workers are mocked to "json-success" so the
	// background run completes quickly and the spawn-route identity link lands.
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;

	const cwd = createTrackedTempDir("pi-crew-steer-live-");
	const manager = new SubagentManager();
	let fake: ReturnType<typeof createFakePi> | undefined;
	let runIdToCancel: string | undefined;
	try {
		fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const agentTool = fake.tools.get("Agent");
		const steerTool = fake.tools.get("steer_subagent");
		assert.ok(agentTool, "Agent tool must be registered");
		assert.ok(steerTool, "steer_subagent tool must be registered");

		const ctx = fakeCtx(cwd, "session-A");
		const launched = await agentTool.execute(
			"call-1",
			{
				prompt: "Explore edge cases in the render pipeline",
				description: "Explore edge cases",
				subagent_type: "explorer",
				run_in_background: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const launchText = firstText(launched);
		assert.match(launchText, /Agent ID:/);
		const agentId = launchText.match(/Agent ID: (\S+)/)?.[1];
		assert.ok(agentId, "agent id must be returned by the Agent tool");

		// Wait for the runner to resolve and the identity link to land:
		// record.taskId is only written by the spawn route once the run
		// manifest resolves (mock run completes in a few seconds; under CI/load
		// the detached background process can take longer). Pre-fix, this never
		// happens → the poll times out → test FAILS.
		const deadline = Date.now() + 45_000;
		let record = manager.getRecord(agentId);
		while ((!record?.taskId || !record.runId) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			record = manager.getRecord(agentId);
		}
		assert.ok(record, "record must exist after spawn");
		assert.ok(
			record.runId,
			`runId must be linked (taskId=${record.taskId ?? "unset"}, status=${record?.status}, error=${record?.error ?? "(none)"})`,
		);
		assert.ok(
			record.taskId,
			`taskId must be linked by the one-shot spawn route (status=${record?.status}, error=${record?.error ?? "(none)"})`,
		);
		assert.equal(record.depth, 0, "root one-shot depth must be 0");
		runIdToCancel = record.runId;

		// Ownership map: the one-shot writer recorded task ⇄ subagentId ⇄ artifactsDir.
		const loaded = loadRunManifestById(cwd, record.runId);
		assert.ok(loaded, "run manifest must resolve for the linked runId");
		// (flake P3) The ownership upsert is best-effort with a bounded lock-retry
		// budget and can transiently lose the run-lock race to the run's terminal
		// writes; poll for it like taskId above instead of asserting on first read.
		const ownDeadline = Date.now() + 15_000;
		let ownership = resolveEntryBySubagentId(loaded.manifest, agentId);
		while ((!ownership || ownership.taskId !== record.taskId) && Date.now() < ownDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			ownership = resolveEntryBySubagentId(loaded.manifest, agentId);
		}
		assert.ok(ownership, "ownership-map entry must exist for the subagent");
		assert.equal(ownership?.taskId, record.taskId);
		assert.equal(ownership?.runId, record.runId);
		assert.equal(ownership?.artifactsDir, loaded.manifest.artifactsRoot);

		// Steer mid-run (tool-side): resolve → append artifacts/steering/<taskId>.jsonl.
		const steered = await steerTool.execute("call-2", { agent_id: agentId, message: "Focus on edge cases" }, undefined, undefined, ctx);
		assert.equal(steered.isError, false, "steer on a linked record must not error");
		const steerText = firstText(steered);
		assert.match(steerText, /Steering request noted/);
		assert.doesNotMatch(steerText, /not available yet/, "linked record must not hit the 'not linked' branch");
		assert.match(steerText, new RegExp(record.taskId as string));

		// Delivered at turn boundary (tool-side contract): the child worker
		// polls this file every 500ms; assert the exact `team steer` JSONL schema
		// {type:"steer", message, ts} (handleSteer / appendSteeringAsync format).
		const steeringPath = path.join(loaded.manifest.artifactsRoot, "steering", `${record.taskId}.jsonl`);
		assert.ok(fs.existsSync(steeringPath), `steering file must exist at ${steeringPath}`);
		const lines = fs.readFileSync(steeringPath, "utf-8").trim().split("\n").filter(Boolean);
		assert.equal(lines.length, 1, "exactly one steering line expected");
		const entry = JSON.parse(lines[0]) as { type?: unknown; message?: unknown; ts?: unknown };
		assert.equal(entry.type, "steer");
		assert.equal(entry.message, "Focus on edge cases");
		assert.equal(typeof entry.ts, "string");
	} finally {
		await cancelRunBestEffort(cwd, runIdToCancel);
		void manager.abortAll();
		fake?.api.events.emit("session_shutdown", {});
		// Drain in-flight background-agent I/O before deletion (Windows FS latency).
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		removeDirWithRetry(cwd);
	}
});

test("steer refuses a record owned by another session (P2.3 cross-session guard)", async () => {
	const cwd = createTrackedTempDir("pi-crew-steer-session-");
	const manager = new SubagentManager();
	try {
		// A linked record (taskId present) but owned by session-A: the guard must
		// refuse before any resolve/append happens.
		savePersistedSubagentRecord(cwd, {
			id: "agent_other_session",
			type: "explorer",
			description: "Other session agent",
			prompt: "Do work",
			status: "running",
			startedAt: Date.now(),
			background: true,
			ownerSessionId: "session-A",
			taskId: "01_01-agent",
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");

		const result = await steer.execute(
			"call",
			{ agent_id: "agent_other_session", message: "STOP" },
			undefined,
			undefined,
			fakeCtx(cwd, "session-B"),
		);
		assert.equal(result.isError, true, "cross-session steer must be refused");
		assert.match(firstText(result), /belongs to another session/);
	} finally {
		void manager.abortAll();
		removeDirWithRetry(cwd);
	}
});

test("steer on a missing message returns the requires-prompt error (no throw)", async () => {
	const cwd = createTrackedTempDir("pi-crew-steer-nomsg-");
	const manager = new SubagentManager();
	try {
		savePersistedSubagentRecord(cwd, {
			id: "agent_msgless",
			type: "explorer",
			description: "Message-less agent",
			prompt: "Do work",
			status: "running",
			startedAt: Date.now(),
			background: true,
			ownerSessionId: "session-A",
			taskId: "01_01-agent",
		});
		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");

		const result = await steer.execute(
			"call",
			{ agent_id: "agent_msgless", message: "   " },
			undefined,
			undefined,
			fakeCtx(cwd, "session-A"),
		);
		assert.equal(result.isError, true);
		assert.ok(textFromToolResult(result).length > 0, "must return a prompt-required message");
	} finally {
		void manager.abortAll();
		removeDirWithRetry(cwd);
	}
});
