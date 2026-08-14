/**
 * R11-1 regression tests (MEDIUM, §ROUND 11 security hardening).
 *
 * The `runRipgrep` child-process spawn previously had NO timeout and NO stdout
 * cap — a huge repo (`rg --files`) could accumulate unbounded stdout (OOM
 * risk) or hang forever. These tests prove the hardened behavior using
 * synthetic `node -e` commands (no real rg, no real tree) so they are fast
 * (<5s) and cross-platform.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runRipgrep } from "../../../../src/runtime/task-runner/retrieval-orchestrator.ts";

/** Write a marker file with the child's pid, then sleep far beyond the test window. */
const SLOW_SCRIPT = `const fs=require('fs');fs.writeFileSync(process.argv[1], String(process.pid));setTimeout(()=>{},10000);`;
/** Write the pid marker, then emit ~5MB to stdout (well over any test cap). */
const EMITTER_SCRIPT = `const fs=require('fs');fs.writeFileSync(process.argv[1], String(process.pid));for(let i=0;i<5000;i++){process.stdout.write('x'.repeat(1024));}`;

function makeTempPidFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r11-1-")), "pid.txt");
}

async function readPidFile(pidFile: string): Promise<number> {
	const deadline = Date.now() + 3000;
	for (;;) {
		try {
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch {
			/* not written yet */
		}
		if (Date.now() > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`pid file ${pidFile} never appeared`);
}

/** Poll until the child pid is reaped (ESRCH) — proves SIGKILL actually landed. */
async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 3000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return; // ESRCH — process gone
		}
		if (Date.now() > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`child ${pid} still alive after 3s — SIGKILL did not terminate it`);
}

test("R11-1: runRipgrep rejects on timeout and SIGKILLs the child", async () => {
	const pidFile = makeTempPidFile();
	// Synthetic slow command: node writes its pid then sleeps 10s. The tiny
	// timeout override forces the timeout path (no real rg, no huge tree).
	await assert.rejects(
		runRipgrep(["-e", SLOW_SCRIPT, pidFile], os.tmpdir(), {
			command: process.execPath,
			timeoutMs: 1500,
			maxStdoutBytes: 1024 * 1024,
		}),
		/timed out after 1500ms/,
	);
	// The child would have slept 10s — if it were still alive, this fails.
	const pid = await readPidFile(pidFile);
	await waitForProcessGone(pid);
});

test("R11-1: runRipgrep rejects when stdout exceeds the cap and kills the child", async () => {
	const pidFile = makeTempPidFile();
	// Synthetic emitter: ~5MB of stdout. A tiny maxStdoutBytes override trips
	// the cap on the first pipe chunk (no real rg, no huge tree).
	await assert.rejects(
		runRipgrep(["-e", EMITTER_SCRIPT, pidFile], os.tmpdir(), {
			command: process.execPath,
			timeoutMs: 30_000,
			maxStdoutBytes: 2048,
		}),
		/stdout exceeded 2048 bytes/,
	);
	const pid = await readPidFile(pidFile);
	await waitForProcessGone(pid);
});
