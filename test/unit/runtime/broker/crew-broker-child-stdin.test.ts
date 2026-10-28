/**
 * crew-broker-child-stdin.test.ts — LOW-1 residual closure (2026-10-27),
 * worker side: startChildBrokerClientAsync's stdin fallback.
 *
 * Matrix pinned here (backward-compat both directions):
 *   1. NEW parent → NEW worker: env has SOCKET/RUN_ID/TASK_ID but NO token
 *      → the single buildBrokerStdinLine payload is read off stdin, validated
 *      against runId + socketPath, and the per-task token reaches the client.
 *   2. OLD parent → NEW worker: env token present → stdin NEVER read (even
 *      when the gate flag is '1' — the env token always wins).
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
 * Seam (2026-10-28): the gate reads the RESOLVED env (options.env ??
 * process.env) — the same source as the identity vars — so every gate case
 * below injects the flag through options.env. That is exactly the spawn-env
 * delivery shape FIX-1 wires (the spawner re-writes the flag into the
 * child's built.env), and it makes the tests immune to ambient worker-env
 * noise. ONE ambient-compat test mutates process.env to pin the
 * no-options.env branch. Reader-size cases near the 64 KiB abort boundary of
 * readStdinFirstLine live here too — the writer-side >60 KiB LOUD warn is
 * pinned in stdin-broker-handshake.test.ts (FIX-3) and is NOT duplicated.
 *
 * All fallback tests inject the stdin line via the readStdinLine seam; the
 * reader-boundary tests swap process.stdin for a fake (descriptor restored in
 * finally) — no real process.stdin is ever consumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startChildBrokerClient, startChildBrokerClientAsync } from "../../../../src/runtime/broker/crew-broker-child.ts";
import type { CrewBrokerClient, CrewBrokerClientOptions } from "../../../../src/runtime/broker/crew-broker-client.ts";
import { buildBrokerStdinLine, parseStdinBrokerPayload, readStdinFirstLine } from "../../../../src/runtime/broker/stdin-handshake.ts";

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

/** Identity env + the OPT-IN gate flag — the exact env shape a brokered
 *  spawn carries under FIX-1 (flag re-written into built.env; the token is
 *  the only piece stripped, and only for headless JSON workers). */
const GATED_IDENTITY_ENV: Record<string, string> = {
	...IDENTITY_ENV,
	PI_CREW_BROKER_STDIN: "1",
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

/** The ONE place this file may touch process.env: pins the no-options.env
 *  branch of the gate (process.env is a real worker's only env source).
 *  Saves every broker key first and restores AFTER the awaited body settles
 *  (2026-10-06 lesson: restore must not race async bodies). Ambient worker
 *  env may carry a broker token — it is always deleted for the body's
 *  duration so the pinned branch is deterministic. */
async function withAmbientBrokerEnv(gateValue: string | undefined, fn: () => Promise<void> | void): Promise<void> {
	const keys = [
		"PI_CREW_BROKER_STDIN",
		"PI_CREW_BROKER_SOCKET",
		"PI_CREW_BROKER_RUN_ID",
		"PI_CREW_BROKER_TASK_ID",
		"PI_CREW_BROKER_TOKEN",
	];
	const saved = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
	try {
		process.env.PI_CREW_BROKER_SOCKET = SOCKET;
		process.env.PI_CREW_BROKER_RUN_ID = RUN;
		process.env.PI_CREW_BROKER_TASK_ID = TASK;
		delete process.env.PI_CREW_BROKER_TOKEN;
		if (gateValue === undefined) delete process.env.PI_CREW_BROKER_STDIN;
		else process.env.PI_CREW_BROKER_STDIN = gateValue;
		await fn();
	} finally {
		for (const [key, prev] of saved) {
			if (prev === undefined) delete process.env[key];
			else process.env[key] = prev;
		}
	}
}

// ── 1. The fallback itself ───────────────────────────────────────────────

describe("startChildBrokerClientAsync: stdin fallback (env token absent)", () => {
	it("gate '1' via options.env: reads the payload, binds runId+socket, connects with the per-task token", async () => {
		const captured: CrewBrokerClientOptions[] = [];
		let stdinReads = 0;
		const handle = await startChildBrokerClientAsync({
			env: { ...GATED_IDENTITY_ENV },
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

	it("does NOT mutate the caller's env object (token merge lands on a copy)", async () => {
		const callerEnv = { ...GATED_IDENTITY_ENV };
		await startChildBrokerClientAsync({
			env: callerEnv,
			readStdinLine: async () => buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN }),
			clientFactory: captureFactory([]),
		});
		assert.equal(callerEnv.PI_CREW_BROKER_TOKEN, undefined, "caller env must stay token-free");
	});
});

// ── 2/3. Env-token priority (old parent / rollback gate) ────────────────

describe("startChildBrokerClientAsync: env token wins, stdin untouched", () => {
	it("OLD parent → NEW worker: env token present → stdin never read (even with the gate '1')", async () => {
		const captured: CrewBrokerClientOptions[] = [];
		const handle = await startChildBrokerClientAsync({
			env: { ...IDENTITY_ENV, PI_CREW_BROKER_STDIN: "1", PI_CREW_BROKER_TOKEN: "legacy-env-token" },
			readStdinLine: async () => {
				throw new Error("stdin must NOT be read when the env token is present");
			},
			clientFactory: captureFactory(captured),
		});
		assert.equal(captured[0]!.token, "legacy-env-token");
		await handle.close();
	});

	it("gate '0' via options.env + missing env token → stdin fallback disabled (creds-less)", async () => {
		const handle = await startChildBrokerClientAsync({
			env: { ...IDENTITY_ENV, PI_CREW_BROKER_STDIN: "0" },
			readStdinLine: async () => {
				throw new Error("gate=0 must disable the stdin fallback");
			},
			clientFactory: captureFactory([]),
		});
		assert.equal(handle.active, false, "creds-less NOOP handle");
		await handle.close();
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
			const captured: CrewBrokerClientOptions[] = [];
			const handle = await startChildBrokerClientAsync({
				env: { ...GATED_IDENTITY_ENV },
				readStdinLine: async () => line,
				clientFactory: captureFactory(captured),
			});
			assert.equal(captured.length, 0, "no client without a token");
			assert.equal(handle.active, false);
			await handle.close();
		});
	}

	it("gate DEFAULT (unset in the injected env) since v0.11.48 + missing env token → stdin fallback disabled (creds-less)", async () => {
		const handle = await startChildBrokerClientAsync({
			env: { ...IDENTITY_ENV }, // gate key entirely absent → opt-out default
			readStdinLine: async () => {
				throw new Error("unset gate must disable the stdin fallback");
			},
			clientFactory: captureFactory([]),
		});
		assert.equal(handle.active, false, "creds-less NOOP handle");
		await handle.close();
	});

	it("sync startChildBrokerClient keeps its exact env-only contract (gate flag irrelevant, stdin never read)", () => {
		const captured: CrewBrokerClientOptions[] = [];
		const handle = startChildBrokerClient({
			env: { ...GATED_IDENTITY_ENV }, // no token → must be a plain NOOP, no stdin read
			clientFactory: captureFactory(captured),
		});
		assert.equal(captured.length, 0);
		assert.equal(handle.active, false);
	});
});

// ── 4b. Ambient compat: the ONE process.env-pinning test ────────────────
//
// The gate must read options.env ?? process.env. Everything above pins the
// options.env side; this block pins the process.env side — the only source a
// real worker has (the spawner delivers the flag via built.env → child
// process.env, FIX-1). No options.env is passed here on purpose.

describe("startChildBrokerClientAsync: ambient compat (no options.env → gate reads process.env)", () => {
	it("ambient PI_CREW_BROKER_STDIN='1' + identity, no ambient token → fallback arms off process.env (spawn-env delivery)", async () => {
		await withAmbientBrokerEnv("1", async () => {
			const captured: CrewBrokerClientOptions[] = [];
			let stdinReads = 0;
			const handle = await startChildBrokerClientAsync({
				readStdinLine: async () => {
					stdinReads++;
					return buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN });
				},
				clientFactory: captureFactory(captured),
			});
			assert.equal(stdinReads, 1, "ambient gate '1' must arm the stdin fallback");
			assert.equal(captured.length, 1, "client built once from ambient identity");
			assert.equal(captured[0]!.token, TOKEN, "per-task token still reaches the client");
			await handle.close();
		});
	});
});

// ── 5/6. Guards: rpc argv + no identity env ─────────────────────────────

describe("startChildBrokerClientAsync: stdin-safety guards", () => {
	it("RPC-mode argv (--mode rpc) → stdin never read", async () => {
		const prevArgv = process.argv;
		process.argv = [...prevArgv, "--mode", "rpc"];
		try {
			const handle = await startChildBrokerClientAsync({
				env: { ...GATED_IDENTITY_ENV },
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

	it("FIX-2: RPC-mode argv equals-form (--mode=rpc) → stdin never read", async () => {
		const prevArgv = process.argv;
		// The pi-args builder emits the two-argv form ("--mode rpc"), but
		// wrappers/users can pass the equals form — before FIX-2 only the
		// two-argv form matched and a "--mode=rpc" worker would have its
		// protocol channel eaten by the credential fallback.
		process.argv = [...prevArgv, "--mode=rpc"];
		try {
			const handle = await startChildBrokerClientAsync({
				env: { ...GATED_IDENTITY_ENV },
				readStdinLine: async () => {
					throw new Error("equals-form --mode=rpc must be detected as RPC mode — stdin must never be read");
				},
				clientFactory: captureFactory([]),
			});
			assert.equal(handle.active, false);
			await handle.close();
		} finally {
			process.argv = prevArgv;
		}
	});

	it("no broker identity env at all (gate ON) → NOOP without reading stdin", async () => {
		const handle = await startChildBrokerClientAsync({
			env: { PI_CREW_BROKER_STDIN: "1" }, // gate on, but zero identity → nothing to bind
			readStdinLine: async () => {
				throw new Error("no identity env → nothing to bind, stdin must not be read");
			},
			clientFactory: captureFactory([]),
		});
		assert.equal(handle.active, false);
		await handle.close();
	});
});

// ── 7. Reader abort boundary (64 KiB) ───────────────────────────────────
//
// Complements the writer-side >60 KiB LOUD-warn pinned in
// stdin-broker-handshake.test.ts (FIX-3): there the WRITER warns; here the
// READER must still deliver every byte of the first line up to (and exactly
// at) the 64 KiB cap, and silently drop once the pre-newline buffer passes
// it. readStdinFirstLine runs on the REAL process.stdin in production, so
// these tests swap it for a fake (the configurable getter descriptor is
// saved and re-installed in finally — no real stdin is ever consumed).

type FakeStdinHandler = (chunk?: Buffer | string) => void;

/** Minimal process.stdin stand-in exposing only the surface readStdinFirstLine
 *  touches: isTTY/destroyed/readable + on/removeListener/pause. */
function makeFakeStdin(): { emit: (event: string, chunk?: Buffer | string) => void; pauseCount: () => number; stdin: unknown } {
	const listeners = new Map<string, Set<FakeStdinHandler>>();
	let pauses = 0;
	return {
		emit: (event: string, chunk?: Buffer | string): void => {
			for (const handler of listeners.get(event) ?? []) handler(chunk);
		},
		pauseCount: (): number => pauses,
		stdin: {
			isTTY: false,
			destroyed: false,
			readable: true,
			on: (event: string, handler: FakeStdinHandler): void => {
				const set = listeners.get(event) ?? new Set<FakeStdinHandler>();
				set.add(handler);
				listeners.set(event, set);
			},
			removeListener: (event: string, handler: FakeStdinHandler): void => {
				listeners.get(event)?.delete(handler);
			},
			pause: (): void => {
				pauses++;
			},
		},
	};
}

/** Swap process.stdin for `fake` around the SYNCHRONOUS start of `fn`
 *  (readStdinFirstLine attaches its listeners in its promise executor, so
 *  `fn` may just return the pending promise and emit afterwards). */
function withFakeStdin<T>(fake: unknown, fn: () => T): T {
	const desc = Object.getOwnPropertyDescriptor(process, "stdin");
	if (!desc) throw new Error("process.stdin descriptor missing — cannot install the fake stdin");
	Object.defineProperty(process, "stdin", { value: fake, writable: true, enumerable: desc.enumerable, configurable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "stdin", desc);
	}
}

/** A PROTOCOL-VALID v2 handshake line whose length lands in
 *  [minLength, minLength + ~1 KiB): token padding controls the size and the
 *  line stays parseable (parseStdinBrokerPayload validates every entry). */
function sizedValidLine(minLength: number): string {
	let pad = minLength;
	for (;;) {
		const line = `${JSON.stringify({ v: 2, runId: RUN, socketPath: SOCKET, tasks: { [TASK]: TOKEN, pad: "p".repeat(pad) } })}\n`;
		if (line.length >= minLength) return line;
		pad += 1024;
	}
}

describe("readStdinFirstLine: 64 KiB abort boundary (worker-side reader)", () => {
	it("fragmented ~61 KiB line (inside the writer-warn zone, under the cap) → full line delivered + parseable, stdin paused not destroyed", async () => {
		const fake = makeFakeStdin();
		const line = sizedValidLine(61 * 1024);
		assert.ok(line.length > 60 * 1024, `fixture must sit in the writer-warn zone (got ${line.length})`);
		assert.ok(line.length < 64 * 1024, `fixture must stay under the reader cap (got ${line.length})`);
		const read = withFakeStdin(fake.stdin, () => readStdinFirstLine(500));
		for (let off = 0; off < line.length; off += 7 * 1024) {
			fake.emit("data", line.slice(off, off + 7 * 1024));
		}
		const raw = await read;
		assert.equal(raw, line.slice(0, -1), "reader must return the whole pre-newline line");
		assert.equal(fake.pauseCount(), 1, "reader pauses stdin after the first line (never destroys it)");
		const parsed = raw ? parseStdinBrokerPayload(raw, RUN) : undefined;
		assert.ok(parsed, "an under-cap payload is still protocol-valid");
		assert.equal(parsed!.tasks[TASK], TOKEN, "the per-task token survives — the worker connects");
	});

	it("exactly 64 KiB before the newline → still delivered (the cap is strictly greater-than)", async () => {
		const fake = makeFakeStdin();
		const first = "z".repeat(64 * 1024); // exactly the cap — one byte short of the abort
		const read = withFakeStdin(fake.stdin, () => readStdinFirstLine(500));
		fake.emit("data", first); // no newline yet, buffer === cap → keep waiting
		fake.emit("data", "\n"); // newline lands at 64 KiB + 1
		const raw = await read;
		assert.equal(raw, first, "a first line of exactly 64 KiB is delivered");
		assert.equal(fake.pauseCount(), 1);
	});

	it("single >64 KiB chunk with NO newline → aborts to undefined (creds-less no-op downstream)", async () => {
		const fake = makeFakeStdin();
		const read = withFakeStdin(fake.stdin, () => readStdinFirstLine(500));
		fake.emit("data", Buffer.from("x".repeat(70 * 1024)));
		const raw = await read;
		assert.equal(raw, undefined, "past the 64 KiB cap with no newline the reader aborts");
		assert.equal(fake.pauseCount(), 0, "abort path does not pause (nothing was consumed as a line)");
	});

	it("fragmented chunks crossing the boundary BEFORE any newline → aborts; a later newline cannot resurrect it", async () => {
		const fake = makeFakeStdin();
		const read = withFakeStdin(fake.stdin, () => readStdinFirstLine(500));
		fake.emit("data", "y".repeat(60 * 1024)); // under the cap, no newline → keep reading
		fake.emit("data", "y".repeat(8 * 1024)); // cumulative 68 KiB > cap, still no newline → ABORT
		assert.equal(await read, undefined, "crossing 64 KiB before any newline aborts");
		fake.emit("data", "tail\n"); // settled promise must ignore late data
		assert.equal(fake.pauseCount(), 0, "no line was ever consumed");
	});
});
