/**
 * U14 (upgrade-spec 2026-10-09): child-pi protocol v2 — `--mode rpc`
 * transport regression tests.
 *
 * Hermetic: every spawn goes through a fake RPC fixture
 * (test/fixtures/fake-pi-rpc.mjs) injected via the PI_TEAMS_PI_BIN +
 * npm_config_prefix allowlist trick (same pattern as run-worker-cap.test.ts)
 * — the SDK's REAL RpcClient owns the wire on the client side, so these tests
 * exercise the maintained wire implementation, not a hand-rolled copy.
 *
 * Coverage mandated by the U14 task packet (regression BOTH modes):
 *   - rpc end-to-end: clear_queue → prompt(streamingBehavior) → events →
 *     agent_settled → stdin-close exit 0 (PoC shutdown contract).
 *   - abort-receipt semantics: settle-gated, no data payload (wire contract).
 *   - multi-prompt same pid (direct client + opt-in pool across 2 runChildPi).
 *   - SIGTERM path leaves no orphan (pid dead after settle).
 *   - malformed stdout line survives (garbage-first knob).
 *   - steer gate: mid-run steer delivered with receipt; idle turn_end never
 *     steers (PoC nuance 1 — stale idle-steer must not poison the next run).
 *   - extension_ui spam filtered by type at the consumer (nuance 6).
 *   - json fallback flag: default (unset) stays on the json transport using
 *     the json fixture — the BOTH-directions regression lever.
 *   - pure units: buildRpcClientArgs stripping + mode/pool env resolution.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import {
	buildRpcClientArgs,
	clearRpcPool,
	RPC_DROPPED_EVENT_TYPES,
	resolveChildPiRpcMode,
	resolveChildPiRpcPoolEnabled,
} from "../../../../src/runtime/child-pi/child-pi-rpc.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures", import.meta.url));
const RPC_FIXTURE_SRC = path.join(FIXTURES_DIR, "fake-pi-rpc.mjs");
const JSON_FIXTURE_SRC = path.join(FIXTURES_DIR, "fake-pi.mjs");

/** Env snapshot keys this suite mutates (restored per-test in finally). */
const MUTATED_ENV_KEYS = [
	"PI_CREW_CHILD_PI_MODE",
	"PI_CREW_CHILD_PI_POOL",
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"npm_config_prefix",
] as const;

interface Harness {
	workRoot: string;
	binDir: string;
	logPath: string;
	/** Write the fixture (with extra knob flags) into the allowlisted dir. */
	stageFixture: (source: string, extraArgs: string[]) => string;
	setMode: (mode: "rpc" | "json" | undefined) => void;
	cleanup: () => void;
}

async function makeHarness(fixtureArgs: string[] = []): Promise<Harness> {
	const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "u14-rpc-"));
	const binDir = path.join(workRoot, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const logPath = path.join(workRoot, "trace.log");
	const rpcFixturePath = path.join(binDir, "fake-pi-rpc.mjs");
	fs.copyFileSync(RPC_FIXTURE_SRC, rpcFixturePath);
	const jsonFixturePath = path.join(binDir, "fake-pi.mjs");
	fs.copyFileSync(JSON_FIXTURE_SRC, jsonFixturePath);

	const saved: Record<string, string | undefined> = {};
	for (const key of MUTATED_ENV_KEYS) saved[key] = process.env[key];
	process.env.npm_config_prefix = binDir; // pi-spawn.ts isWithinAllowedPrefixes
	process.env.PI_TEAMS_PI_BIN = rpcFixturePath;
	process.env.PI_CREW_CHILD_PI_MODE = "rpc";
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
	delete process.env.PI_CREW_DEPTH;
	delete process.env.PI_TEAMS_DEPTH;

	const harness: Harness = {
		workRoot,
		binDir,
		logPath,
		stageFixture: (source: string, extraArgs: string[]) => {
			const staged = path.join(binDir, path.basename(source));
			let body = fs.readFileSync(source, "utf-8");
			if (extraArgs.length > 0) {
				// Knob injection: append flags to the argv the fixture parses.
				body = body.replace(
					"const opts = parseArgs(process.argv.slice(2));",
					`const opts = parseArgs([...process.argv.slice(2), ...${JSON.stringify(extraArgs)}]);`,
				);
			}
			fs.writeFileSync(staged, body, "utf-8");
			return staged;
		},
		setMode: (mode) => {
			if (mode === undefined) delete process.env.PI_CREW_CHILD_PI_MODE;
			else process.env.PI_CREW_CHILD_PI_MODE = mode;
		},
		cleanup: () => {
			for (const key of MUTATED_ENV_KEYS) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			fs.rmSync(workRoot, { recursive: true, force: true });
		},
	};
	// Default trace target for the rpc fixture (tests can restage with knobs).
	process.env.PI_TEAMS_PI_BIN = harness.stageFixture(RPC_FIXTURE_SRC, fixtureArgs.concat("--log", logPath));
	return harness;
}

function makeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "U14 rpc test agent",
		source: "user",
		filePath: "<test>",
		systemPrompt: "You are a U14 test agent.",
		inheritProjectContext: false,
		inheritSkills: false,
		tools: [],
		disableTools: true,
	} as AgentConfig;
}

function readTrace(h: Harness): Array<Record<string, unknown>> {
	if (!fs.existsSync(h.logPath)) return [];
	return fs
		.readFileSync(h.logPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Wait until pid is gone (no orphan) — resolves false on timeout. */
async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

// ── Pure units ───────────────────────────────────────────────────────────

test("buildRpcClientArgs strips the json mode cluster and the @task.md positional", () => {
	const built = ["--mode", "json", "-p", "--session-id", "s1", "--no-approve", "@/tmp/pi-crew-x/task.md"];
	assert.deepEqual(buildRpcClientArgs(built), ["--session-id", "s1", "--no-approve"]);
});

test("buildRpcClientArgs tolerates a cluster without -p (only the TRAILING @task is stripped)", () => {
	const built = ["--mode", "json", "--model", "p/m", "--extra"];
	assert.deepEqual(buildRpcClientArgs(built), ["--model", "p/m", "--extra"]);
});

test("resolveChildPiRpcMode: only the explicit 'rpc' value opts in (json fallback default)", () => {
	const savedMode = process.env.PI_CREW_CHILD_PI_MODE;
	try {
		delete process.env.PI_CREW_CHILD_PI_MODE;
		assert.equal(resolveChildPiRpcMode(), false);
		process.env.PI_CREW_CHILD_PI_MODE = "json";
		assert.equal(resolveChildPiRpcMode(), false);
		process.env.PI_CREW_CHILD_PI_MODE = "rpc";
		assert.equal(resolveChildPiRpcMode(), true);
	} finally {
		if (savedMode === undefined) delete process.env.PI_CREW_CHILD_PI_MODE;
		else process.env.PI_CREW_CHILD_PI_MODE = savedMode;
	}
});

test("resolveChildPiRpcPoolEnabled: pool is opt-in only (phase-1 default OFF)", () => {
	const savedMode = process.env.PI_CREW_CHILD_PI_POOL;
	try {
		delete process.env.PI_CREW_CHILD_PI_POOL;
		assert.equal(resolveChildPiRpcPoolEnabled(), false);
		process.env.PI_CREW_CHILD_PI_POOL = "1";
		assert.equal(resolveChildPiRpcPoolEnabled(), true);
	} finally {
		if (savedMode === undefined) delete process.env.PI_CREW_CHILD_PI_POOL;
		else process.env.PI_CREW_CHILD_PI_POOL = savedMode;
	}
});

test("RPC_DROPPED_EVENT_TYPES filters exactly the extension_ui subprotocol spam", () => {
	assert.ok(RPC_DROPPED_EVENT_TYPES.has("extension_ui_request"));
	assert.ok(RPC_DROPPED_EVENT_TYPES.has("extension_ui_response"));
	assert.equal(RPC_DROPPED_EVENT_TYPES.size, 2);
});

// ── End-to-end transport regression (rpc mode) ───────────────────────────

test("rpc mode: clear_queue precedes prompt, streamingBehavior always sent, stdin-close exit 0, answer captured", async () => {
	const h = await makeHarness();
	try {
		const transcriptPath = path.join(h.workRoot, "art", "transcript.jsonl"); // must live under artifactsRoot (transcript path containment)
		const jsonEvents: unknown[] = [];
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-E2E-MARKER",
			agent: makeAgent(),
			runId: "u14-e2e",
			agentId: "u14-e2e-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
			transcriptPath,
			onJsonEvent: (ev) => jsonEvents.push(ev),
		});
		// stdin-close shutdown contract (PoC: orderly dispose → exit 0).
		assert.equal(result.exitCode, 0, `error=${result.error ?? "(none)"} stderr=${result.stderr}`);
		assert.equal(result.exitStatus?.exitCode, 0);
		assert.ok(result.rawFinalText?.includes("U14-E2E-MARKER"), `rawFinalText=${result.rawFinalText ?? "(none)"}`);
		// Events reached the consumer through the shared observer pipeline.
		assert.ok(jsonEvents.some((e) => (e as { type?: string })?.type === "message_end"));
		assert.ok(fs.existsSync(transcriptPath), "transcript must be written in rpc mode too");
		// Hygiene order: clear_queue BEFORE prompt (PoC nuance 1).
		const trace = readTrace(h);
		const commands = trace.filter((l) => l.kind === "command").map((l) => l.type);
		const clearIdx = commands.indexOf("clear_queue");
		const promptIdx = commands.indexOf("prompt");
		assert.ok(clearIdx !== -1, `clear_queue must be sent; commands=${JSON.stringify(commands)}`);
		assert.ok(promptIdx !== -1, `prompt must be sent; commands=${JSON.stringify(commands)}`);
		assert.ok(clearIdx < promptIdx, `clear_queue must precede prompt; commands=${JSON.stringify(commands)}`);
		// The streamed events settled the run (agent_settled observed by fixture).
		assert.ok(
			trace.some((l) => l.kind === "settled"),
			"fixture must have emitted agent_settled",
		);
	} finally {
		h.cleanup();
	}
});

test("rpc mode: malformed stdout line survives (stream keeps living)", async () => {
	const h = await makeHarness(["--garbage-first"]);
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-GARBAGE-MARKER",
			agent: makeAgent(),
			runId: "u14-garbage",
			agentId: "u14-garbage-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0, `error=${result.error ?? "(none)"}`);
		assert.ok(result.rawFinalText?.includes("U14-GARBAGE-MARKER"));
	} finally {
		h.cleanup();
	}
});

test("rpc mode: extension_ui_request spam is filtered by type at the consumer", async () => {
	const h = await makeHarness(["--ui-spam"]);
	try {
		const jsonEvents: unknown[] = [];
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-UISPAM-MARKER",
			agent: makeAgent(),
			runId: "u14-uispam",
			agentId: "u14-uispam-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
			onJsonEvent: (ev) => jsonEvents.push(ev),
		});
		assert.equal(result.exitCode, 0);
		const types = jsonEvents.map((e) => (e as { type?: string })?.type);
		assert.ok(!types.includes("extension_ui_request"), "extension_ui spam must never reach the consumer");
		assert.ok(!types.includes("extension_ui_response"));
		assert.ok(types.includes("message_end"), "real events still flow");
	} finally {
		h.cleanup();
	}
});

test("rpc mode: stale idle-steer is cleared before prompt and never injected", async () => {
	const h = await makeHarness(["--stale-steer"]);
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-STALE-MARKER",
			agent: makeAgent(),
			runId: "u14-stale",
			agentId: "u14-stale-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0);
		const trace = readTrace(h);
		// The stale steering text the fixture queued must be RETURNED by the
		// pre-prompt clear_queue (and therefore NOT delivered into the run).
		const clearResp = trace.find((l) => l.kind === "response");
		assert.ok(clearResp, "clear_queue response must be traced");
		const data = clearResp.data as { steering?: string[] } | undefined;
		assert.ok(
			Array.isArray(data?.steering) && data.steering.length === 1,
			`stale steering must be drained; data=${JSON.stringify(data)}`,
		);
		assert.ok(result.rawFinalText?.includes("U14-STALE-MARKER"));
	} finally {
		h.cleanup();
	}
});

test("rpc mode: parent abort mid-run kills the child — aborted flag set, no orphan pid", async () => {
	const h = await makeHarness(["--run-ms", "1200"]);
	try {
		const ac = new AbortController();
		let pid: number | undefined;
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-ABORT-MARKER",
			agent: makeAgent(),
			runId: "u14-abort",
			agentId: "u14-abort-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
			signal: ac.signal,
			onSpawn: (p) => {
				pid = p;
				// Kill as soon as the run is live (fixture work = 1200ms).
				setTimeout(() => ac.abort(), 150);
			},
		});
		assert.equal(result.aborted, true, `result=${JSON.stringify({ exitCode: result.exitCode, error: result.error })}`);
		assert.ok(pid, "onSpawn must have fired with the pid");
		assert.ok(await waitForPidGone(pid!), `rpc child pid ${pid} must not survive the abort (no orphan)`);
		// The graceful abort receipt was still attempted before the kill-tree.
		const trace = readTrace(h);
		assert.ok(
			trace.some((l) => l.kind === "command" && l.type === "abort"),
			"client.abort() must have been sent",
		);
	} finally {
		h.cleanup();
	}
});

test("rpc mode: soft turn-limit steer is delivered mid-run with a receipt (isStreaming gate open)", async () => {
	const h = await makeHarness(["--run-ms", "600", "--turns", "1", "--turn-end-phase", "pre"]);
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-STEER-MARKER",
			agent: makeAgent(),
			maxTurns: 1,
			runId: "u14-steer",
			agentId: "u14-steer-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.steered, true, "soft-limit steer must mark the result steered");
		const trace = readTrace(h);
		const steerReceipt = trace.find(
			(l) => l.kind === "response" && (l as { data?: { disposition?: string } }).data?.disposition === "started",
		);
		assert.ok(steerReceipt, `steer receipt with disposition=started must be traced; trace=${JSON.stringify(trace)}`);
		assert.ok(
			trace.some((l) => l.kind === "command" && l.type === "steer"),
			"steer must have been sent over the wire",
		);
	} finally {
		h.cleanup();
	}
});

test("rpc mode: idle turn_end NEVER steers (stale idle-steer must not poison the next run)", async () => {
	const h = await makeHarness(["--run-ms", "150", "--turns", "1", "--turn-end-phase", "post"]);
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-IDLE-MARKER",
			agent: makeAgent(),
			maxTurns: 1,
			runId: "u14-idle",
			agentId: "u14-idle-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0);
		const trace = readTrace(h);
		assert.ok(
			!trace.some((l) => l.kind === "command" && l.type === "steer"),
			`no steer command may be sent for an idle turn_end; trace=${JSON.stringify(trace.filter((l) => l.kind === "command"))}`,
		);
	} finally {
		h.cleanup();
	}
});

test("rpc mode: pool reuses ONE process across two runChildPi prompts (same pid)", async () => {
	const h = await makeHarness();
	process.env.PI_CREW_CHILD_PI_POOL = "1";
	try {
		const pids: number[] = [];
		const mkInput = (marker: string) => ({
			cwd: h.workRoot,
			task: marker,
			agent: makeAgent(),
			runId: "u14-pool",
			agentId: "u14-pool-worker", // SAME agent id → same pool key
			artifactsRoot: path.join(h.workRoot, "art"),
			onSpawn: (p: number) => pids.push(p),
		});
		const r1 = await runChildPi(mkInput("U14-POOL-ONE"));
		assert.equal(r1.exitCode, 0, `run1 error=${r1.error ?? "(none)"}`);
		assert.ok(r1.rawFinalText?.includes("U14-POOL-ONE"));
		const r2 = await runChildPi(mkInput("U14-POOL-TWO"));
		assert.equal(r2.exitCode, 0, `run2 error=${r2.error ?? "(none)"}`);
		assert.ok(r2.rawFinalText?.includes("U14-POOL-TWO"));
		assert.equal(pids.length, 2, "onSpawn fires per run (even on reuse)");
		assert.equal(pids[0], pids[1], `both runs must use the SAME pid (pool reuse): ${pids.join(",")}`);
	} finally {
		clearRpcPool(); // stops the warm process — nothing may leak past the test
		h.cleanup();
	}
});

test("rpc mode: 'handled' prompt disposition fails the run instead of waiting on the watchdog", async () => {
	const h = await makeHarness(["--handled-first-prompt"]);
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "U14-HANDLED-MARKER",
			agent: makeAgent(),
			runId: "u14-handled",
			agentId: "u14-handled-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("handled"), `error=${result.error}`);
	} finally {
		h.cleanup();
	}
});

// ── json fallback regression (default transport unchanged) ───────────────

test("json fallback flag: unset mode stays on the --mode json -p transport (json fixture run)", async () => {
	const h = await makeHarness();
	h.setMode(undefined); // UNSET → json default
	fs.copyFileSync(JSON_FIXTURE_SRC, path.join(h.binDir, "fake-pi.mjs"));
	process.env.PI_TEAMS_PI_BIN = path.join(h.binDir, "fake-pi.mjs");
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "hello-json",
			agent: makeAgent(),
			runId: "u14-json",
			agentId: "u14-json-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0, `error=${result.error ?? "(none)"} stderr=${result.stderr}`);
		assert.ok(result.rawFinalText?.includes("[fake-pi]"), `rawFinalText=${result.rawFinalText ?? "(none)"}`);
	} finally {
		h.cleanup();
	}
});

test("json fallback flag: explicit PI_CREW_CHILD_PI_MODE=json also stays on json transport", async () => {
	const h = await makeHarness();
	h.setMode("json");
	fs.copyFileSync(JSON_FIXTURE_SRC, path.join(h.binDir, "fake-pi.mjs"));
	process.env.PI_TEAMS_PI_BIN = path.join(h.binDir, "fake-pi.mjs");
	try {
		const result = await runChildPi({
			cwd: h.workRoot,
			task: "hello-json-explicit",
			agent: makeAgent(),
			runId: "u14-json2",
			agentId: "u14-json2-worker",
			artifactsRoot: path.join(h.workRoot, "art"),
		});
		assert.equal(result.exitCode, 0);
		assert.ok(result.rawFinalText?.includes("[fake-pi]"));
	} finally {
		h.cleanup();
	}
});

// ── Wire-contract tests against the REAL RpcClient (fixture as the server) ─

test("abort receipt is SETTLE-GATED and carries NO data payload (real RpcClient wire)", async () => {
	const h = await makeHarness(["--run-ms", "600"]);
	try {
		// LAZY: same SDK lazy-import policy as the transport.
		const { RpcClient } = await import("@earendil-works/pi-coding-agent");
		const client = new RpcClient({ cliPath: process.env.PI_TEAMS_PI_BIN, cwd: h.workRoot, args: ["--log", h.logPath] });
		await client.start();
		try {
			const settled = new Promise<void>((resolve) => {
				const off = client.onEvent((ev) => {
					if ((ev as { type?: string })?.type === "agent_settled") {
						off();
						resolve();
					}
				});
			});
			const disposition = await client.prompt("U14-ABORTRECEIPT", undefined, "followUp");
			assert.equal(disposition, "started");
			// Abort while the run is live; the fixture holds the receipt until
			// the run settles (~600ms) — verify round 9 P1 semantics.
			await new Promise((r) => setTimeout(r, 120));
			const t0 = Date.now();
			await client.abort();
			const elapsed = Date.now() - t0;
			await settled;
			assert.ok(elapsed >= 350, `abort receipt must be settle-gated (elapsed=${elapsed}ms)`);
			const trace = readTrace(h);
			const abortResp = trace.find(
				(l) => l.kind === "response" && l.data !== undefined && Object.keys(l.data as object).length === 0 && l.id,
			);
			assert.ok(
				abortResp,
				`the abort response must carry an EMPTY data object (no payload); trace tail=${JSON.stringify(trace.slice(-4))}`,
			);
			assert.equal(abortResp.success, true);
			// Multi-prompt on the SAME pid (PoC: 1 process = 1 session, N prompts).
			const pidBefore = (client as unknown as { process: ChildProcess }).process?.pid;
			const d2 = await client.prompt("U14-ABORTRECEIPT-TWO", undefined, "followUp");
			assert.equal(d2, "started");
			await new Promise<void>((resolve) => {
				const off = client.onEvent((ev) => {
					if ((ev as { type?: string })?.type === "agent_settled") {
						off();
						resolve();
					}
				});
				setTimeout(resolve, 5000);
			});
			const pidAfter = (client as unknown as { process: ChildProcess }).process?.pid;
			assert.equal(pidBefore, pidAfter, "one process must serve both prompts");
		} finally {
			await client.stop();
		}
	} finally {
		h.cleanup();
	}
});

test("SIGTERM shutdown: rpc fixture exits 143 with no leftover process", async () => {
	const h = await makeHarness();
	try {
		const child = spawn(process.execPath, [process.env.PI_TEAMS_PI_BIN!], { stdio: ["pipe", "pipe", "pipe"] });
		const pid = child.pid!;
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.ok(child.exitCode === null, "fixture must be alive before SIGTERM");
		child.kill("SIGTERM");
		const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			const timer = setTimeout(() => resolve({ code: null, signal: null }), 3000);
			child.on("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal });
			});
		});
		assert.ok(exitInfo.code === 143 || exitInfo.signal === "SIGTERM", `exit=${exitInfo.code}/${exitInfo.signal}`);
		assert.ok(await waitForPidGone(pid), "no orphan after SIGTERM");
	} finally {
		h.cleanup();
	}
});
