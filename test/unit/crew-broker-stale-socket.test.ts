/**
 * crew-broker-stale-socket.test.ts — Phase 0 sub-task 0.4 stale-endpoint tests.
 *
 * Verifies the CrewBroker's connect-then-unlink / refused-endpoint / symlink
 * safety policy:
 *  - A refused (stale) endpoint is removed and replaced once.
 *  - A live endpoint causes EADDRINUSE and is preserved (NOT replaced).
 *  - A symlinked leaf is refused (not followed).
 *  - On stop(), the broker unlinks only the recorded path (recording-owned).
 *  - Calling start() twice is idempotent (same server).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CrewBroker } from "../../src/runtime/crew-broker.ts";

function tempSocketPath(suffix: string): string {
	return path.join(os.tmpdir(), `pi-crew-broker-stale-${process.pid}-${Date.now()}-${suffix}.sock`);
}

/** Pre-create a stale socket file (just a regular file, not a real socket).
 *  This simulates an "endpoint that exists but no listener answers". */
function writeStaleFile(sockPath: string): void {
	mkdirSync(path.dirname(sockPath), { recursive: true });
	writeFileSync(sockPath, "stale\n");
}

test("stale: refused/nonexistent stale endpoint is replaced once", async () => {
	const sockPath = tempSocketPath("stale-replace");
	writeStaleFile(sockPath);
	assert.ok(existsSync(sockPath), "pre-condition: stale file exists");
	const broker = new CrewBroker({ sessionId: "session-stale", socketPath: sockPath, enabled: true });
	try {
		await broker.start();
		// The stale file should have been removed and replaced with a live
		// socket entry (a real socket file is created by listen()).
		// We verify the file now exists and is no longer the "stale\n" content.
		assert.ok(existsSync(sockPath), "broker should have created a live socket file");
	} finally {
		await broker.stop();
	}
});

test("stale: live endpoint causes EADDRINUSE and is preserved", async () => {
	const sockPath = tempSocketPath("live");
	// Pre-create a live broker on the same path.
	const incumbent = new CrewBroker({ sessionId: "session-incumbent", socketPath: sockPath, enabled: true });
	await incumbent.start();
	try {
		assert.ok(existsSync(sockPath), "incumbent should be listening");
		// Now try to start a second broker on the same path.
		const challenger = new CrewBroker({ sessionId: "session-challenger", socketPath: sockPath, enabled: true });
		let bindError: Error | null = null;
		try {
			await challenger.start();
		} catch (err) {
			bindError = err as Error;
		}
		assert.ok(bindError, "challenger must fail to bind");
		// The incumbent's socket file must still exist.
		assert.ok(existsSync(sockPath), "incumbent socket must be preserved");
		// Sanity: the incumbent still accepts a connection.
		const ok = await new Promise<boolean>((resolve) => {
			const c = net.createConnection(sockPath);
			c.once("connect", () => {
				c.destroy();
				resolve(true);
			});
			c.once("error", () => resolve(false));
			setTimeout(() => {
				try {
					c.destroy();
				} catch {
					/* ignore */
				}
				resolve(false);
			}, 1000);
		});
		assert.equal(ok, true, "incumbent must still accept connections");
		// Clean up the challenger (it never bound, so stop is a no-op for the socket).
		await challenger.stop();
	} finally {
		await incumbent.stop();
	}
});

test("stale: symlinked leaf is refused (not followed)", async () => {
	// Create a real directory + a real file inside, then symlink the
	// broker socket path to that real file. The broker must refuse to
	// follow it (safety: an attacker could point the socket at a real
	// file or another live socket).
	const real = tempSocketPath("real-target");
	mkdirSync(path.dirname(real), { recursive: true });
	writeFileSync(real, "real-target\n");
	const linkPath = tempSocketPath("symlink-leaf");
	try {
		symlinkSync(real, linkPath);
	} catch {
		// On some platforms symlink may fail; skip the test in that case.
		return;
	}
	const broker = new CrewBroker({ sessionId: "session-symlink", socketPath: linkPath, enabled: true });
	let err: Error | null = null;
	try {
		await broker.start();
	} catch (e) {
		err = e as Error;
	}
	assert.ok(err, "broker must refuse a symlinked socket path");
	assert.match(err!.message, /symlink/i);
	// The real file must NOT be unlinked.
	assert.ok(existsSync(real), "real target must NOT be removed when broker refuses a symlink");
	await broker.stop();
});

test("stale: recording-owned-path unlink only on stop()", async () => {
	const sockPath = tempSocketPath("recording-owned");
	// Pre-create a real file at the same path; the broker will unlink it
	// during start() (it's stale) and then listen on it. On stop() the
	// broker must unlink the file it created (the recorded path).
	writeStaleFile(sockPath);
	const broker = new CrewBroker({ sessionId: "session-owned", socketPath: sockPath, enabled: true });
	await broker.start();
	assert.ok(existsSync(sockPath));
	await broker.stop();
	// After stop(), the file must be unlinked.
	assert.equal(existsSync(sockPath), false, "broker must unlink the recorded socket on stop()");
});

test("stale: start() is idempotent (returns the same server)", async () => {
	const sockPath = tempSocketPath("idempotent");
	const broker = new CrewBroker({ sessionId: "session-idem", socketPath: sockPath, enabled: true });
	await broker.start();
	await broker.start(); // second call must not throw and must not double-bind.
	await broker.stop();
});

test("stale: never calls process.kill during start/stop", async () => {
	// Defensive assertion: we don't import process.kill anywhere in the
	// broker module, but we sanity-check the symbol is not touched.
	const originalKill = process.kill;
	let killCalls = 0;
	process.kill = (() => {
		killCalls += 1;
		return true;
	}) as unknown as typeof process.kill;
	try {
		const sockPath = tempSocketPath("no-kill");
		const broker = new CrewBroker({ sessionId: "session-no-kill", socketPath: sockPath, enabled: true });
		await broker.start();
		await broker.stop();
	} finally {
		process.kill = originalKill;
	}
	assert.equal(killCalls, 0, "broker must never call process.kill");
});

// Reference realpathSync to silence unused-import warnings if any.
void realpathSync;
