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

	it("a DEAD endpoint (non-socket corpse at the path) is REMOVED via definitive ECONNREFUSED", async () => {
		// Node's server.close() unlinks its own socket path, so the realistic
		// corpse is a leftover non-socket file (or a socket whose owner was
		// SIGKILLed after the file got detached) — connect() to it yields the
		// definitive ECONNREFUSED the reclaimer needs.
		const sockPath = path.join(tmpBase, "probe-dead.sock");
		fs.writeFileSync(sockPath, "corpse");

		const verdict = await removeStaleBrokerSocket(sockPath);

		assert.equal(verdict, "removed", "ECONNREFUSED is the one definitive stale signal");
		assert.ok(!fs.existsSync(sockPath), "dead endpoint file must be reclaimed");
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
