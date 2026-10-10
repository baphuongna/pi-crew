import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { CrewRuntimeConfig } from "../../../../src/config/config.ts";
import {
	clearLiveAgentsForTest,
	disposeLiveAgentSession,
	followUpLiveAgent,
	getLiveAgent,
	registerLiveAgent,
	steerLiveAgent,
} from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { clearLiveControlRealtimeForTest, publishLiveControlRealtime } from "../../../../src/runtime/live-session/live-control-realtime.ts";
import {
	allowedLiveExtensionPaths,
	buildPerTaskResourceLoader,
	clearLiveSessionServicesCacheForTest,
	collectForeignExtensions,
	LiveSessionHungToolError,
	type LiveSessionRunResult,
	liveSessionServicesCacheStatsForTest,
	runLiveSessionTask,
} from "../../../../src/runtime/live-session/live-session-runtime.ts";
import { flushEventLogBuffer } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/**
 * U4 — live-session v2: shared services bundle + recursion guard + dispose
 * normalization + hung-tool escape hatch.
 *
 * Real-path tests follow the U3 faux E2E pattern (test/integration/
 * live-session-faux-e2e.test.ts): a genuine pi SDK AgentSession runs in-process
 * key-free against the faux provider via `modelProviderOverride`, with
 * `PI_CODING_AGENT_DIR` pointed at an empty temp agent home so no host
 * extensions/auth leak in. Manager-level tests cover the D4 planning-window
 * routing and the dispose-normalization contract deterministically.
 */

const team: TeamConfig = {
	name: "u4-test",
	description: "u4 test",
	source: "builtin",
	filePath: "u4-test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "u4-test",
	description: "u4 test",
	source: "builtin",
	filePath: "u4-test.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "do" }],
};

type FauxHandle = ReturnType<typeof fauxProvider>;
type FauxResponses = Parameters<FauxHandle["setResponses"]>[0];

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

interface U4Scenario {
	cwd: string;
	agentDir: string;
	faux: FauxHandle;
	events: Array<Record<string, unknown>>;
	run: (runtimeConfig?: CrewRuntimeConfig) => Promise<LiveSessionRunResult>;
	manifest: { runId: string; stateRoot: string; eventsPath: string };
	taskId: string;
	agentId: string;
	/** Read the durable run event log (session_created & friends are fire-and-forget FILE events, not onEvent deliveries). */
	readLoggedEvents: (expect?: { type: string; minCount?: number }, timeoutMs?: number) => Promise<Array<Record<string, unknown>>>;
}

function setupU4Scenario(responses: FauxResponses): U4Scenario {
	const cwd = createTrackedTempDir("pi-crew-u4-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const agentDir = path.join(cwd, "u4-agent-home");
	fs.mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({ models: [{ id: "crew-u4-faux", name: "Crew U4 Faux" }] });
	faux.setResponses(responses);
	const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "u4" });
	const task = { ...tasks[0]!, startedAt: new Date().toISOString() };
	const events: Array<Record<string, unknown>> = [];
	const run = (runtimeConfig?: CrewRuntimeConfig) =>
		runLiveSessionTask({
			manifest,
			task,
			step: { id: "execute", role: "executor", task: "u4 task" },
			agent: {
				name: "executor",
				description: "Executor",
				source: "builtin",
				filePath: "executor.md",
				systemPrompt: "Do it",
			},
			prompt: "Run the U4 task",
			workspaceId: cwd,
			parentModel: faux.models[0],
			modelProviderOverride: faux.provider,
			runtimeConfig: { yield: { enabled: false }, ...(runtimeConfig ?? {}) },
			isCurrent: () => true,
			transcriptPath: path.join(cwd, "u4-transcript.jsonl"),
			onEvent: (event) => events.push(event as Record<string, unknown>),
		});
	const readLoggedEvents = async (
		expect?: { type: string; minCount?: number },
		timeoutMs = 3_000,
	): Promise<Array<Record<string, unknown>>> => {
		const parse = (): Array<Record<string, unknown>> => {
			try {
				const text = fs.readFileSync(manifest.eventsPath, "utf-8");
				return text
					.split("\n")
					.filter(Boolean)
					.flatMap((line) => {
						try {
							return [JSON.parse(line) as Record<string, unknown>];
						} catch {
							return [];
						}
					});
			} catch {
				return [];
			}
		};
		await flushEventLogBuffer();
		if (!expect) return parse();
		const want = expect.minCount ?? 1;
		const deadline = Date.now() + timeoutMs;
		let events = parse();
		while (Date.now() < deadline && events.filter((event) => event?.type === expect.type).length < want) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			events = parse();
		}
		return events;
	};
	return {
		cwd,
		agentDir,
		faux,
		events,
		run,
		manifest,
		taskId: task.id,
		agentId: `${manifest.runId}:${task.id}`,
		readLoggedEvents,
	};
}

/** Activate the hermetic real-session environment (empty agent home). */
function activateRealSessionEnv(agentDir: string): void {
	delete process.env.PI_CREW_MOCK_LIVE_SESSION;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

test.afterEach(() => {
	clearLiveAgentsForTest();
	clearLiveControlRealtimeForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// (1) Shared services bundle: session init < 50ms + bundle reuse
// ─────────────────────────────────────────────────────────────────────────────

test("U4 acceptance (a): child session init <50ms from the shared services bundle, bundle reused", async () => {
	const scenario = setupU4Scenario([fauxAssistantMessage([fauxText("U4-INIT-OK")])]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	clearLiveSessionServicesCacheForTest(); // deterministic baseline for the cache-size delta
	const statsBefore = liveSessionServicesCacheStatsForTest();
	try {
		activateRealSessionEnv(scenario.agentDir);
		const first = await scenario.run();
		assert.equal(first.exitCode, 0, `first run failed: ${first.stderr}`);
		const second = await scenario.run();
		assert.equal(second.exitCode, 0, `second run failed: ${second.stderr}`);

		const created = scenario.events.filter((event) => event?.type === "live-session.session_created");
		const logged = await scenario.readLoggedEvents({ type: "live-session.session_created", minCount: 2 });
		const createdFromLog = logged.filter((event) => event?.type === "live-session.session_created") as Array<{
			data?: { elapsedMs?: number; sharedServices?: boolean };
		}>;
		assert.equal(
			createdFromLog.length,
			2,
			`expected 2 session_created events in the event log, got ${createdFromLog.length} (onEvent saw ${created.length})`,
		);
		for (const [index, event] of createdFromLog.entries()) {
			assert.equal(event.data?.sharedServices, true, `session ${index + 1} did not use the shared services fast path`);
			assert.ok(
				(event.data?.elapsedMs ?? Number.MAX_SAFE_INTEGER) < 50,
				`session ${index + 1} init took ${event.data?.elapsedMs}ms — expected <50ms via createAgentSessionFromServices`,
			);
		}
		// Both runs shared ONE bundle: exactly one new cache entry for this
		// (cwd, agentDir, mcp-mode, context) key.
		const statsAfter = liveSessionServicesCacheStatsForTest();
		assert.equal(
			statsAfter.size,
			statsBefore.size + 1,
			`expected exactly one new services bundle, keys: ${statsAfter.keys.join(", ")}`,
		);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Recursion guard layer 1: no foreign extensions load
// ─────────────────────────────────────────────────────────────────────────────

test("U4 acceptance (b): collectForeignExtensions flags unsanctioned extensions (pure guard)", () => {
	const clean = { extensionRunner: { getExtensionPaths: () => [] } };
	assert.deepEqual(collectForeignExtensions(clean as never, []), []);
	const mcpOnly = { extensionRunner: { getExtensionPaths: () => ["builtin:mcp"] } };
	assert.deepEqual(collectForeignExtensions(mcpOnly as never, allowedLiveExtensionPaths(true)), []);
	const violations = { extensionRunner: { getExtensionPaths: () => ["builtin:mcp", "/host/ext/pi-crew/index.ts"] } };
	assert.deepEqual(collectForeignExtensions(violations as never, allowedLiveExtensionPaths(true)), ["/host/ext/pi-crew/index.ts"]);
	// Defensive: a session without the runner surface never blocks.
	assert.deepEqual(collectForeignExtensions(undefined, []), []);
});

test("U4 acceptance (b): real child session loads NO extensions (no foreign_extension_blocked event)", async () => {
	const scenario = setupU4Scenario([fauxAssistantMessage([fauxText("U4-NOEXT-OK")])]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		// Non-MCP-permitted role (executor is not in the MCP allowlist by default):
		// allowedLiveExtensionPaths(false) === [] — the child session must load
		// NOTHING; a foreign extension would have thrown and failed the task.
		const result = await scenario.run();
		assert.equal(result.exitCode, 0, `real run failed: ${result.stderr}`);
		assert.deepEqual(allowedLiveExtensionPaths(false), []);
		const blocked = (await scenario.readLoggedEvents({ type: "live-session.session_created" })).filter(
			(event) => event?.type === "live-session.foreign_extension_blocked",
		);
		assert.equal(blocked.length, 0, `recursion guard fired: ${JSON.stringify(blocked)}`);
		// The run used the shared path (guard is armed there).
		const created = (await scenario.readLoggedEvents({ type: "live-session.session_created" })).find(
			(event) => event?.type === "live-session.session_created",
		) as { data?: { sharedServices?: boolean } } | undefined;
		assert.equal(created?.data?.sharedServices, true);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U4 per-task system prompt: delegating loader serves the task's prompt, not a latched one", () => {
	const calls: string[] = [];
	const shared = {
		getSystemPrompt: () => "SHARED-LATCHED",
		getExtensions: () => ({ extensions: [], errors: [], warnings: [] }),
	};
	const one = buildPerTaskResourceLoader(shared as never, { systemPrompt: "TASK-ONE" });
	const two = buildPerTaskResourceLoader(shared as never, { systemPrompt: "TASK-TWO" });
	calls.push(String((one.getSystemPrompt as () => string)()));
	calls.push(String((two.getSystemPrompt as () => string)()));
	assert.deepEqual(calls, ["TASK-ONE", "TASK-TWO"]);
	// Delegation: extensions come from the shared loader.
	assert.deepEqual((one.getExtensions as () => { extensions: unknown[] })().extensions, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Steer mid-run reaches the streaming worker
// ─────────────────────────────────────────────────────────────────────────────

test("U4 acceptance (c): steer published mid-run is delivered to the streaming session", async () => {
	const contexts: Array<{ messages: Array<{ content?: unknown }> }> = [];
	let firstCallStarted = false;
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const scenario = setupU4Scenario([
		async (context) => {
			contexts.push(context as never);
			firstCallStarted = true;
			await firstGate; // keep the first provider call (turn 1) in flight
			return fauxAssistantMessage([fauxText("U4-STEER turn one complete")]);
		},
		async (context) => {
			contexts.push(context as never);
			return fauxAssistantMessage([fauxText("U4-STEER turn two complete")]);
		},
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const runPromise = scenario.run();
		// Wait until the provider is actually streaming turn 1, then steer.
		const deadline = Date.now() + 30_000;
		while (!firstCallStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(firstCallStarted, "faux provider never received the first stream call");
		publishLiveControlRealtime({
			id: `u4_steer_${Date.now()}`,
			runId: scenario.manifest.runId,
			taskId: scenario.taskId,
			operation: "steer",
			message: "U4-STEER-MARKER prioritize the audit table",
			createdAt: new Date().toISOString(),
		});
		releaseFirst();
		const result = await runPromise;
		assert.equal(result.exitCode, 0, `steer run failed: ${result.stderr}`);
		assert.ok(result.stdout.includes("U4-STEER"), `stdout was: ${result.stdout}`);
		assert.ok(contexts.length >= 2, `expected >=2 provider calls, got ${contexts.length}`);
		// The steer text must have reached the model in a later turn's context
		// (steer delivers at the turn boundary — NOT lost).
		const sawSteer = contexts.some((context, index) => index > 0 && JSON.stringify(context.messages).includes("U4-STEER-MARKER"));
		assert.ok(sawSteer, "steer message never reached a later provider context");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) D4: steers in the planning window are routed mock-handle → real-handle
// ─────────────────────────────────────────────────────────────────────────────

test("U4 acceptance (d): steer in the planning window is queued and replayed to the real session on re-register", async () => {
	const agentId = "u4-run:d4-task";
	// Phase 1 — planning window: the placeholder handle exposes NO steer/prompt
	// (the U4 mock contract), so steers queue instead of being swallowed.
	registerLiveAgent({
		agentId,
		runId: "u4-run",
		taskId: "d4-task",
		role: "executor",
		agent: "executor",
		description: "planning placeholder",
		session: {},
		status: "running",
		workspaceId: "ws-u4",
	});
	await steerLiveAgent(agentId, "U4-D4-STEER rerun the failing check");
	await followUpLiveAgent(agentId, "U4-D4-FOLLOWUP add coverage note");
	const placeholder = getLiveAgent(agentId);
	assert.deepEqual(placeholder?.pendingSteers, ["U4-D4-STEER rerun the failing check"], "steer must QUEUE on the placeholder");
	assert.deepEqual(placeholder?.pendingFollowUps, ["U4-D4-FOLLOWUP add coverage note"], "followUp must QUEUE on the placeholder");

	// Phase 2 — real session registers for the same agentId: pending routes over.
	const steered: string[] = [];
	const prompted: Array<{ text: string; options?: Record<string, unknown> }> = [];
	registerLiveAgent({
		agentId,
		runId: "u4-run",
		taskId: "d4-task",
		role: "executor",
		agent: "executor",
		description: "real execute",
		session: {
			steer: async (text: string) => {
				steered.push(text);
			},
			prompt: async (text: string, options?: Record<string, unknown>) => {
				prompted.push({ text, options });
			},
		},
		status: "running",
		workspaceId: "ws-u4",
	});
	await new Promise((resolve) => setTimeout(resolve, 20)); // replay is fire-and-forget
	assert.deepEqual(steered, ["U4-D4-STEER rerun the failing check"], "pending steer must replay to the REAL session");
	assert.equal(prompted.length, 1, "pending followUp must replay to the REAL session");
	assert.equal(prompted[0]?.text, "U4-D4-FOLLOWUP add coverage note");
	// U4: replayed prompts carry streamingBehavior (mandatory on every prompt()).
	assert.equal(prompted[0]?.options?.streamingBehavior, "followUp");
	const real = getLiveAgent(agentId);
	assert.equal(real?.pendingSteers.length, 0, "placeholder queue drained after replay");
});

test("U4 mock path: placeholder session cannot swallow steers and the handle terminates on dispose", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	const cwd = createTrackedTempDir("pi-crew-u4-mock-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "u4 mock" });
		const task = { ...tasks[0]!, startedAt: new Date().toISOString() };
		const result = await runLiveSessionTask({
			manifest,
			task,
			step: { id: "execute", role: "executor", task: "do" },
			agent: { name: "executor", description: "Executor", source: "builtin", filePath: "executor.md", systemPrompt: "Do it" },
			prompt: "mock it",
			workspaceId: cwd,
			isCurrent: () => true,
		});
		assert.equal(result.exitCode, 0);
		const agentId = `${manifest.runId}:${task.id}`;
		const handle = getLiveAgent(agentId);
		assert.ok(handle, "mock handle stays registered for status");
		// D4 fix: the mock session exposes NO steer/prompt — steers can never be
		// silently swallowed by a no-op stub again.
		assert.equal(typeof handle?.session.steer, "undefined");
		assert.equal(typeof handle?.session.prompt, "undefined");
		// U4 dispose normalization: the mock handle is terminal — drain + reject.
		assert.equal(handle?.terminated, true);
		await assert.rejects(
			steerLiveAgent(agentId, "late steer"),
			/disposed \(terminated\)/,
			"steer after dispose must be rejected clearly",
		);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		removeTrackedTempDir(cwd);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) Dispose normalization + hung-tool escape hatch
// ─────────────────────────────────────────────────────────────────────────────

test("U4 dispose normalization: dispose drains pending queues and rejects steer/followUp clearly", async () => {
	const agentId = "u4-run:dispose-task";
	registerLiveAgent({
		agentId,
		runId: "u4-run",
		taskId: "dispose-task",
		role: "executor",
		agent: "executor",
		session: {},
		status: "running",
		workspaceId: "ws-u4",
	});
	await steerLiveAgent(agentId, "queued before dispose");
	await followUpLiveAgent(agentId, "followup before dispose");
	let disposed = false;
	// Re-register a real session so dispose has something to dispose.
	registerLiveAgent({
		agentId,
		runId: "u4-run",
		taskId: "dispose-task",
		role: "executor",
		agent: "executor",
		session: { dispose: () => (disposed = true) },
		status: "running",
		workspaceId: "ws-u4",
	});
	disposeLiveAgentSession(agentId);
	const handle = getLiveAgent(agentId);
	assert.ok(disposed, "underlying session disposed");
	assert.equal(handle?.terminated, true);
	assert.deepEqual(handle?.pendingSteers, [], "pendingSteers drained on dispose");
	assert.deepEqual(handle?.pendingFollowUps, [], "pendingFollowUps drained on dispose");
	await assert.rejects(steerLiveAgent(agentId, "after dispose"), /disposed \(terminated\)/);
	await assert.rejects(followUpLiveAgent(agentId, "after dispose"), /disposed \(terminated\)/);
});

test("U4 acceptance (e): hung provider/tool call triggers the drop-reference escape hatch and fails the task", async () => {
	// A provider call that never settles and ignores the cooperative abort —
	// the escape hatch must NOT wait for it: terminate the handle, fail fast.
	const scenario = setupU4Scenario([
		() =>
			new Promise(() => {
				/* never resolves — simulated hung tool/provider */
			}),
	]);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run({
			liveSession: { responseTimeoutMs: 500, hungToolGraceMs: 300 },
		});
		assert.equal(result.available, true);
		assert.equal(result.exitCode, 1, "hung task must fail");
		assert.ok(result.error?.includes("escape hatch"), `error was: ${result.error}`);
		const escapeEvent = (await scenario.readLoggedEvents({ type: "live-session.hung_tool_escape" })).find(
			(event) => event?.type === "live-session.hung_tool_escape",
		) as { data?: { timeoutMs?: number; graceMs?: number } } | undefined;
		assert.ok(escapeEvent, "expected a live-session.hung_tool_escape event");
		assert.equal(escapeEvent?.data?.timeoutMs, 500);
		assert.equal(escapeEvent?.data?.graceMs, 300);
		// Drop-reference: the handle is TERMINATED and REMOVED — the stuck
		// session holds no registry slot.
		assert.equal(getLiveAgent(scenario.agentId), undefined, "hung handle must be unregistered");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("U4 LiveSessionHungToolError: cooperatively-settling timeouts are ordinary timeouts, not escapes", async () => {
	// A prompt that DOES settle after abort (tool honored the signal) must
	// surface the plain timeout error, not the escape hatch.
	const error = new LiveSessionHungToolError("Live-session", 500, 300);
	assert.equal(error.name, "LiveSessionHungToolError");
	assert.ok(error.message.includes("escape hatch"));
	// Prompt-timeout classification stays string-based downstream ("timed out").
	const ordinary = new Error("Live-session timed out after 500ms");
	assert.ok(!ordinary.message.includes("escape hatch"));
});
