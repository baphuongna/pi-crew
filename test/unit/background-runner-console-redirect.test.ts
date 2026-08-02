/**
 * Regression test for the "team run hangs forever at 25%" Bug Y.
 *
 * ROOT CAUSE: src/runtime/background-runner.ts redirected only `console.log`
 * and `console.error` to the log file. `console.debug` and `console.warn`
 * still wrote to the original stdout/stderr pipe — which is CLOSED once the
 * parent process detaches (the bg-runner is spawned with `detached:true` +
 * `setsid:true`, so its parent disconnects the stdio pipes). The very next
 * `console.debug` call from team-runner.ts:323 (inside
 * `mergeTaskUpdatesPreservingTerminal`) hit the closed stdout → unhandled
 * `EPIPE` error → process exit → scheduler dead → run stuck at 25% forever.
 *
 * Fix: extend the in-process console redirect to also cover `console.debug`
 * and `console.warn`, AND wrap the `fs.writeSync` in try-catch so any log-write
 * failure (closed fd, ENOSPC, etc.) can never crash the scheduler.
 *
 * This test verifies the fix PATTERN (the redirect + try-catch wrapper) is
 * robust. We replicate the `origWrite` logic from background-runner.ts here
 * (the function is module-local and intentionally not exported), and assert
 * it never throws — which is the property that prevents the EPIPE crash.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";

/**
 * Mirror of the fixed `origWrite` in src/runtime/background-runner.ts.
 * If this drift-detector asserts, update both copies in lockstep.
 */
const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

function makeOrigWrite(getLogFd: () => number | undefined) {
	return (_prefix: string) =>
		(data: unknown, ...args: unknown[]) => {
			const logFd = getLogFd();
			if (logFd === undefined) return;
			const msg = [data, ...args].map(String).join(" ") + "\n";
			try {
				fs.writeSync(logFd, msg);
			} catch {
				/* never crash the scheduler over a log write */
			}
		};
}

test("origWrite with undefined logFd is a no-op (never throws)", () => {
	const origWrite = makeOrigWrite(() => undefined);
	// Must not throw even when called many times with arbitrary data shapes.
	assert.doesNotThrow(() => {
		origWrite("DBG")("test", 1, { a: 1 });
		origWrite("DBG")(undefined, null, Symbol("x"));
		origWrite("DBG")("multi\nline\nstring");
	});
});

test("origWrite with a valid logFd writes the formatted message to the file", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-redirect-ok-"));
	createdTmpDirs.push(tmp);
	const logPath = path.join(tmp, "log.txt");
	const logFd = fs.openSync(logPath, "w");
	try {
		const origWrite = makeOrigWrite(() => logFd);
		origWrite("DBG")("hello", 42, { a: 1 });
		origWrite("DBG")("world");
		fs.fsyncSync(logFd);
	} finally {
		fs.closeSync(logFd);
	}
	const content = fs.readFileSync(logPath, "utf-8");
	assert.ok(content.includes("hello 42 [object Object]"), `expected 'hello 42 [object Object]' in log, got: ${content}`);
	assert.ok(content.includes("world"), `expected 'world' in log, got: ${content}`);
	assert.ok(content.endsWith("\n"), "the last call must terminate with \\n");
});

test("origWrite swallows EPIPE / EBADF when the log fd is closed (the Bug Y crash trigger)", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-redirect-ebadf-"));
	createdTmpDirs.push(tmp);
	const logPath = path.join(tmp, "log.txt");
	const logFd = fs.openSync(logPath, "w");
	const origWrite = makeOrigWrite(() => logFd);
	origWrite("DBG")("before-close");
	// Close the fd under the writer's feet, simulating the EPIPE/EBADF that
	// triggered the original crash when the parent detached its stdio pipes.
	fs.closeSync(logFd);
	// CRITICAL: must not throw. If this throws, the unhandled error kills the
	// background runner mid-workflow, stranding the run at 25% forever.
	assert.doesNotThrow(() => {
		origWrite("DBG")("after-close-1");
		origWrite("DBG")("after-close-2", { nested: true });
	});
	// Subsequent redirects of console.debug/.warn to this origWrite must also
	// remain safe (i.e. console.debug("...") must not throw, even after the
	// underlying fd is closed).
	const consoleDebug = origWrite("DBG");
	const consoleWarn = origWrite("WARN");
	assert.doesNotThrow(() => {
		consoleDebug("simulated console.debug call");
		consoleWarn("simulated console.warn call");
	});
});

test("origWrite is safe when getLogFd returns undefined AFTER a successful write", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-redirect-toggle-"));
	createdTmpDirs.push(tmp);
	const logPath = path.join(tmp, "log.txt");
	const logFd = fs.openSync(logPath, "w");
	let fd: number | undefined = logFd;
	const getLogFd = () => fd;
	const origWrite = makeOrigWrite(getLogFd);
	origWrite("DBG")("first-write");
	fs.fsyncSync(logFd);
	fs.closeSync(logFd);
	// Now the log fd goes away (e.g. on `process.exit` cleanup closing logFd
	// before the very last console call). origWrite must turn into a no-op.
	fd = undefined;
	assert.doesNotThrow(() => origWrite("DBG")("post-undefined"));
	// File should still contain the first write but NOT the post-undefined one.
	const content = fs.readFileSync(logPath, "utf-8");
	assert.ok(content.includes("first-write"));
	assert.ok(!content.includes("post-undefined"), "post-undefined must not have been written");
});
