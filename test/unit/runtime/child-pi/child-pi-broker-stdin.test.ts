/**
 * child-pi-broker-stdin.test.ts — LOW-1 residual closure (2026-10-27).
 *
 * Pins the spawn side of the stdin broker-credential handshake on the MAIN
 * worker spawn path (mirror of the F4 background-runner handshake):
 *
 *   1. Gate default (PI_CREW_BROKER_STDIN unset): prepareSpawnContext puts
 *      SOCKET/RUN_ID/TASK_ID in built.env but NOT the TOKEN; the token rides
 *      ctx.brokerStdinPayload (one buildBrokerStdinLine v2 line, per-task
 *      compound shape) and buildFinalChildPiSpawnOptions(payload) switches
 *      stdin to "pipe" + strips any sneak-in token from the final env.
 *   2. Rollback gate PI_CREW_BROKER_STDIN=0: token back in built.env, no
 *      payload, stdin stays "ignore" — bit-for-bit legacy behavior.
 *   3. No brokerSpawn / identity-less brokerSpawn (no runId+agentId to bind
 *      the payload) → legacy env route.
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
	it("defaults ON when unset, ON for any non-'0' value, OFF exactly for '0'", () => {
		withGate(undefined, () => assert.equal(resolveBrokerStdinHandshakeEnabled(), true));
		withGate("1", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), true));
		withGate("true", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), true));
		withGate("0", () => assert.equal(resolveBrokerStdinHandshakeEnabled(), false));
	});
});

// ── Default route: token over stdin, env stays token-free ────────────────

describe("prepareSpawnContext: stdin handshake default (gate on)", () => {
	after(() => {
		delete process.env.PI_CREW_BROKER_STDIN;
	});

	it("omits PI_CREW_BROKER_TOKEN from built.env; SOCKET/RUN_ID/TASK_ID stay", () => {
		withGate(undefined, () => {
			const { builtEnv, dir } = prepWithBroker();
			try {
				assert.equal(builtEnv.PI_CREW_BROKER_TOKEN, undefined, "secret must NOT travel via env on the default route");
				assert.equal(builtEnv.PI_CREW_BROKER_SOCKET, BROKER_SPAWN.socketPath);
				assert.equal(builtEnv.PI_CREW_BROKER_RUN_ID, RUN_ID);
				assert.equal(builtEnv.PI_CREW_BROKER_TASK_ID, AGENT_ID);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("ctx.brokerStdinPayload is ONE v2 line with the exact single-task compound shape", () => {
		withGate(undefined, () => {
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
		withGate(undefined, () => {
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

describe("prepareSpawnContext: rollback gate PI_CREW_BROKER_STDIN=0", () => {
	it("token stays in built.env, NO payload, spawnOptions keep stdin=ignore + env token", () => {
		withGate("0", () => {
			const { ctx, dir } = prepWithBroker();
			try {
				assert.equal(ctx.builtEnv.PI_CREW_BROKER_TOKEN, BROKER_SPAWN.token, "rollback: token via env");
				assert.equal(ctx.brokerStdinPayload, undefined, "rollback: no stdin payload");
				const spawnOptions = buildFinalChildPiSpawnOptions(dir, ctx.mergedEnv, ctx.builtEnv, undefined, undefined, true);
				const stdio = spawnOptions.stdio as string[];
				assert.equal(stdio[0], "ignore", "rollback: stdin stays ignore");
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
		withGate(undefined, () => {
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
		withGate(undefined, () => {
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
