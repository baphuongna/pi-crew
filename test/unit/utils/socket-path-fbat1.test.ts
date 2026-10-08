/**
 * socket-path-fbat1.test.ts — F-BAT1 (2026-10-08, live battery catch, P1).
 *
 * Two stacked root causes killed live broker coordination (ask/message/
 * delegate ENOENT in BOTH sync and async runs while runs stayed green):
 *
 * 1. NAMESPACE COLLISION — with XDG_RUNTIME_DIR absent, the broker's per-user
 *    dir fell back to /tmp/pi-crew-<uid>, which THREE /tmp workspace sweeps
 *    (cleanupLegacyOrphanTempDirs, orphan temp reconciler, health zombie
 *    scan) pattern-match as `pi-crew-*` debris and rmSync — deleting the LIVE
 *    broker socket dir. The no-XDG fallback must use a name NO sweep matches.
 * 2. PROBE RACE — removeStaleBrokerSocket treated a connect TIMEOUT as
 *    "stale" and unlinked a HEALTHY (slow-to-accept) broker socket. Only a
 *    definitive ECONNREFUSED may ever unlink (kernel rejects connect on a
 *    socket whose listener is truly gone).
 *
 * Live evidence: session without XDG_RUNTIME_DIR (launched from Paseo
 * terminal), broker bound /tmp/pi-crew-1000/pi-crew-4b3a061a.sock at 10:20,
 * socket gone by 13:11, workers ENOENT, dir itself swept later. Session with
 * XDG_RUNTIME_DIR unaffected (/run/user is never swept).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getPerUserSocketDir, prepareBrokerSocketDir, removeStaleBrokerSocket } from "../../../src/utils/socket-path.ts";

const isWindows = process.platform === "win32";

describe("F-BAT1: broker socket dir must dodge the /tmp pi-crew-* sweeps", { skip: isWindows }, () => {
	let tmpBase: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fbat1-"));
		originalXdg = process.env.XDG_RUNTIME_DIR;
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = originalXdg;
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	it("no-XDG fallback dir name does NOT match the `pi-crew-*` sweep pattern", () => {
		delete process.env.XDG_RUNTIME_DIR;
		const dir = getPerUserSocketDir();
		const base = path.basename(dir);
		assert.equal(path.dirname(dir), os.tmpdir(), "fallback base must be os.tmpdir()");
		assert.match(base, /^\.pi-crew-broker-\d+$/, "fallback leaf must be .pi-crew-broker-<uid>");
		assert.ok(!base.startsWith("pi-crew-"), "fallback leaf must NOT be matched by pi-crew-* sweeps");
	});

	it("with XDG_RUNTIME_DIR set the dir name stays pi-crew-<uid> (unchanged, /run is never swept)", () => {
		process.env.XDG_RUNTIME_DIR = tmpBase;
		const dir = getPerUserSocketDir();
		const uid = process.getuid?.() ?? 0;
		assert.equal(dir, path.join(tmpBase, `pi-crew-${uid}`));
	});
});

describe("F-BAT1: removeStaleBrokerSocket unlinks ONLY on definitive ECONNREFUSED", { skip: isWindows }, () => {
	let tmpBase: string;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fbat1-stale-"));
	});

	afterEach(() => {
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	it("a LIVE (slow-to-accept) listener is KEPT — timeout is not stale (the live-kill bug)", async () => {
		const sockPath = path.join(tmpBase, "probe-timeout.sock");
		// REAL listener: connect success must also yield "kept" (belt).
		const server = net.createServer(() => {
			/* no handler needed — we only exercise the liveness probe */
		});
		await new Promise<void>((resolve) => server.listen(sockPath, resolve));
		assert.ok(fs.existsSync(sockPath), "precondition: listener bound, socket file exists");
		assert.equal(await removeStaleBrokerSocket(sockPath), "kept", "real live listener is kept");

		// DETERMINISTIC timeout pin: an injectable net whose socket NEVER
		// connects nor errors — only the probe timer can fire. Pre-fix this
		// unlinked a HEALTHY broker (live battery F-BAT1).
		const neverConnects = {
			createConnection: (_p: string) => ({
				once: () => {
					/* intentionally silent: the probe timer must be the only signal */
				},
				destroy: () => {
					/* nothing to tear down on a fake socket */
				},
			}),
		};
		const verdict = await removeStaleBrokerSocket(sockPath, 5, neverConnects as never);
		assert.equal(verdict, "kept", "timeout must be treated as LIVE, never stale");
		assert.ok(fs.existsSync(sockPath), "the live socket file must NOT be unlinked");
		server.close();
	});

	it("a DEAD endpoint (non-socket corpse at the path) is REMOVED — deterministically, no connect probe", async () => {
		// Node's server.close() unlinks its own socket path, so the realistic
		// corpse is a leftover non-socket file. A regular file can NEVER be a
		// live endpoint, so it is removed via the lstat branch without the
		// connect probe — cross-platform by construction (connect() to a
		// non-socket path is undefined: Linux ECONNREFUSED, macOS another
		// errno — the CI 2026-10-08 lesson that broke the BSD path).
		const sockPath = path.join(tmpBase, "probe-dead.sock");
		fs.writeFileSync(sockPath, "corpse");

		// Even a netModule that would hang forever cannot protect a non-socket
		// corpse — proves the removal does not ride the probe at all.
		const neverResponds = {
			createConnection: (_p: string) => ({
				once: () => {
					/* silent: probe must not even be consulted */
				},
				destroy: () => {},
			}),
		};
		const verdict = await removeStaleBrokerSocket(sockPath, 5000, neverResponds as never);

		assert.equal(verdict, "removed", "a non-socket entry is definitively stale");
		assert.ok(!fs.existsSync(sockPath), "dead endpoint file must be reclaimed");
	});

	it("a dead SOCKET corpse (refused) is removed; the same socket under timeout is kept", async () => {
		// A REAL socket file with no listener: bind a server, then RENAME the
		// socket file — the inode stays a socket, the listener is gone.
		const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fbat1-corpse-"));
		const livePath = path.join(srcDir, "live.sock");
		const corpsePath = path.join(tmpBase, "probe-corpse.sock");
		const server = net.createServer(() => {});
		await new Promise<void>((resolve) => server.listen(livePath, resolve));
		fs.renameSync(livePath, corpsePath);
		server.close();
		assert.ok(fs.statSync(corpsePath).isSocket(), "precondition: entry is a socket file");

		// Injected probe: definitive ECONNREFUSED => removed.
		const refused = {
			createConnection: (_p: string) => ({
				once: (ev: string, fn: (arg?: unknown) => void) => {
					if (ev === "error") fn({ code: "ECONNREFUSED" });
				},
				destroy: () => {},
			}),
		};
		assert.equal(await removeStaleBrokerSocket(corpsePath, 5000, refused as never), "removed");
		assert.ok(!fs.existsSync(corpsePath), "refused socket corpse must be unlinked");

		// Same shape, probe times out instead => kept (the F-BAT1 live-kill fix).
		// The entry must again be a REAL socket file — a regular file would hit
		// the deterministic lstat branch above and be removed.
		const live2 = path.join(srcDir, "live2.sock");
		const corpse2 = path.join(tmpBase, "probe-corpse2.sock");
		const server2 = net.createServer(() => {});
		await new Promise<void>((resolve) => server2.listen(live2, resolve));
		fs.renameSync(live2, corpse2);
		server2.close();
		assert.ok(fs.statSync(corpse2).isSocket(), "precondition: corpse2 is a socket file");
		fs.writeFileSync(corpsePath, "x");
		const timedOut = {
			createConnection: (_p: string) => ({
				once: () => {
					/* silent: only the timer can fire */
				},
				destroy: () => {},
			}),
		};
		assert.equal(await removeStaleBrokerSocket(corpse2, 5, timedOut as never), "kept", "timeout on a socket entry must never unlink");
		assert.ok(fs.existsSync(corpse2), "the socket corpse must survive a timed-out probe");
		fs.rmSync(corpsePath, { force: true });
		fs.rmSync(srcDir, { recursive: true, force: true });
	});

	it("an absent socket is reported absent (no throw)", async () => {
		const verdict = await removeStaleBrokerSocket(path.join(tmpBase, "never-bound.sock"));
		assert.equal(verdict, "absent");
	});

	it("prepareBrokerSocketDir works under the dot-prefixed fallback dir", async () => {
		const dir = path.join(tmpBase, ".pi-crew-broker-test");
		const sockPath = path.join(dir, "pi-crew-aaaa.sock");
		await prepareBrokerSocketDir(sockPath);
		const st = fs.statSync(dir);
		assert.equal(st.mode & 0o777, 0o700, "dot-prefixed dir still gets 0700");
	});
});
