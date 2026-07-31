/**
 * RT-3 unit test: background-runner startup failures write async.failed event
 * and exit with code 1 (not 0).
 *
 * Spawns the ACTUAL background-runner.ts process with a temp cwd and a
 * nonexistent run ID. The manifest load fails ("Run not found"), which throws
 * from main()'s pre-try section and is caught by the module-level catch.
 *
 * Before the RT-3 fix: exitDueToRejection was set but NO event was written and
 * exitCode stayed 0 → the run appeared stuck in 'queued' until the stale
 * reconciler reaped it.
 *
 * After the RT-3 fix: the module-level catch writes async.failed to events.jsonl
 * and sets process.exitCode = 1.
 *
 * Mutation check: revert the async.failed write + exitCode=1 in the module-level
 * catch → exit code becomes 0 and no event is written → test MUST fail.
 *
 * @see src/runtime/background-runner.ts module-level catch (RT-3 fix)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function resolveProjectRoot(): string {
	const self = fileURLToPath(import.meta.url);
	return path.resolve(self, "..", "..", "..");
}

/**
 * Parse events.jsonl and return all parsed event objects.
 */
function parseEvents(eventsPath: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(eventsPath)) return [];
	const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
	const events: Array<Record<string, unknown>> = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* skip malformed lines */
		}
	}
	return events;
}

test("RT-3: startup failure writes async.failed event + exits with code 1", async () => {
	const projectRoot = resolveProjectRoot();
	const runnerPath = path.join(projectRoot, "src", "runtime", "background-runner.ts");
	const runId = `rt3-test-${Date.now()}`;

	// Create temp project dir with .crew marker + run directory.
	// The .crew directory makes findRepoRoot() resolve to the temp dir.
	// The run directory must exist so appendEvent can write events.jsonl.
	// Manifest.json is deliberately NOT created — this triggers "Run not found".
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt3-"));
	const crewRoot = path.join(tempDir, ".crew");
	const runDir = path.join(crewRoot, "state", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	const eventsPath = path.join(runDir, "events.jsonl");

	try {
		// Spawn the actual background-runner.ts with a nonexistent manifest.
		// Clean env to avoid worker-specific behavior.
		const childEnv: NodeJS.ProcessEnv = { ...process.env };
		delete childEnv.PI_CREW_PARENT_PID;
		delete childEnv.PI_CREW_KIND;
		delete childEnv.PI_CREW_RUN_ID;
		childEnv.PI_CREW_MAX_RUN_MS = "30000";

		const child = spawn(process.execPath, ["--experimental-strip-types", runnerPath, "--cwd", tempDir, "--run-id", runId], {
			cwd: projectRoot,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stderrChunks: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		// Wait for exit (should be fast — startup failure exits immediately).
		const exitCode = await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
				reject(new Error("background-runner did not exit within 30s"));
			}, 30_000);

			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve(code ?? -1);
			});
			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		// Assertion 1: exit code is 1 (not 0).
		// Before RT-3 fix: exitCode was 0 (silent failure).
		assert.equal(
			exitCode,
			1,
			`Expected exit code 1 but got ${exitCode}. ` +
				`Before RT-3 fix, startup failures exited 0 silently. ` +
				`Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
		);

		// Assertion 2: async.failed event was written to events.jsonl.
		const events = parseEvents(eventsPath);
		const failedEvents = events.filter((e) => e.type === "async.failed");

		assert.ok(
			failedEvents.length >= 1,
			`Expected at least 1 async.failed event in events.jsonl but found ${failedEvents.length}. ` +
				`Before RT-3 fix, no event was written on startup failure. ` +
				`Events: ${JSON.stringify(events.map((e) => e.type))}`,
		);

		// Assertion 3: the async.failed event has the correct runId.
		const failedEvent = failedEvents[0];
		assert.equal(failedEvent.runId, runId, `async.failed event runId should be '${runId}'`);

		// Assertion 4: the event has a stack trace in data.
		const data = failedEvent.data as Record<string, unknown> | undefined;
		assert.ok(data?.stack, "async.failed event should include a stack trace");

		console.log(`[RT-3] ✓ startup failure → async.failed written, exitCode=1 (was 0 before fix)`);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
