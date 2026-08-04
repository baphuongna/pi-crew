/**
 * RT-NEW-3 regression test: benign signals (SIGWINCH, SIGPIPE, SIGCONT, …)
 * must NOT be logged as terminal `async.failed` events — they don't kill the
 * background runner. A benign signal logged as `async.failed` poisons
 * dead-run detection: async-notifier's `isAsyncTerminalEvent` treats
 * `async.failed` as terminal, so `markDeadAsyncRunIfNeeded` would return
 * undefined forever once a single benign signal fired (e.g. a terminal
 * resize SIGWINCH while the run was alive).
 *
 * Background runner module auto-runs main() on import; without --cwd/--run-id
 * it throws "Usage: ...", which is caught by the module-level catch (harmless)
 * and sets exitCode=1. We therefore exercise the real exported
 * `signalEventType`/`BENIGN_SIGNALS` from a spawned subprocess harness — the
 * same pattern as background-runner-sigint-cleanup.test.ts.
 *
 * @see src/runtime/background-runner.ts BENIGN_SIGNALS + signalEventType
 * @see src/extension/async-notifier.ts isAsyncTerminalEvent
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

const HARNESS_CODE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const markerFile = process.argv[2];
const projectRoot = process.argv[3];

// ── Import REAL production code ──────────────────────────────────────────
// background-runner.ts auto-runs main() on import; without --cwd/--run-id it
// throws "Usage: ..." which is caught by the module-level catch (harmless).
const { BENIGN_SIGNALS, signalEventType } = await import(
\tpathToFileURL(path.join(projectRoot, "src/runtime/background-runner.ts")).href
);
const { isAsyncTerminalEvent } = await import(
\tpathToFileURL(path.join(projectRoot, "src/extension/async-notifier.ts")).href
);

// Reset exitCode (importing background-runner.ts sets it to 1 via the graceful
// main() failure — no --cwd/--run-id).
process.exitCode = 0;

const results = {
\tbenignWinch: signalEventType("SIGWINCH"),
\tbenignPipe: signalEventType("SIGPIPE"),
\tbenignCont: signalEventType("SIGCONT"),
\tfatalKill: signalEventType("SIGKILL"),
\tfatalTerm: signalEventType("SIGTERM"),
\tfatalInt: signalEventType("SIGINT"),
\tbenignSetCount: BENIGN_SIGNALS.size,
\tterminalSignal: isAsyncTerminalEvent({
\t\ttype: "async.signal",
\t\ttime: new Date().toISOString(),
\t\trunId: "",
\t\tmessage: "",
\t\tdata: {},
\t}),
\tterminalFailed: isAsyncTerminalEvent({
\t\ttype: "async.failed",
\t\ttime: new Date().toISOString(),
\t\trunId: "",
\t\tmessage: "",
\t\tdata: {},
\t}),
\tterminalCompleted: isAsyncTerminalEvent({
\t\ttype: "async.completed",
\t\ttime: new Date().toISOString(),
\t\trunId: "",
\t\tmessage: "",
\t\tdata: {},
\t}),
\tterminalDied: isAsyncTerminalEvent({
\t\ttype: "async.died",
\t\ttime: new Date().toISOString(),
\t\trunId: "",
\t\tmessage: "",
\t\tdata: {},
\t}),
};
fs.writeFileSync(markerFile, JSON.stringify(results));
`;

test("RT-NEW-3: benign signals classify as async.signal; isAsyncTerminalEvent excludes async.signal", async () => {
	const projectRoot = resolveProjectRoot();
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rtnew3-"));
	const markerFile = path.join(markerDir, "results.json");
	const harnessPath = path.join(markerDir, "harness.ts");
	try {
		fs.writeFileSync(harnessPath, HARNESS_CODE);
		const child = spawn(process.execPath, ["--experimental-strip-types", harnessPath, markerFile, projectRoot], {
			cwd: projectRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stderrChunks: Buffer[] = [];
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		const exitCode = await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* best-effort */
				}
				reject(new Error("RT-NEW-3 harness did not exit within 30s"));
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
		assert.equal(
			exitCode,
			0,
			`RT-NEW-3 harness exited ${exitCode}. Stderr: ${Buffer.concat(stderrChunks).toString("utf-8").slice(0, 512)}`,
		);
		assert.ok(fs.existsSync(markerFile), "RT-NEW-3 harness did not write results");

		const results = JSON.parse(fs.readFileSync(markerFile, "utf-8")) as Record<string, unknown>;
		// Benign signals → async.signal (NOT async.failed — the RT-NEW-3 bug).
		assert.equal(results.benignWinch, "async.signal", "SIGWINCH must classify as async.signal");
		assert.equal(results.benignPipe, "async.signal", "SIGPIPE must classify as async.signal");
		assert.equal(results.benignCont, "async.signal", "SIGCONT must classify as async.signal");
		// Fatal signals → async.failed.
		assert.equal(results.fatalKill, "async.failed", "SIGKILL must classify as async.failed");
		assert.equal(results.fatalTerm, "async.failed", "SIGTERM must classify as async.failed");
		assert.equal(results.fatalInt, "async.failed", "SIGINT must classify as async.failed");
		// BENIGN_SIGNALS exported and populated.
		assert.equal(results.benignSetCount, 12, "BENIGN_SIGNALS should contain the 12 benign signals");
		// async.signal is NOT terminal; async.failed/completed/died ARE.
		assert.equal(results.terminalSignal, false, "async.signal must not be treated as terminal");
		assert.equal(results.terminalFailed, true, "async.failed must be treated as terminal");
		assert.equal(results.terminalCompleted, true, "async.completed must be treated as terminal");
		assert.equal(results.terminalDied, true, "async.died must be treated as terminal");
	} finally {
		try {
			fs.rmSync(markerDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
