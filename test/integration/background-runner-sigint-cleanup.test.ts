/**
 * RT-2 integration test: SIGINT handler uses process.exitCode (not process.exit)
 * so the finally/runCleanup block runs, terminating child-pi workers.
 *
 * Strategy: spawn a harness that replicates the background-runner.ts SIGINT
 * handler + finally/cleanup pattern. The harness spawns a child process
 * (simulating a child-pi worker), registers it for cleanup, and waits.
 * On SIGINT, the harness sets exitCode=130 (the RT-2 fix) instead of calling
 * process.exit(130). The finally block runs cleanup — killing the child and
 * writing a marker file.
 *
 * Assertions:
 *   1. Exit code is 130 (not 0, not null)
 *   2. cleanup-ran.txt marker exists (proves finally block ran)
 *   3. Child process is dead (proves terminateActiveChildPiProcesses ran)
 *
 * Mutation check: if the harness uses process.exit(130) instead of
 * process.exitCode = 130, the finally block does NOT run — no marker file,
 * child stays alive. Test MUST fail.
 *
 * @see src/runtime/background-runner.ts RT-2 SIGINT handler fix
 * @see test/fixtures/sigint-cleanup-harness.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function resolveProjectRoot(): string {
	const self = fileURLToPath(import.meta.url);
	return path.resolve(self, "..", "..", "..");
}

test("RT-2: SIGINT sets exitCode (not process.exit) — finally block runs cleanup, child terminated", async () => {
	const projectRoot = resolveProjectRoot();
	const harnessPath = path.join(projectRoot, "test", "fixtures", "sigint-cleanup-harness.mjs");

	if (!fs.existsSync(harnessPath)) {
		throw new Error(`harness not found at ${harnessPath}`);
	}

	// Create a temp directory for marker files.
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt2-"));
	const childPidFile = path.join(markerDir, "child-pid.txt");
	const cleanupMarker = path.join(markerDir, "cleanup-ran.txt");

	try {
		// Spawn the harness.
		const child = spawn(process.execPath, [harnessPath, markerDir], {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		// Collect stderr for diagnostics.
		const stderrChunks: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		// Wait for the harness to signal readiness (child-pid.txt exists).
		const ready = await new Promise<boolean>((resolve) => {
			const deadline = Date.now() + 10_000;
			const check = setInterval(() => {
				if (fs.existsSync(childPidFile)) {
					clearInterval(check);
					resolve(true);
				} else if (Date.now() > deadline) {
					clearInterval(check);
					resolve(false);
				}
			}, 100);
		});

		assert.ok(ready, "harness did not signal readiness (child-pid.txt not written within 10s)");

		// Read the grandchild PID.
		const grandchildPid = Number.parseInt(fs.readFileSync(childPidFile, "utf-8").trim(), 10);
		assert.ok(grandchildPid > 0, `invalid grandchild PID: ${grandchildPid}`);

		// Give the harness a moment to settle into its await.
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Send SIGINT to the harness.
		assert.ok(child.pid, "harness pid is missing");
		process.kill(child.pid, "SIGINT");

		// Wait for the harness to exit.
		const exitCode = await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`harness did not exit within 15s after SIGINT`));
			}, 15_000);

			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve(code ?? -1);
			});
			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		// Assertion 1: exit code is 130.
		assert.equal(
			exitCode,
			130,
			`Expected exit code 130 but got ${exitCode}. Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
		);

		// Assertion 2: cleanup marker exists (proves finally block ran).
		assert.ok(
			fs.existsSync(cleanupMarker),
			"cleanup-ran.txt NOT found — finally block did NOT run (process.exit was used instead of exitCode)",
		);

		// Assertion 3: grandchild (child-pi) is dead — not orphaned.
		// Give a brief moment for the SIGTERM to take effect.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.ok(
			!isPidAlive(grandchildPid),
			`GRANDCHILD ORPHANED: pid=${grandchildPid} is still alive after cleanup — child-pi was NOT terminated`,
		);

		console.log(
			`[RT-2] ✓ SIGINT → exitCode=130, finally ran cleanup, child pid=${grandchildPid} terminated (not orphaned)`,
		);
	} finally {
		// Clean up temp dir.
		try {
			fs.rmSync(markerDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
