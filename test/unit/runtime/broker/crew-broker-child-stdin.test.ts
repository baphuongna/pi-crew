/**
 * crew-broker-child-stdin.test.ts — LOW-1 residual closure (2026-10-27),
 * worker side: startChildBrokerClientAsync's stdin fallback.
 *
 * Matrix pinned here (backward-compat both directions):
 *   1. NEW parent → NEW worker: env has SOCKET/RUN_ID/TASK_ID but NO token
 *      → the single buildBrokerStdinLine payload is read off stdin, validated
 *      against runId + socketPath, and the per-task token reaches the client.
 *   2. OLD parent → NEW worker: env token present → stdin NEVER read.
 *   3. Gate is OPT-IN since v0.11.48: PI_CREW_BROKER_STDIN unset (default)
 *      or '0' → the stdin fallback never activates (env route is the default
 *      again; '1' opts in).
 *   4. Garbage / wrong-run / socket-mismatch / missing-task payloads and a
 *      silent stdin → creds-less NOOP handle, never a throw, caller env never
 *      mutated.
 *   5. RPC-mode argv guard: `--mode rpc` in process.argv → stdin never read
 *      (stdin is the JSONL protocol channel there).
 *   6. No broker identity env at all → NOOP without touching stdin.
 *
 * All tests inject the stdin line via the readStdinLine seam — no real
 * process.stdin is consumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type StartChildBrokerClientOptions,
	startChildBrokerClient,
	startChildBrokerClientAsync,
} from "../../../../src/runtime/broker/crew-broker-child.ts";
import type { CrewBrokerClient, CrewBrokerClientOptions } from "../../../../src/runtime/broker/crew-broker-client.ts";
import { buildBrokerStdinLine } from "../../../../src/runtime/broker/stdin-handshake.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

const RUN = "run_stdin_child";
const SOCKET = "/tmp/crew-stdin-child-test.sock";
const TASK = "task-stdin-child";
const TOKEN = "compound-stdin-token";

const IDENTITY_ENV: Record<string, string> = {
	PI_CREW_BROKER_SOCKET: SOCKET,
	PI_CREW_BROKER_RUN_ID: RUN,
	PI_CREW_BROKER_TASK_ID: TASK,
};

/** Minimal CrewBrokerClient stand-in: capture what the wrapper decided to
 * connect with. Never touches a socket. */
function captureFactory(captured: CrewBrokerClientOptions[]) {
	return (opts: CrewBrokerClientOptions): CrewBrokerClient => {
		captured.push(opts);
		return {
			mode: "fallback",
			reconnect: async () => false,
			close: async () => undefined,
		} as unknown as CrewBrokerClient;
	};
}

function opts(overrides: Partial<StartChildBrokerClientOptions> = {}): StartChildBrokerClientOptions {
	return { clientFactory: captureFactory([]), ...overrides };
}

/** Scrub the gate var so ambient worker-env noise cannot flip the branch.
 * Awaitable: async bodies run to completion BEFORE the env is restored. */
async function withGate(value: string | undefined, fn: () => Promise<void> | void): Promise<void> {
	const prev = process.env.PI_CREW_BROKER_STDIN;
	try {
		if (value === undefined) delete process.env.PI_CREW_BROKER_STDIN;
		else process.env.PI_CREW_BROKER_STDIN = value;
		await fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_BROKER_STDIN;
		else process.env.PI_CREW_BROKER_STDIN = prev;
	}
}

// ── 1. The fallback itself ───────────────────────────────────────────────

describe("startChildBrokerClientAsync: stdin fallback (env token absent)", () => {
	it("reads the payload, binds runId+socket, and connects with the per-task token", async () => {
		await withGate("1", async () => {
			const captured: CrewBrokerClientOptions[] = [];
			let stdinReads = 0;
			const handle = await startChildBrokerClientAsync({
				env: { ...IDENTITY_ENV },
				readStdinLine: async () => {
					stdinReads++;
					return buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN });
				},
				clientFactory: captureFactory(captured),
			});
			assert.equal(stdinReads, 1, "exactly one bounded stdin read");
			assert.equal(captured.length, 1, "client built exactly once");
			assert.equal(captured[0]!.token, TOKEN, "compound token from stdin must reach the client");
			assert.equal(captured[0]!.runId, RUN);
			assert.equal(captured[0]!.taskId, TASK);
			assert.equal(captured[0]!.socketPath, SOCKET);
			assert.equal(handle.active, false, "fake client never connects — handle reports not-active");
			await handle.close();
		});
	});

	it("does NOT mutate the caller's env object (token merge lands on a copy)", async () => {
		await withGate("1", async () => {
			const callerEnv = { ...IDENTITY_ENV };
			await startChildBrokerClientAsync({
				env: callerEnv,
				readStdinLine: async () => buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN }),
				clientFactory: captureFactory([]),
			});
			assert.equal(callerEnv.PI_CREW_BROKER_TOKEN, undefined, "caller env must stay token-free");
		});
	});
});

// ── 2/3. Env-token priority (old parent / rollback gate) ────────────────

describe("startChildBrokerClientAsync: env token wins, stdin untouched", () => {
	it("OLD parent → NEW worker: env token present → stdin never read", async () => {
		await withGate(undefined, async () => {
			const captured: CrewBrokerClientOptions[] = [];
			const handle = await startChildBrokerClientAsync({
				env: { ...IDENTITY_ENV, PI_CREW_BROKER_TOKEN: "legacy-env-token" },
				readStdinLine: async () => {
					throw new Error("stdin must NOT be read when the env token is present");
				},
				clientFactory: captureFactory(captured),
			});
			assert.equal(captured[0]!.token, "legacy-env-token");
			await handle.close();
		});
	});

	it("gate OFF (default unset / explicit 0) + missing env token → stdin fallback disabled (creds-less)", async () => {
		await withGate("0", async () => {
			const handle = await startChildBrokerClientAsync({
				env: { ...IDENTITY_ENV },
				readStdinLine: async () => {
					throw new Error("gate=0 must disable the stdin fallback");
				},
				clientFactory: captureFactory([]),
			});
			assert.equal(handle.active, false, "creds-less NOOP handle");
			await handle.close();
		});
	});
});

// ── 4. Invalid payloads → creds-less NOOP, never a throw ────────────────

describe("startChildBrokerClientAsync: invalid payloads fall back creds-less", () => {
	const cases: Array<[string, string | undefined]> = [
		["garbage line", "not-json-at-all"],
		["wrong version", buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN }).replace('"v":2', '"v":3')],
		["wrong runId (cross-run containment)", buildBrokerStdinLine("run_OTHER", SOCKET, { [TASK]: TOKEN })],
		["socket mismatch", buildBrokerStdinLine(RUN, "/tmp/other.sock", { [TASK]: TOKEN })],
		["missing task entry", buildBrokerStdinLine(RUN, SOCKET, { "other-task": TOKEN })],
		["empty tasks map", buildBrokerStdinLine(RUN, SOCKET, {})],
		["silent stdin (timeout/EOF)", undefined],
	];

	for (const [name, line] of cases) {
		it(`${name} → NOOP handle, no throw, factory not invoked`, async () => {
			await withGate("1", async () => {
				const captured: CrewBrokerClientOptions[] = [];
				const handle = await startChildBrokerClientAsync({
					env: { ...IDENTITY_ENV },
					readStdinLine: async () => line,
					clientFactory: captureFactory(captured),
				});
				assert.equal(captured.length, 0, "no client without a token");
				assert.equal(handle.active, false);
				await handle.close();
			});
		});
	}

	it("gate DEFAULT (unset) since v0.11.48 + missing env token → stdin fallback disabled (creds-less)", async () => {
		await withGate(undefined, async () => {
			const handle = await startChildBrokerClientAsync({
				env: { ...IDENTITY_ENV },
				readStdinLine: async () => {
					throw new Error("gate=0 must disable the stdin fallback");
				},
				clientFactory: captureFactory([]),
			});
			assert.equal(handle.active, false, "creds-less NOOP handle");
			await handle.close();
		});
	});
});

// ── 4. Invalid payloads → creds-less NOOP, never a throw ────────────────

describe("startChildBrokerClientAsync: invalid payloads fall back creds-less", () => {
	const cases: Array<[string, string | undefined]> = [
		["garbage line", "not-json-at-all"],
		["wrong version", buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN }).replace('"v":2', '"v":3')],
		["wrong runId (cross-run containment)", buildBrokerStdinLine("run_OTHER", SOCKET, { [TASK]: TOKEN })],
		["socket mismatch", buildBrokerStdinLine(RUN, "/tmp/other.sock", { [TASK]: TOKEN })],
		["missing task entry", buildBrokerStdinLine(RUN, SOCKET, { "other-task": TOKEN })],
		["empty tasks map", buildBrokerStdinLine(RUN, SOCKET, {})],
		["silent stdin (timeout/EOF)", undefined],
	];

	for (const [name, line] of cases) {
		it(`${name} → NOOP handle, no throw, factory not invoked`, async () => {
			await withGate("1", async () => {
				const captured: CrewBrokerClientOptions[] = [];
				const handle = await startChildBrokerClientAsync({
					env: { ...IDENTITY_ENV },
					readStdinLine: async () => line,
					clientFactory: captureFactory(captured),
				});
				assert.equal(captured.length, 0, "no client without a token");
				assert.equal(handle.active, false);
				await handle.close();
			});
		});
	}

	it("sync startChildBrokerClient keeps its exact env-only contract (untouched by this change)", () => {
		const captured: CrewBrokerClientOptions[] = [];
		const handle = startChildBrokerClient({
			env: { ...IDENTITY_ENV }, // no token → must be a plain NOOP, no stdin read
			clientFactory: captureFactory(captured),
		});
		assert.equal(captured.length, 0);
		assert.equal(handle.active, false);
	});
});

// ── 5/6. Guards: rpc argv + no identity env ─────────────────────────────

describe("startChildBrokerClientAsync: stdin-safety guards", () => {
	it("RPC-mode argv (--mode rpc) → stdin never read", async () => {
		await withGate("1", async () => {
			const prevArgv = process.argv;
			process.argv = [...prevArgv, "--mode", "rpc"];
			try {
				const handle = await startChildBrokerClientAsync({
					env: { ...IDENTITY_ENV },
					readStdinLine: async () => {
						throw new Error("RPC-mode workers own stdin — must never read it");
					},
					clientFactory: captureFactory([]),
				});
				assert.equal(handle.active, false);
				await handle.close();
			} finally {
				process.argv = prevArgv;
			}
		});
	});

	it("no broker identity env at all → NOOP without reading stdin", async () => {
		await withGate(undefined, async () => {
			const handle = await startChildBrokerClientAsync({
				env: {},
				readStdinLine: async () => {
					throw new Error("no identity env → nothing to bind, stdin must not be read");
				},
				clientFactory: captureFactory([]),
			});
			assert.equal(handle.active, false);
			await handle.close();
		});
	});
});
