/**
 * run-worker-rpc-seam.test.ts — W7 (P2-3) integration phase: the run-worker
 * transport seam is WIRED (live-fire probe GREEN 2026-10-04, see
 * src/runtime/rpc/README.md — probe items (a)-(d) all passed against a real
 * `pi --mode rpc --no-session` process: 24 ui-requests drained, prompt
 * round-trip "OK", confirm dialog cancelled without deadlock, steer honored).
 *
 * Guarantees under test (fake streams ONLY — no real spawn):
 *   1. PI_CREW_WORKER_TRANSPORT=rpc → runWorker delegates to runRpcWorker:
 *      the fake server sees the live-fire argv (`--mode rpc --no-session`,
 *      `--model` when a model is supplied) and the result is the rpc mapping
 *      (rawFinalText, exitCode), with the worker-cap slot taken and RELEASED
 *      (a second capped call proceeds).
 *   2. A pre-aborted signal short-circuits BEFORE the rpc spawn and answers
 *      via the stdio path's B5 pre-spawn guard (spawn count asserted 0).
 *      (The early-failure → stdio fallback leg reuses that same runChildPi
 *      call inside the rpc path; its gate is the predicate truth table.)
 *   3. isEarlyRpcTransportFailure truth table (double-execution guard: a
 *      result with rawFinalText, rpcAgentStarted, or aborted is never retried).
 *   4. DR1/DR5 lifecycle hardening (deep-review 2026-10-05 §2): child exit
 *      before agent_settled → early failure → stdio fallback + slot released;
 *      agent-started-but-unsettled → surfaced, NEVER retried; turn timeout
 *      (PI_CREW_RPC_TURN_TIMEOUT_MS) → early-failure shape → fallback.
 *
 * The default (env unset → stdio) path is deliberately NOT exercised here: it
 * delegates to the real runChildPi and would spawn a real pi binary. Its
 * unchanged behavior is covered by run-worker-cap.test.ts (real spawn) and by
 * the resolveWorkerTransport failsafe tests in rpc/rpc-worker.test.ts.
 *
 * Worker-shell env gotcha (.crew/knowledge.md 2026-08-15): snapshot/restore
 * every crew-family var this file touches.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import type { RpcSpawnFn } from "../../../src/runtime/rpc/frame-client.ts";
import { isEarlyRpcTransportFailure, runWorker, type WorkerSpawnInput } from "../../../src/runtime/run-worker.ts";
import { createFakeRpcServer, type FakeRpcServer } from "./rpc/fake-rpc-stream.ts";

const ENV_KEYS = ["PI_CREW_WORKER_TRANSPORT", "PI_CREW_RPC_TURN_TIMEOUT_MS"] as const;

const agent: AgentConfig = {
	name: "worker",
	description: "rpc-seam test worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

let envBackup: Map<string, string | undefined>;
test.beforeEach(() => {
	envBackup = new Map();
	for (const key of ENV_KEYS) envBackup.set(key, process.env[key]);
	process.env.PI_CREW_WORKER_TRANSPORT = "rpc";
	delete process.env.PI_CREW_RPC_TURN_TIMEOUT_MS;
});
test.afterEach(() => {
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** Script the fake server as a well-behaved rpc-mode peer (probe1b shape). */
function scriptHappyPath(fake: FakeRpcServer, finalText: string) {
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
			fake.emit({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "probe" });
			fake.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } });
			fake.emit({ type: "agent_settled" });
		}
	};
	fake.onStdinEnd = () => setTimeout(() => fake.exitWith(0), 5);
}

/** Wrap the fake handle to capture the argv the seam built. */
function capturingSpawnFn(fake: FakeRpcServer, captured: { argv?: string[] }): RpcSpawnFn {
	return (argv: string[]) => {
		captured.argv = argv;
		return fake.handle;
	};
}

function seamInput(overrides: Partial<WorkerSpawnInput> & { rpc: NonNullable<WorkerSpawnInput["rpc"]> }): WorkerSpawnInput {
	const { rpc, ...rest } = overrides;
	return { cwd: process.cwd(), task: "seam probe", agent, cap: true, rpc, ...rest };
}

/**
 * Env for the DR1/DR5 tests whose stdio FALLBACK leg must not spawn a real
 * pi binary: PI_TEAMS_MOCK_CHILD_PI=success makes runChildPi answer from the
 * mock fixtures, and the depth vars are scrubbed so the worker-shell env
 * (knowledge.md 2026-08-15 gotcha — a pi-crew worker exports PI_CREW_DEPTH)
 * can never trip the child depth guard. Snapshot/restore everything touched.
 */
const FALLBACK_MOCK_ENV_KEYS = [
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"PI_CREW_MAX_DEPTH",
	"PI_TEAMS_MAX_DEPTH",
] as const;

async function withFallbackMockEnv<T>(fn: () => Promise<T>): Promise<T> {
	const saved = new Map<string, string | undefined>();
	for (const key of FALLBACK_MOCK_ENV_KEYS) saved.set(key, process.env[key]);
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	delete process.env.PI_CREW_DEPTH;
	delete process.env.PI_TEAMS_DEPTH;
	delete process.env.PI_CREW_MAX_DEPTH;
	delete process.env.PI_TEAMS_MAX_DEPTH;
	try {
		// Await INSIDE the try: the mock env must stay set for the whole
		// async run (the stdio fallback leg executes long after runWorker
		// returns its promise — restoring early here once leaked a REAL pi
		// spawn into the suite).
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("wired seam: rpc transport runs runRpcWorker (argv contract, drain policy, cap released)", async () => {
	const fake = createFakeRpcServer();
	scriptHappyPath(fake, "seam ok");
	const captured: { argv?: string[] } = {};
	const result = await runWorker(
		seamInput({ rpc: { spawnFn: capturingSpawnFn(fake, captured), commandTimeoutMs: 400, stopTimeoutMs: 300 } }),
	);
	// Result came from the rpc mapping, not a not-implemented stub.
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.rawFinalText, "seam ok");
	// Live-fire argv contract (probe-verified): ephemeral worker, model passed raw.
	assert.deepEqual(captured.argv, ["--mode", "rpc", "--no-session"]);
	// Gate 1 policy ran through the seam: the setStatus ui-request was seen
	// and DROPPED (fire-and-forget) — nothing but the prompt was written to
	// the server. (Positive drain counting is asserted in the policy suite.)
	const written = fake.writtenRecords();
	assert.ok(
		written.every((r) => r.type === "prompt"),
		"fire-and-forget ui-request must be drained (dropped), never answered",
	);
	// Cap slot released: a second capped rpc call must not deadlock.
	const fake2 = createFakeRpcServer();
	scriptHappyPath(fake2, "second run");
	const result2 = await runWorker(
		seamInput({ task: "second", rpc: { spawnFn: () => fake2.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } }),
	);
	assert.equal(result2.rawFinalText, "second run");
});

test("wired seam: model flows into the live-fire argv", async () => {
	const fake = createFakeRpcServer();
	scriptHappyPath(fake, "ok");
	const captured: { argv?: string[] } = {};
	await runWorker(
		seamInput({
			model: "zai/glm-5.3:high",
			rpc: { spawnFn: capturingSpawnFn(fake, captured), commandTimeoutMs: 400, stopTimeoutMs: 300 },
		}),
	);
	assert.deepEqual(captured.argv, ["--mode", "rpc", "--no-session", "--model", "zai/glm-5.3:high"]);
});

test("wired seam: pre-aborted signal short-circuits before the rpc spawn (B5 aborted, no spawn)", async () => {
	// Pre-abort + the rpc transport → the stdio path's B5 pre-spawn guard
	// answers directly. A doomed rpc spawn would only burn a command timeout
	// (runRpcWorker stamps `aborted` on any aborted signal, blinding the
	// early-failure predicate) — so the seam skips rpc entirely.
	const controller = new AbortController();
	controller.abort();
	let spawnCalls = 0;
	const fake = createFakeRpcServer();
	const result = await runWorker(
		seamInput({
			cap: false, // a capped acquire with a pre-aborted signal rejects fail-closed before fn runs
			signal: controller.signal,
			rpc: {
				spawnFn: (argv) => {
					spawnCalls++;
					return fake.handle;
				},
				commandTimeoutMs: 400,
				stopTimeoutMs: 300,
			},
		}),
	);
	assert.equal(spawnCalls, 0, "rpc transport must not spawn for a pre-aborted signal");
	assert.equal(result.aborted, true);
	assert.match(result.error ?? "", /Aborted before spawn/);
	// The fallback gating itself is covered by the isEarlyRpcTransportFailure
	// truth table below; end-to-end the fallback leg runs runChildPi (same
	// call the B5 branch exercises here) behind the structured warn.
	// Slot released (no hang): a follow-up capped call completes.
	const fake2 = createFakeRpcServer();
	scriptHappyPath(fake2, "after fallback");
	const result2 = await runWorker(seamInput({ rpc: { spawnFn: () => fake2.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } }));
	assert.equal(result2.rawFinalText, "after fallback");
});

test("DR1 crash-before-settle: exit before agent_settled → early failure → stdio fallback + slot released", async () => {
	// Script: fake ACKs the prompt (response success), emits NO session event,
	// NO agent_settled, then dies — the settle-hang shape (before the DR1 fix
	// this held the worker-cap slot forever).
	const fake = createFakeRpcServer();
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
			fake.exitWith(1); // crash after ACK, before the turn started
		}
	};
	let rpcSpawnCalls = 0;
	const result = await withFallbackMockEnv(() =>
		runWorker(
			seamInput({
				rpc: {
					spawnFn: (argv) => {
						rpcSpawnCalls++;
						return fake.handle;
					},
					commandTimeoutMs: 400,
					stopTimeoutMs: 300,
				},
			}),
		),
	);
	// The rpc transport ran exactly once and its exit-race failure (error, no
	// rawFinalText, no agent start) classified as early → the stdio fallback
	// leg answered from the mock fixtures instead of a real spawn.
	assert.equal(rpcSpawnCalls, 1);
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout, /\[MOCK\] Success/);
	assert.equal(result.rawFinalText, undefined);
	// Slot released (the pre-fix hang): a follow-up capped rpc call completes.
	const fake2 = createFakeRpcServer();
	scriptHappyPath(fake2, "after crash-before-settle");
	const result2 = await runWorker(
		seamInput({ task: "second", rpc: { spawnFn: () => fake2.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } }),
	);
	assert.equal(result2.rawFinalText, "after crash-before-settle");
});

test("DR5 started-then-fail: session event seen, no settle → surfaced, NEVER falls back", async () => {
	// Script: ACK + ONE session event (the agent turn began) + NO settle +
	// exit — the rawFinalText blind spot: no assistant text, yet side effects
	// may already have run. The stdio fallback must NOT engage.
	const fake = createFakeRpcServer();
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
			fake.emit({ type: "message_start" }); // agent started
			setTimeout(() => fake.exitWith(1), 10); // crash before settle/text
		}
	};
	const result = await withFallbackMockEnv(() =>
		runWorker(seamInput({ rpc: { spawnFn: () => fake.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } })),
	);
	assert.equal(result.error, "rpc transport: exited before agent_settled");
	assert.equal(result.rpcAgentStarted, true);
	assert.equal(result.rawFinalText, undefined);
	assert.notEqual(result.exitCode, 0);
	// The stdio leg never ran (mock-env active, so its distinctive stdout is
	// the tell — a fallback here would be a double execution).
	assert.doesNotMatch(result.stdout, /\[MOCK\]/);
	// Slot still released: the surfaced error path must not hang the cap.
	const fake2 = createFakeRpcServer();
	scriptHappyPath(fake2, "after started-then-fail");
	const result2 = await runWorker(
		seamInput({ task: "second", rpc: { spawnFn: () => fake2.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } }),
	);
	assert.equal(result2.rawFinalText, "after started-then-fail");
});

test("DR1 turn timeout: live-but-silent child → early-failure shape → stdio fallback", async () => {
	// Script: ACK, then NOTHING — no session event, no settle, no exit. Only
	// the turn timeout can rescue this (the exit-race alone never fires).
	process.env.PI_CREW_RPC_TURN_TIMEOUT_MS = "60";
	const fake = createFakeRpcServer();
	fake.onLine = (line) => {
		const record = JSON.parse(line) as { id?: string; type?: string };
		if (record.type === "prompt") {
			fake.emit({ id: record.id, type: "response", command: "prompt", success: true, data: { disposition: "appended" } });
		}
	};
	fake.onStdinEnd = () => setTimeout(() => fake.exitWith(0), 5);
	const result = await withFallbackMockEnv(() =>
		runWorker(seamInput({ rpc: { spawnFn: () => fake.handle, commandTimeoutMs: 400, stopTimeoutMs: 300 } })),
	);
	// Timeout fired → early-failure shape → the stdio fallback answered.
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout, /\[MOCK\] Success/);
	// The timeout failure shape itself: retry-safe only while the DR5 guard
	// has not marked the turn as started.
	const timeoutFailure = {
		exitCode: null,
		stdout: "",
		stderr: "",
		error: "rpc transport: turn timeout after 60ms without agent_settled",
	};
	assert.equal(isEarlyRpcTransportFailure(timeoutFailure), true);
	assert.equal(isEarlyRpcTransportFailure({ ...timeoutFailure, rpcAgentStarted: true }), false);
});

test("isEarlyRpcTransportFailure truth table (double-execution guard)", () => {
	// No error → transport succeeded (even an empty turn) → never retry.
	assert.equal(isEarlyRpcTransportFailure({ exitCode: 0, stdout: "", stderr: "" }), false);
	// Error + no agent output → early failure → retry allowed.
	assert.equal(isEarlyRpcTransportFailure({ exitCode: 1, stdout: "", stderr: "boom", error: "boom" }), true);
	assert.equal(
		isEarlyRpcTransportFailure({ exitCode: null, stdout: "", stderr: "", error: "rpc transport: stdout closed before response" }),
		true,
	);
	// DR1 shapes (no agent start): exit-before-settle and turn timeout → retry-safe.
	assert.equal(
		isEarlyRpcTransportFailure({ exitCode: 1, stdout: "", stderr: "", error: "rpc transport: exited before agent_settled" }),
		true,
	);
	assert.equal(
		isEarlyRpcTransportFailure({
			exitCode: null,
			stdout: "",
			stderr: "",
			error: "rpc transport: turn timeout after 600000ms without agent_settled",
		}),
		true,
	);
	// DR5: agent turn had begun (no captured text) → NEVER retry.
	assert.equal(isEarlyRpcTransportFailure({ exitCode: 1, stdout: "", stderr: "", error: "late crash", rpcAgentStarted: true }), false);
	// Agent produced output → NEVER retry (task already consumed).
	assert.equal(
		isEarlyRpcTransportFailure({ exitCode: 1, stdout: "", stderr: "", error: "late crash", rawFinalText: "partial work" }),
		false,
	);
	// Caller cancelled → never retry.
	assert.equal(isEarlyRpcTransportFailure({ exitCode: null, stdout: "", stderr: "", error: "aborted", aborted: true }), false);
});
