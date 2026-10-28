/**
 * child-pi-broker-stdin.test.ts — LOW-1 residual closure (2026-10-27;
 * OPT-IN since v0.11.48 after the live battery caught the reader path killing
 * real headless workers — see resolveBrokerStdinHandshakeEnabled doc block).
 *
 * Pins the spawn side of the stdin broker-credential handshake on the MAIN
 * worker spawn path (mirror of the F4 background-runner handshake):
 *
 *   1. Gate is OPT-IN: PI_CREW_BROKER_STDIN exactly '1' enables the stdin
 *      route; unset/'0'/anything else keeps the legacy env route (default).
 *   2. Opt-in gate PI_CREW_BROKER_STDIN=1: prepareSpawnContext writes the
 *      flag "1" + SOCKET/RUN_ID/TASK_ID + TOKEN into built.env (FIX-1
 *      2026-10-28: RPC/surface call sites compose WITHOUT the payload, so the
 *      env write is their only credential) AND binds ctx.brokerStdinPayload
 *      (one buildBrokerStdinLine v2 line); buildFinalChildPiSpawnOptions
 *      (payload) switches stdin to "pipe" + strips the token from the FINAL
 *      child env (defense-in-depth).
 *   3. Default (unset) and explicit '0': token back in built.env, no
 *      payload, stdin stays "ignore" — bit-for-bit legacy behavior.
 *   4. No brokerSpawn / identity-less brokerSpawn (no runId+agentId to bind
 *      the payload) → legacy env route.
 *   5. FIX-1 env matrix (composed-path, per branch): gate ON + headless
 *      compose = flag "1" + token ABSENT + stdin pipe; gate ON + RPC/surface
 *      compose (no payload) = flag "1" + token PRESENT; gate OFF = flag
 *      absent + token present + no payload (bit-for-bit legacy).
 *
 * Pure-function tests: prepareSpawnContext does NOT spawn — fast + hermetic.
 * The writer format is pinned against the reader parser via
 * parseStdinBrokerPayload (the exact worker-side reader).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { parseStdinBrokerPayload } from "../../../../src/runtime/broker/stdin-handshake.ts";
import {
	buildFinalChildPiSpawnOptions,
	prepareSpawnContext,
	resolveBrokerStdinHandshakeEnabled,
	type SpawnContext,
} from "../../../../src/runtime/child-pi/child-pi-spawn.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "executor",
		description: "executor",
		source: "builtin",
		filePath: "executor.md",
		systemPrompt: "executor",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

const BROKER_SPAWN = { socketPath: "/tmp/crew-broker-stdin-test.sock", token: "stdin-token-abc123" };
const RUN_ID = "run_20261027_stdin";
const AGENT_ID = "task-stdin-42";

/** Scrub the gate var so ambient worker-env noise cannot flip the branch. */
function withGate(value: string | undefined, fn: () => void): void {
	const prev = process.env.PI_CREW_BROKER_STDIN;
	try {
		if (value === undefined) delete process.env.PI_CREW_BROKER_STDIN;
		else process.env.PI_CREW_BROKER_STDIN = value;
		fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_BROKER_STDIN;
		else process.env.PI_CREW_BROKER_STDIN = prev;
	}
}

interface PrepResult {
	builtEnv: Record<string, string | undefined>;
	ctx: SpawnContext;
	dir: string;
}

function prepWithBroker(opts?: { agentId?: string | null; runId?: string | null }): PrepResult {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-stdin-"));
	// `null` ⇒ pass undefined explicitly (identity-less spawn shape); absent ⇒ default.
	const agentId = opts && "agentId" in opts && opts.agentId === null ? undefined : (opts?.agentId ?? AGENT_ID);
	const runId = opts && "runId" in opts && opts.runId === null ? undefined : (opts?.runId ?? RUN_ID);
	const res = prepareSpawnContext(
		{
			cwd: dir,
			task: "small task",
			agent: makeAgent(),
			role: "executor",
			agentId,
			runId,
			brokerSpawn: BROKER_SPAWN,
		},
		"small task",
	);
	assert.equal(res.kind, "ready", "must be ready (no pre-spawn abort)");
	if (res.kind !== "ready") throw new Error("unreachable");
	return { builtEnv: res.ctx.builtEnv, ctx: res.ctx, dir };
}

// ── Gate resolution ──────────────────────────────────────────────────────

describe("resolveBrokerStdinHandshakeEnabled (PI_CREW_BROKER_STDIN gate)", () => {
	it("OPT-IN since v0.11.48: OFF when unset, OFF for any non-'1' value, ON exactly for '1'", () => {
		withGate(undefined, () => assert.equal(resolveBrokerStdinHandshakeEnabled(), false));
		withGate("0", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), false));
		withGate("true", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), false));
		withGate("1", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), true));
	});
});

// ── Opt-in route (gate=1): token over stdin, env stays token-free ───────

describe("prepareSpawnContext: stdin handshake opt-in (gate=1)", () => {
	after(() => {
		delete process.env.PI_CREW_BROKER_STDIN;
	});

	it("FIX-1: built.env carries flag '1' + token + identity for BOTH routes; payload binds", () => {
		withGate("1", () => {
			const { builtEnv, ctx, dir } = prepWithBroker();
			try {
				// FIX-1 (2026-10-28 dead-wire repair): the token is written into
				// built.env on EVERY branch — the RPC/surface call sites compose
				// WITHOUT the payload, so this env write is their ONLY credential
				// source. The headless compose strips it from the FINAL env
				// (pinned below + in the matrix describe); built.env itself is not
				// the child env.
				assert.equal(builtEnv.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token);
				assert.equal(
					builtEnv.PI_CREW_BROKER_STDIN,
					"1",
					"worker mirror gate reads the CHILD env — spawner must write the flag (was dead-wired)",
				);
				assert.equal(builtEnv.PI_CREW_BROKER_SOCKET, BROKER_SPAWN.socketPath);
				assert.equal(builtEnv.PI_CREW_BROKER_RUN_ID, RUN_ID);
				assert.equal(builtEnv.PI_CREW_BROKER_TASK_ID, AGENT_ID);
				assert.ok(ctx.brokerStdinPayload, "opt-in + identity → payload present");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("ctx.brokerStdinPayload is ONE v2 line with the exact single-task compound shape", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker();
			try {
				const payload = ctx.brokerStdinPayload;
				assert.ok(payload, "payload must be present on the default route");
				assert.ok(payload.endsWith("\n"), "payload must be exactly one newline-terminated line");
				assert.equal(payload.indexOf("\n"), payload.length - 1, "no inner newlines");
				const parsed = parseStdinBrokerPayload(payload.trim(), RUN_ID);
				assert.ok(parsed, "worker-side reader parser must accept the payload verbatim");
				assert.deepEqual(parsed, {
					v: 2,
					runId: RUN_ID,
					socketPath: BROKER_SPAWN.socketPath,
					tasks: { [AGENT_ID]: BROKER_SPAWN.token },
				});
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("buildFinalChildPiSpawnOptions(payload): stdin pipes + token stripped even when builtEnv sneaks one in", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker();
			try {
				const spawnOptions = buildFinalChildPiSpawnOptions(
					dir,
					ctx.mergedEnv,
					{ ...ctx.builtEnv, PI_CREW_BROKER_TOKEN: "sneaky-legacy-token" },
					undefined,
					undefined,
					true,
					ctx.brokerStdinPayload,
				);
				const stdio = spawnOptions.stdio as string[];
				assert.equal(stdio[0], "pipe", "stdin must be a pipe when the payload is delivered via stdin");
				assert.equal(stdio[1], "pipe");
				assert.equal(stdio[2], "pipe");
				const env = spawnOptions.env as Record<string, string | undefined>;
				assert.equal(env.PI_CREW_BROKER_TOKEN, undefined, "defense-in-depth: token never reaches the child env");
				assert.equal(
					env.PI_CREW_BROKER_STDIN,
					"1",
					"FIX-1: the opt-in flag must survive the headless compose (worker fallback gate)",
				);
				assert.equal(env.PI_CREW_BROKER_SOCKET, BROKER_SPAWN.socketPath, "non-secret identity keys stay");
				assert.equal(env.PI_CREW_BROKER_RUN_ID, RUN_ID);
				assert.equal(env.PI_CREW_BROKER_TASK_ID, AGENT_ID);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

// ── Rollback route: gate=0 keeps the legacy env behavior bit-for-bit ────

describe("prepareSpawnContext: DEFAULT route (gate unset) keeps the legacy env behavior bit-for-bit", () => {
	it("token stays in built.env, NO payload, spawnOptions keep stdin=ignore + env token", () => {
		withGate(undefined, () => {
			const { ctx, dir } = prepWithBroker();
			try {
				assert.equal(ctx.builtEnv.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token, "default legacy route: token via env");
				assert.equal(ctx.brokerStdinPayload, undefined, "default legacy route: no stdin payload");
				const spawnOptions = buildFinalChildPiSpawnOptions(dir, ctx.mergedEnv, ctx.builtEnv, undefined, undefined, true);
				const stdio = spawnOptions.stdio as string[];
				assert.equal(stdio[0], "ignore", "default legacy route: stdin stays ignore");
				assert.equal((spawnOptions.env as Record<string, string | undefined>).PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

// ── Degenerate shapes → legacy env route ─────────────────────────────────

describe("prepareSpawnContext: identity-less brokerSpawn cannot bind a payload", () => {
	it("no runId → env token route even with the gate on", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker({ runId: null });
			try {
				assert.equal(ctx.builtEnv.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token, "payload needs runId to bind — env fallback");
				assert.equal(ctx.brokerStdinPayload, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("no agentId → env token route even with the gate on", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker({ agentId: null });
			try {
				assert.equal(
					ctx.builtEnv.PI_CREW_BROKER_TOKEN,
					BROKER_SPAWN.token,
					"payload needs agentId (task key) to bind — env fallback",
				);
				assert.equal(ctx.brokerStdinPayload, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("no brokerSpawn at all → neither token nor payload", () => {
		withGate(undefined, () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-broker-stdin-"));
			try {
				const res = prepareSpawnContext(
					{ cwd: dir, task: "t", agent: makeAgent(), role: "executor", agentId: AGENT_ID, runId: RUN_ID },
					"t",
				);
				assert.equal(res.kind, "ready");
				if (res.kind !== "ready") throw new Error("unreachable");
				assert.equal(res.ctx.builtEnv.PI_CREW_BROKER_TOKEN, undefined);
				assert.equal(res.ctx.builtEnv.PI_CREW_BROKER_SOCKET, undefined);
				assert.equal(res.ctx.brokerStdinPayload, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

// ── FIX-1 env matrix: composed spawn options per spawn branch ────────────
//
// The three call sites compose buildFinalChildPiSpawnOptions differently:
//   - headless JSON branch (child-pi.ts run()): passes ctx.brokerStdinPayload
//     + workerCacheSplit=true → stdin becomes a pipe and the token is
//     stripped from the FINAL env (it rides the pipe instead);
//   - RPC branch (child-pi-rpc.ts) and surface branch (child-pi.ts
//     trySurfaceBranch): NO payload → stdin stays "ignore" and the env token
//     survives (their stdin is the JSONL protocol channel / a TTY — the env
//     write from prepareSpawnContext is their ONLY credential source).
// Gate OFF must stay bit-for-bit legacy: no flag, no payload, token in env.

describe("FIX-1 env matrix: composed spawn options per branch", () => {
	it("gate ON + headless-JSON compose (with payload): flag '1', token ABSENT, stdin=pipe", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker();
			try {
				assert.ok(ctx.brokerStdinPayload, "precondition: payload bound");
				const spawnOptions = buildFinalChildPiSpawnOptions(
					dir,
					ctx.mergedEnv,
					ctx.builtEnv,
					undefined,
					undefined,
					true,
					ctx.brokerStdinPayload,
				);
				const env = spawnOptions.env as Record<string, string | undefined>;
				assert.equal(env.PI_CREW_BROKER_STDIN, "1");
				assert.equal(env.PI_CREW_BROKER_TOKEN, undefined, "token rides the stdin pipe, not env");
				assert.equal(env.PI_CREW_BROKER_SOCKET, BROKER_SPAWN.socketPath);
				assert.equal((spawnOptions.stdio as string[])[0], "pipe");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("gate ON + RPC/surface compose (NO payload — child-pi-rpc.ts / trySurfaceBranch call shape): flag '1', token PRESENT, stdin=ignore", () => {
		withGate("1", () => {
			const { ctx, dir } = prepWithBroker();
			try {
				assert.ok(ctx.brokerStdinPayload, "precondition: payload bound on the prep side");
				// Exactly the RPC call-site shape: no payload, no cache split — the
				// token must survive in the composed env (the RPC/surface child
				// never receives the payload write).
				const spawnOptions = buildFinalChildPiSpawnOptions(dir, ctx.mergedEnv, ctx.builtEnv, undefined);
				const env = spawnOptions.env as Record<string, string | undefined>;
				assert.equal(env.PI_CREW_BROKER_STDIN, "1");
				assert.equal(env.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token, "env write is the RPC/surface credential source");
				assert.equal((spawnOptions.stdio as string[])[0], "ignore");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("gate OFF default: flag ABSENT, token PRESENT, no payload (bit-for-bit legacy)", () => {
		withGate(undefined, () => {
			const { ctx, dir } = prepWithBroker();
			try {
				assert.equal(ctx.brokerStdinPayload, undefined);
				const spawnOptions = buildFinalChildPiSpawnOptions(dir, ctx.mergedEnv, ctx.builtEnv, undefined, undefined, true);
				const env = spawnOptions.env as Record<string, string | undefined>;
				assert.equal(env.PI_CREW_BROKER_STDIN, undefined, "flag must NOT leak into the child env when the gate is off");
				assert.equal(env.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token);
				assert.equal((spawnOptions.stdio as string[])[0], "ignore");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
