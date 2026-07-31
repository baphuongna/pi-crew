#!/usr/bin/env node
/**
 * RT-2 test harness: replicates the background-runner.ts SIGINT handler + cleanup
 * pattern to verify that process.exitCode (not process.exit) lets the finally
 * block run terminateActiveChildPiProcesses.
 *
 * Mirrors the exact structure from background-runner.ts main():
 *   - SIGINT handler: abortController.abort() + process.exitCode = 130
 *     (RT-2 fix — do NOT call process.exit(130))
 *   - try { ... await execution ... } catch { ... } finally { runCleanup() }
 *
 * Usage: node sigint-cleanup-harness.mjs <markerDir>
 *
 * Writes:
 *   <markerDir>/child-pid.txt   — PID of the spawned child (simulates child-pi)
 *   <markerDir>/cleanup-ran.txt — written by the finally block (proves cleanup ran)
 *
 * If the SIGINT handler used process.exit(130) (the bug), the finally block
 * would NOT run and cleanup-ran.txt would never be written.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const markerDir = process.argv[2];
if (!markerDir) {
	console.error("Usage: sigint-cleanup-harness.mjs <markerDir>");
	process.exit(2);
}

const childPidFile = path.join(markerDir, "child-pid.txt");
const cleanupMarker = path.join(markerDir, "cleanup-ran.txt");

// Spawn a child process that stays alive (simulates a child-pi worker).
// detached + unref so it survives if the parent exits abruptly (orphan scenario).
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},5000)"], {
	stdio: "ignore",
	detached: true,
});
child.unref();

// Signal readiness: write the child PID so the test can track it.
fs.writeFileSync(childPidFile, String(child.pid));

// AbortController — mirrors background-runner.ts abortController
const ac = new AbortController();

// Keep-alive interval (NOT unref'd — mirrors background-runner keepAlive)
const keepAlive = setInterval(() => {}, 5000);

// RT-2 SIGINT handler — mirrors the fixed pattern from background-runner.ts
process.on("SIGINT", () => {
	// Do NOT call process.exit(130) — it bypasses the finally block.
	// Set exitCode so the event loop drains and the finally block runs cleanup.
	ac.abort();
	process.exitCode = 130;
});

// main() body — mirrors try { await executeTeamRun(...) } catch { ... } finally { runCleanup() }
try {
	// Await indefinitely until abort signal fires (mirrors executeTeamRun waiting).
	await new Promise((resolve, reject) => {
		if (ac.signal.aborted) reject(new Error("already aborted"));
		else ac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
} catch {
	// Expected: abort triggered by SIGINT handler. Fall through to finally.
} finally {
	// RT-2: this finally block runs because exitCode was set, not process.exit().
	clearInterval(keepAlive);
	// Cleanup: terminate the child process (mirrors terminateActiveChildPiProcesses).
	try {
		process.kill(child.pid);
	} catch {
		/* best-effort */
	}
	// Write cleanup marker — proves the finally block ran.
	try {
		fs.writeFileSync(cleanupMarker, "ran");
	} catch {
		/* best-effort */
	}
}
