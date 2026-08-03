/**
 * RT-2 integration test: SIGINT handler uses process.exitCode (not process.exit)
 * so the finally/cleanup block runs, terminating child-pi workers.
 *
 * PREVIOUS (broken) test: spawned test/fixtures/sigint-cleanup-harness.mjs which
 * MANUALLY REPLICATED the SIGINT-handler pattern — it did NOT import/exercise the
 * real src/runtime/background-runner.ts SIGINT handler. If the real handler
 * reverted to process.exit(130), that test STILL passed (false confirmation).
 *
 * REWRITTEN test: spawns a subprocess harness that imports the REAL
 * installBackgroundRunnerSigintHandler() from background-runner.ts (the RT-2
 * fix) and the REAL registerActiveChild()/terminateActiveChildPiProcesses()
 * from child-pi-kill.ts. The harness:
 *   1. Spawns a long-lived child (simulates a child-pi worker)
 *   2. Registers it via the REAL registerActiveChild()
 *   3. Installs the REAL SIGINT handler (RT-2 fix: process.exitCode = 130)
 *   4. Waits for SIGINT
 *   5. The finally block calls the REAL terminateActiveChildPiProcesses()
 *
 * The test sends SIGINT and asserts:
 *   1. Exit code is 130
 *   2. cleanup-ran.txt marker exists (finally block ran)
 *   3. Grandchild process is dead (terminateActiveChildPiProcesses ran)
 *
 * Mutation check: if installBackgroundRunnerSigintHandler is reverted to
 * process.exit(130) instead of process.exitCode = 130, the finally block does
 * NOT run — no cleanup-ran.txt, grandchild stays alive. Test MUST fail.
 *
 * @see src/runtime/background-runner.ts installBackgroundRunnerSigintHandler (RT-2 fix)
 * @see src/runtime/child-pi/child-pi-kill.ts registerActiveChild / terminateActiveChildPiProcesses
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

/**
 * Subprocess harness code. Written to a temp .ts file and spawned with
 * --experimental-strip-types so it can import the REAL .ts production modules.
 *
 * This harness exercises the REAL production code — not a re-implementation.
 * The SIGINT handler is the real exported function from background-runner.ts,
 * and the child registration / termination use the real child-pi-kill.ts.
 */
const HARNESS_CODE = `
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const markerDir = process.argv[2];
const projectRoot = process.argv[3];

// ── Import REAL production code ──────────────────────────────────────────
// background-runner.ts auto-runs main() on import; without --cwd/--run-id it
// throws "Usage: ..." which is caught by the module-level catch (harmless).
const { installBackgroundRunnerSigintHandler } = await import(
\tpathToFileURL(path.join(projectRoot, "src/runtime/background-runner.ts")).href
);
const { registerActiveChild, terminateActiveChildPiProcesses } = await import(
\tpathToFileURL(path.join(projectRoot, "src/runtime/child-pi/child-pi-kill.ts")).href
);

// Reset exitCode (importing background-runner.ts sets it to 1 via the graceful
// main() failure).
process.exitCode = 0;

const childPidFile = path.join(markerDir, "child-pid.txt");
const cleanupMarker = path.join(markerDir, "cleanup-ran.txt");

// Spawn a long-lived child that simulates a child-pi worker.
// detached + unref so it survives if the parent exits abruptly (orphan scenario).
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},5000)"], {
\tstdio: "ignore",
\tdetached: true,
});
child.unref();

// Register via the REAL registration function so terminateActiveChildPiProcesses
// knows about this child.
registerActiveChild(child.pid, child);

// Signal readiness to the test.
fs.writeFileSync(childPidFile, String(child.pid));

// AbortController — the REAL SIGINT handler aborts this on SIGINT.
const ac = new AbortController();

// Install the REAL SIGINT handler from background-runner.ts.
// RT-2 fix: this sets process.exitCode = 130 (NOT process.exit(130)), so the
// finally block below runs cleanup.
installBackgroundRunnerSigintHandler(ac, "");

// Keep alive until the abort signal fires.
const keepAlive = setInterval(() => {}, 5000);

try {
\tawait new Promise((_resolve, reject) => {
\t\tac.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
\t});
} catch {
\t// SIGINT → abort → expected. Fall through to finally.
} finally {
\tclearInterval(keepAlive);
\t// REAL cleanup — terminates all registered active child-pi processes.
\tterminateActiveChildPiProcesses();
\t// Marker proves the finally block ran (i.e. exitCode was set, not process.exit).
\tfs.writeFileSync(cleanupMarker, "ran");
}
`;

test("RT-2: REAL SIGINT handler sets exitCode (not process.exit) — finally runs cleanup, child terminated", async () => {
	const projectRoot = resolveProjectRoot();
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt2-"));
	const childPidFile = path.join(markerDir, "child-pid.txt");
	const cleanupMarker = path.join(markerDir, "cleanup-ran.txt");
	const harnessPath = path.join(markerDir, "harness.ts");

	try {
		// Write harness to a temp .ts file.
		fs.writeFileSync(harnessPath, HARNESS_CODE);

		// Spawn the harness subprocess.
		const child = spawn(process.execPath, ["--experimental-strip-types", harnessPath, markerDir, projectRoot], {
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
			const deadline = Date.now() + 15_000;
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

		assert.ok(
			ready,
			`harness did not signal readiness (child-pid.txt not written within 15s). ` +
				`Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
		);

		// Read the grandchild PID.
		const grandchildPid = Number.parseInt(fs.readFileSync(childPidFile, "utf-8").trim(), 10);
		assert.ok(grandchildPid > 0, `invalid grandchild PID: ${grandchildPid}`);

		// Give the harness a moment to settle into its await.
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Send SIGINT to the harness — triggers the REAL SIGINT handler.
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
			`Expected exit code 130 but got ${exitCode}. ` + `Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
		);

		// Assertion 2: cleanup marker exists (proves finally block ran).
		// This is the KEY mutation-discriminating assertion: process.exit(130)
		// would skip the finally block entirely.
		assert.ok(
			fs.existsSync(cleanupMarker),
			"cleanup-ran.txt NOT found — finally block did NOT run " +
				"(the REAL handler used process.exit(130) instead of process.exitCode = 130)",
		);

		// Assertion 3: grandchild (child-pi) is dead — not orphaned.
		// terminateActiveChildPiProcesses() in the finally block killed it.
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.ok(
			!isPidAlive(grandchildPid),
			`GRANDCHILD ORPHANED: pid=${grandchildPid} is still alive after cleanup — ` +
				`terminateActiveChildPiProcesses did NOT run (finally block was skipped)`,
		);

		console.log(
			`[RT-2] ✓ REAL SIGINT handler → exitCode=130, finally ran cleanup, ` + `child pid=${grandchildPid} terminated (not orphaned)`,
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
