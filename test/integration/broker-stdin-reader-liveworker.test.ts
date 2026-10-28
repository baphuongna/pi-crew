/**
 * broker-stdin-reader-liveworker.test.ts — LIVE regression test for the
 * v0.11.46/v0.11.47 silent-worker death (caught by the real-test-pi-crew T7
 * battery on 2026-10-28, NOT by CI — unit tests inject the readStdinLine
 * seam and never run process.stdin inside a real pi process).
 *
 * Symptom pinned here: a REAL `pi --mode json -p` worker process whose env
 * carries the broker identity keys (PI_CREW_BROKER_SOCKET/RUN_ID/TASK_ID)
 * but NO env token, with the repo's prompt-runtime extension loaded, exited
 * 0 with ZERO stdout bytes the moment the LOW-1 stdin-reader fallback was
 * the default (gate ON by default, v0.11.46). v0.11.48 flipped the gate to
 * OPT-IN (PI_CREW_BROKER_STDIN=1); the reader no longer activates by
 * default, so the default env must behave exactly like pre-0.11.46: the
 * worker boots, streams JSON events on stdout, and finishes its turn.
 *
 * Test shape mirrors the real worker spawn (worker env captured from a live
 * fast-fix run: thin allowlist env + broker identity, stdin untouched):
 *
 *   1. DEFAULT (gate unset): worker must produce stdout (session event) —
 *      the silent exit-0 is the regression this file pins.
 *   2. Guard: `pi` binary unavailable (CI containers) → skip, not fail —
 *      this test runs wherever a real pi host exists (dev boxes, the
 *      real-test battery). The unit suites remain the CI gate.
 *   3. Opt-in gate (=1): currently known to trigger the live-worker bug —
 *      DO NOT assert liveness there until the reader path is root-caused;
 *      we only assert the env route contract in the unit suites.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPT_RUNTIME = path.join(REPO_ROOT, "src/prompt/prompt-runtime.ts");

/** Real `pi` on PATH? (CI containers run the fake-pi fixtures instead.) */
function piAvailable(): boolean {
	const res = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000 });
	return res.status === 0 || /pi\s+\d/i.test(res.stdout ?? "");
}

interface LiveRun {
	exitCode: number | null;
	stdoutBytes: number;
	stderrTail: string;
}

/** Spawn a real headless JSON worker with the exact env shape that died:
 * thin allowlist-style env + broker identity, no token, stdin ignored. */
function runLiveWorker(envExtra: Record<string, string>): Promise<LiveRun> {
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
			PI_CREW_BROKER_SOCKET: "/tmp/pi-crew-liveworker-dead.sock",
			PI_CREW_BROKER_RUN_ID: "run_liveworker_regression",
			PI_CREW_BROKER_TASK_ID: "01_explore",
			// …and NO PI_CREW_BROKER_TOKEN (the v0.11.46 stdin route).
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
			{ env, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT },
		);
		let stdoutBytes = 0;
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("live worker hung >90s"));
		}, 90_000);
		child.stdout?.on("data", (d: Buffer) => (stdoutBytes += d.length));
		child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("error", (e) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			rmSync(dir, { recursive: true, force: true });
			resolve({ exitCode: code, stdoutBytes, stderrTail: stderr.slice(-200) });
		});
	});
}

test("live worker (real pi): default broker env must NOT silently exit with zero stdout", { skip: !piAvailable() }, async () => {
	const run = await runLiveWorker({});
	// The v0.11.46/v0.11.47 regression: exit 0 with 0 stdout bytes in ~1s.
	// Post-v0.11.48 the default gate keeps the reader off, so the worker
	// streams its session + agent events like pre-0.11.46.
	assert.ok(
		run.stdoutBytes > 0,
		`worker died silently (exit=${run.exitCode}, stdout=0 bytes) — stdin reader regression is back; stderr tail: ${run.stderrTail}`,
	);
});
