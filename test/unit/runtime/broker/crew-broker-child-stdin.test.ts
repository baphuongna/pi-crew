/**
 * crew-broker-child-stdin.test.ts — LOW-1 residual closure (2026-10-27),
 * worker side: startChildBrokerClientAsync's fd3 fallback.
 *
 * FD-3 TRANSPORT (2026-10-28, root-cause fix): the fallback no longer reads
 * fd0 — pi@1.0.4 readPipedStdin consumes ALL piped fd0 bytes as PROMPT
 * CONTENT in every mode except --mode rpc, so the fd0 handshake raced it
 * three ways (token JSON leaked into the prompt = ordering-2 secret leak;
 * stream-ended creds-less silence; pause() → readPipedStdin deadlock →
 * SIGTERM exit 0 with ~0 stdout = ordering-3, the 0.11.46/47 live
 * incident). The default reader is now stdin-handshake.readFirstLineFromFd(3)
 * on the DEDICATED spawn stdio pipe (child-pi-spawn composes a 4-entry
 * stdio table; fd0 stays "ignore").
 *
 * Matrix pinned here (backward-compat both directions):
 *   1. NEW parent → NEW worker: env has SOCKET/RUN_ID/TASK_ID but NO token
 *      → the single buildBrokerStdinLine payload is read off fd3, validated
 *      against runId + socketPath, and the per-task token reaches the client.
 *   2. OLD parent → NEW worker: env token present → fd3 never read (even
 *      when the gate flag is '1' — the env token always wins).
 *   3. Gate is DEFAULT-ON since the 2026-10-28 flip (was OPT-IN
 *      v0.11.48–0.11.49): PI_CREW_BROKER_STDIN exactly '0' → the fd3
 *      fallback never activates (explicit rollback to the env route);
 *      unset (default) or any other value ARMS it.
 *   4. Garbage / wrong-run / socket-mismatch / missing-task payloads and a
 *      silent fd3 → creds-less NOOP handle, never a throw, caller env never
 *      mutated.
 *   5. RPC-mode argv guard: `--mode rpc` in process.argv → fd3 never read
 *      (stdin is the JSONL protocol channel there; the RPC branch keeps the
 *      env-token route).
 *   6. No broker identity env at all → NOOP without touching any fd.
 *   7. DEFAULT SEAM: without readHandshakeLine injected, the fallback reads
 *      fd 3 — NEVER process.stdin (fd0). With no fd3 pipe in this test
 *      process the read resolves undefined and the worker degrades
 *      creds-less; process.stdin is pinned untouched.
 *
 * Seam (2026-10-28): the gate reads the RESOLVED env (options.env ??
 * process.env) — the same source as the identity vars — so every gate case
 * below injects the flag through options.env. That is exactly the spawn-env
 * delivery shape FIX-1 wires (the spawner re-writes the flag into the
 * child's built.env), and it makes the tests immune to ambient worker-env
 * noise. ONE ambient-compat test mutates process.env to pin the
 * no-options.env branch. Reader-boundary cases near the 64 KiB abort
 * boundary of readStdinFirstLine live here too — the writer-side >60 KiB
 * LOUD warn is pinned in stdin-broker-handshake.test.ts (FIX-3) and is NOT
 * duplicated.
 *
 * All fallback tests inject the fd3 line via the readHandshakeLine seam; the
 * reader-boundary tests swap process.stdin for a fake (descriptor restored
 * in finally) — no real process.stdin is ever consumed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { startChildBrokerClient, startChildBrokerClientAsync } from "../../../../src/runtime/broker/crew-broker-child.ts";
import type { CrewBrokerClient, CrewBrokerClientOptions } from "../../../../src/runtime/broker/crew-broker-client.ts";
import {
	BROKER_HANDSHAKE_FD,
	buildBrokerStdinLine,
	parseStdinBrokerPayload,
	readFirstLineFromFd,
	readStdinFirstLine,
} from "../../../../src/runtime/broker/stdin-handshake.ts";

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

/** Identity env + the DEFAULT-ON gate flag — the exact env shape a brokered
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
			readHandshakeLine: async () => {
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

	it("gate UNSET via options.env (DEFAULT-ON since the 2026-10-28 flip): reads the payload, connects with the per-task token", async () => {
		const captured: CrewBrokerClientOptions[] = [];
		let stdinReads = 0;
		const handle = await startChildBrokerClientAsync({
			env: { ...IDENTITY_ENV }, // no PI_CREW_BROKER_STDIN key at all — default is ON
			readHandshakeLine: async () => {
				stdinReads++;
				return buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN });
			},
			clientFactory: captureFactory(captured),
		});
		assert.equal(stdinReads, 1, "unset gate arms the fallback under DEFAULT-ON");
		assert.equal(captured.length, 1, "client built exactly once");
		assert.equal(captured[0]!.token, TOKEN, "per-task token via fd3 reaches the client");
		await handle.close();
	});

	it("does NOT mutate the caller's env object (token merge lands on a copy)", async () => {
		const callerEnv = { ...GATED_IDENTITY_ENV };
		await startChildBrokerClientAsync({
			env: callerEnv,
			readHandshakeLine: async () => buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN }),
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
			readHandshakeLine: async () => {
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
			readHandshakeLine: async () => {
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
				readHandshakeLine: async () => line,
				clientFactory: captureFactory(captured),
			});
			assert.equal(captured.length, 0, "no client without a token");
			assert.equal(handle.active, false);
			await handle.close();
		});
	}

	it("gate DEFAULT (unset in the injected env) since the 2026-10-28 flip ARMS the fallback — silent fd3 still degrades creds-less", async () => {
		let stdinReads = 0;
		const handle = await startChildBrokerClientAsync({
			env: { ...IDENTITY_ENV }, // gate key entirely absent → DEFAULT-ON since the flip
			readHandshakeLine: async () => {
				stdinReads++;
				return undefined; // silent fd3 (EOF) — the reader RUNS now
			},
			clientFactory: captureFactory([]),
		});
		assert.equal(stdinReads, 1, "unset gate must ARM the stdin fallback (DEFAULT-ON)");
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
				readHandshakeLine: async () => {
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
				readHandshakeLine: async () => {
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
				readHandshakeLine: async () => {
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
			readHandshakeLine: async () => {
				throw new Error("no identity env → nothing to bind, stdin must not be read");
			},
			clientFactory: captureFactory([]),
		});
		assert.equal(handle.active, false);
		await handle.close();
	});
});

// ── 6b. DEFAULT SEAM: fd3, never fd0 ────────────────────────────────────
//
// Without the readHandshakeLine seam, the fallback must read fd 3 (the
// dedicated spawn stdio pipe) — NEVER process.stdin/fd0: pi@1.0.4
// readPipedStdin owns fd0 and consumed ALL piped stdin as PROMPT CONTENT
// (the 0.11.46/47 silent-death + token-leak root cause). In this test
// process there is no fd3 spawn pipe, so the bounded reader resolves
// undefined and the handle degrades creds-less — process.stdin untouched.

describe("startChildBrokerClientAsync: default handshake transport is fd3 (never fd0)", () => {
	it("no seam + gate '1' + identity + no env token → bounded fd3 read, creds-less NOOP here, process.stdin untouched", async () => {
		// A stdin stand-in that FAILS the test if anything subscribes to it.
		const tripwire = {
			isTTY: false,
			destroyed: false,
			readable: true,
			on: (event: string): void => {
				throw new Error(`fd0 must never be read by the fd3 fallback (got process.stdin on('${event}'))`);
			},
			removeListener: (): void => undefined,
			pause: (): void => undefined,
		};
		const desc = Object.getOwnPropertyDescriptor(process, "stdin");
		if (!desc) throw new Error("process.stdin descriptor missing — cannot install the tripwire");
		Object.defineProperty(process, "stdin", { value: tripwire, writable: true, enumerable: desc.enumerable, configurable: true });
		try {
			const captured: CrewBrokerClientOptions[] = [];
			const handle = await startChildBrokerClientAsync({
				env: { ...GATED_IDENTITY_ENV },
				clientFactory: captureFactory(captured),
			});
			assert.equal(captured.length, 0, "no fd3 pipe in this process → creds-less NOOP, never a throw");
			assert.equal(handle.active, false);
			await handle.close();
		} finally {
			Object.defineProperty(process, "stdin", desc);
		}
	});

	it("BROKER_HANDSHAKE_FD is 3 (spawn stdio entry 4 — the compose contract child-pi-spawn pins)", () => {
		assert.equal(BROKER_HANDSHAKE_FD, 3);
	});
});

// ── 6c. readFirstLineFromFd: fd mechanics (file-backed fds) ─────────────
//
// The newline/oversize/timeout logic is the shared readFirstLineFromStream
// core already pinned by the readStdinFirstLine boundary tests below; these
// pin the fd PLUMBING: a real fd delivers the first line (exactly like the
// fd3 spawn pipe), an empty EOF fd resolves undefined fast, a CLOSED fd
// resolves undefined (never throws — old-parent skew: gate flag set but no
// 4th stdio entry), and a >64 KiB no-newline fd aborts undefined.

// win32: readFirstLineFromFd short-circuits to undefined by design (the fd3
// spawn pipe + fs fd-stream semantics are POSIX-only; brokered spawn is
// auto-disabled on Windows anyway) — the fd PLUMBING subtests are POSIX-only.
describe("readFirstLineFromFd: fd mechanics (worker-side fd3 reader)", { skip: process.platform === "win32" }, () => {
	it("file-backed fd with a valid line → first line delivered, trailing bytes ignored", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fd3-read-"));
		try {
			const file = path.join(dir, "payload.txt");
			fs.writeFileSync(file, `${buildBrokerStdinLine(RUN, SOCKET, { [TASK]: TOKEN })}TRAILING-GARBAGE-AFTER-FIRST-LINE\n`);
			const fd = fs.openSync(file, "r");
			try {
				const raw = await readFirstLineFromFd(fd, 1000);
				const parsed = raw ? parseStdinBrokerPayload(raw, RUN) : undefined;
				assert.ok(parsed, "file-backed fd must deliver the full first line");
				assert.equal(parsed!.tasks[TASK], TOKEN);
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("empty EOF fd → undefined (creds-less downstream), fast — no timeout wait", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fd3-read-"));
		try {
			const file = path.join(dir, "empty.txt");
			fs.writeFileSync(file, "");
			const fd = fs.openSync(file, "r");
			const t0 = Date.now();
			try {
				assert.equal(await readFirstLineFromFd(fd, 1000), undefined);
				assert.ok(Date.now() - t0 < 900, `EOF must resolve without waiting the timeout (took ${Date.now() - t0}ms)`);
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("CLOSED fd → undefined, never a throw (old-parent skew: flag set but no 4th stdio entry)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fd3-read-"));
		try {
			const file = path.join(dir, "x.txt");
			fs.writeFileSync(file, "irrelevant\n");
			const fd = fs.openSync(file, "r");
			fs.closeSync(fd);
			assert.equal(await readFirstLineFromFd(fd, 500), undefined);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it(">64 KiB with NO newline → aborts undefined (same cap as readStdinFirstLine)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fd3-read-"));
		try {
			const file = path.join(dir, "oversize.txt");
			fs.writeFileSync(file, "x".repeat(70 * 1024));
			const fd = fs.openSync(file, "r");
			try {
				assert.equal(await readFirstLineFromFd(fd, 1000), undefined);
			} finally {
				fs.closeSync(fd);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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
