/**
 * broker-stdin-reader-liveworker.test.ts — LIVE regression test for the
 * v0.11.46/v0.11.47 silent-worker death (caught by the real-test-pi-crew T7
 * battery on 2026-10-28, NOT by CI — unit tests inject the readHandshakeLine
 * seam and never run the fd reader inside a real pi process).
 *
 * ROOT CAUSE (2026-10-28): pi@1.0.4 `readPipedStdin()` (dist/main.js:52-65)
 * consumes ALL piped stdin (fd0) as PROMPT CONTENT in every mode except
 * --mode rpc, awaited after extension load — so the v0.11.46 handshake that
 * wrote the broker payload to fd0 raced it three ways (token JSON merged
 * into the prompt = secret leak; stream-ended creds-less silence; reader
 * pause() before EOF → readPipedStdin deadlock → SIGTERM exit 0 with
 * takeOverStdout buffering stdout to ~0 bytes). The fix moves the handshake
 * to a DEDICATED fd3 pipe (stdio entry 4; fd0 back to "ignore").
 *
 * Test shape mirrors the real worker spawn (worker env captured from a live
 * fast-fix run: thin allowlist env + broker identity, stdin untouched):
 *
 *   1. DEFAULT (gate unset): worker must produce stdout (session event) —
 *      the silent exit-0 is the regression this file pins. Since the
 *      2026-10-28 DEFAULT-ON flip the unset gate ARMS the fd3 reader; with
 *      no fd3 pipe in this shape (3-entry stdio) the bounded reader
 *      resolves undefined (missing-fd contract) and the worker degrades
 *      creds-less — still alive.
 *   2. Guard: `pi` binary unavailable (CI containers) → skip, not fail —
 *      this test runs wherever a real pi host exists (dev boxes, the
 *      real-test battery). The unit suites remain the CI gate.
 *   3. DEFAULT-ON (gate UNSET) + fd3 payload: the LIVE DEFAULT pin of the
 *      2026-10-28 flip — the armed-by-default reader consumes the fd3
 *      payload in a REAL pi process: worker stays alive, token never leaks.
 *   4. Explicit gate '1' + fd3 payload: same shape, explicit opt value —
 *      post-root-cause the handshake rides the DEDICATED stdio[3] pipe
 *      (fd0 = "ignore"), so the worker MUST stay alive (non-zero stdout,
 *      no silent exit-0) and the handshake token must NEVER appear in
 *      stdout/stderr (the ordering-2 leak shape: pi merging the payload
 *      into the prompt would echo it in the session transcript). THIS IS
 *      THE LIVE ROOT-CAUSE-FIX ASSERTION — the unit suites only pin the
 *      composed stdio table + seam behavior.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBrokerStdinLine } from "../../src/runtime/broker/stdin-handshake.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPT_RUNTIME = path.join(REPO_ROOT, "src/prompt/prompt-runtime.ts");
const LIVENESS_RUN = "run_liveworker_regression";
const LIVENESS_TASK = "01_explore";
const LIVENESS_SOCKET = "/tmp/pi-crew-liveworker-dead.sock";

/** Real `pi` on PATH? (CI containers run the fake-pi fixtures instead.) */
function piAvailable(): boolean {
	const res = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
	return res.status === 0 || /pi\s+\d/i.test(res.stdout ?? "");
}

interface LiveRun {
	exitCode: number | null;
	stdoutBytes: number;
	/** Bounded stdout tail (leak-grep surface). */
	stdoutTail: string;
	stderrTail: string;
}

/** Spawn a real headless JSON worker with the exact env shape that died:
 * thin allowlist-style env + broker identity, no token, stdin ignored.
 * `fd3Payload` mirrors the fixed spawn shape: a 4-entry stdio table
 * (fd0 "ignore" + dedicated fd3 pipe) with the payload written to stdio[3]. */
function runLiveWorker(envExtra: Record<string, string>, fd3Payload?: string): Promise<LiveRun> {
	return new Promise((resolve, reject) => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "pi-crew-liveworker-"));
		const taskFile = path.join(dir, "task.md");
		writeFileSync(taskFile, "Reply with exactly one word: ALIVE\n");
		const env: NodeJS.ProcessEnv = {
			HOME: process.env.HOME,
			PATH: process.env.PATH,
			LANG: process.env.LANG ?? "en_US.UTF-8",
			TERM: process.env.TERM ?? "xterm-256color",
			TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
			XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
			NVM_DIR: process.env.NVM_DIR,
			// broker identity (worker shape) — SOCKET/RUN_ID/TASK_ID present…
			PI_CREW_BROKER_SOCKET: LIVENESS_SOCKET,
			PI_CREW_BROKER_RUN_ID: LIVENESS_RUN,
			PI_CREW_BROKER_TASK_ID: LIVENESS_TASK,
			// …and NO PI_CREW_BROKER_TOKEN (the opt-in fd3 route).
			...envExtra,
		};
		delete env.PI_CREW_BROKER_TOKEN;
		const child = spawn(
			"pi",
			[
				"--mode",
				"json",
				"-p",
				"--extension",
				PROMPT_RUNTIME,
				"--no-extensions",
				"--session-id",
				"crew-liveworker-regression",
				"--name",
				"crew-liveworker",
				`@${taskFile}`,
			],
			{
				env,
				// fd3 shape when the handshake payload rides the dedicated pipe —
				// exactly what child-pi.ts composes post-fix (fd0 stays ignore).
				stdio: fd3Payload !== undefined ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
				cwd: REPO_ROOT,
			},
		);
		if (fd3Payload !== undefined) {
			// Mirror of the child-pi.ts write site: best-effort, error-safe.
			const fd3 = child.stdio[3] as { write: (s: string) => boolean; end: () => void } | null;
			try {
				fd3?.write(fd3Payload);
			} catch {
				/* best-effort */
			}
			try {
				fd3?.end();
			} catch {
				/* EPIPE */
			}
		}
		let stdoutBytes = 0;
		let stdoutTail = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("live worker hung >90s"));
		}, 90_000);
		child.stdout?.on("data", (d: Buffer) => {
			stdoutBytes += d.length;
			stdoutTail = (stdoutTail + d.toString()).slice(-64 * 1024);
		});
		child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-64 * 1024)));
		child.on("error", (e) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			resolve({ exitCode: code, stdoutBytes, stdoutTail, stderrTail: stderr.slice(-200) });
		});
	});
}

test("live worker (real pi): default broker env must NOT silently exit with zero stdout", { skip: !piAvailable() }, async () => {
	const run = await runLiveWorker({});
	// The v0.11.46/v0.11.47 regression: exit 0 with 0 stdout bytes in ~1s.
	// Since the 2026-10-28 DEFAULT-ON flip the unset gate ARMS the fd3
	// reader; this shape has NO fd3 pipe (3-entry stdio — old-parent skew),
	// so the bounded missing-fd read resolves undefined and the worker
	// streams its session + agent events creds-less, like pre-0.11.46.
	assert.ok(
		run.stdoutBytes > 0,
		`worker died silently (exit=${run.exitCode}, stdout=0 bytes) — stdin reader regression is back; stderr tail: ${run.stderrTail}`,
	);
});

test("live worker (real pi): DEFAULT-ON (gate unset) + fd3 handshake payload — the flip's live pin: alive AND no leak", {
	skip: !piAvailable(),
}, async () => {
	// DEFAULT-ON FLIP (2026-10-28): the gate is now ON when UNSET, so this
	// is the LIVE DEFAULT spawn shape (no PI_CREW_BROKER_STDIN in env). The
	// armed reader must consume the fd3 payload in a REAL pi process without
	// the 0.11.46/47 failure class (silent exit-0 / token merged into the
	// prompt) — unit seams are structurally blind to this (knowledge lesson).
	const sentinel = "fd3-default-leak-sentinel-9b4e7d21";
	const payload = buildBrokerStdinLine(LIVENESS_RUN, LIVENESS_SOCKET, { [LIVENESS_TASK]: sentinel });
	const run = await runLiveWorker({}, payload); // gate key ABSENT → default ON
	assert.ok(
		run.stdoutBytes > 0,
		`default-ON worker died silently (exit=${run.exitCode}, stdout=0 bytes) — the fd3 transport broke under the default gate; stderr tail: ${run.stderrTail}`,
	);
	assert.ok(
		!run.stdoutTail.includes(sentinel),
		"handshake token leaked into stdout on the DEFAULT route — ordering-2: the payload reached the worker prompt",
	);
	assert.ok(!run.stderrTail.includes(sentinel), "handshake token leaked into stderr on the DEFAULT route");
});

test("live worker (real pi): explicit gate '1' + fd3 handshake payload must stay alive AND never leak the token into output", {
	skip: !piAvailable(),
}, async () => {
	// ROOT-CAUSE FIX ASSERTION (2026-10-28): pi@1.0.4 readPipedStdin consumed
	// ALL piped fd0 as PROMPT CONTENT — the v0.11.46/47 fd0 handshake raced it
	// into (worst case) a pause() deadlock → SIGTERM exit 0 with ~0 stdout, or
	// (ordering-2) the token JSON merged into the prompt. Post-fix the payload
	// rides the DEDICATED fd3 pipe (fd0 = "ignore"), so the worker MUST live
	// and the sentinel token MUST NOT appear anywhere in its output.
	const sentinel = "fd3-leak-sentinel-5d8c1a2f";
	const payload = buildBrokerStdinLine(LIVENESS_RUN, LIVENESS_SOCKET, { [LIVENESS_TASK]: sentinel });
	const run = await runLiveWorker({ PI_CREW_BROKER_STDIN: "1" }, payload);
	assert.ok(
		run.stdoutBytes > 0,
		`worker died silently (exit=${run.exitCode}, stdout=0 bytes) — the fd0 race is back or the fd3 transport broke; stderr tail: ${run.stderrTail}`,
	);
	assert.ok(
		!run.stdoutTail.includes(sentinel),
		"handshake token leaked into stdout — ordering-2: the payload reached the worker prompt (pi merged a piped fd into the prompt)",
	);
	assert.ok(!run.stderrTail.includes(sentinel), "handshake token leaked into stderr");
});
