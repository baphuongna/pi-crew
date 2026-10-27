/**
 * socket-stop.test.ts — B-LOW1/B-LOW2 (MED-1 follow-up wave, 2026-10-26).
 *
 * B-LOW2: stopServerAndRemoveSocket's rename-back must not clobber a leaf a
 *   NEW listener re-bound during the close — restore happens ONLY while
 *   sockPath is still ENOENT; otherwise the shield is kept (+ log).
 * B-LOW1: removeStaleBrokerSocket sweeps `${sockPath}.stopping.<pid>.<hex>`
 *   shield corpses, deleting ONLY those whose embedded pid is provably dead.
 *
 * Unix-only: AF_UNIX socket-file semantics (see crew-broker-stale-socket.test.ts).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test as _test } from "node:test";

import { stopServerAndRemoveSocket } from "../../../../src/runtime/broker/socket-stop.ts";
import { removeStaleBrokerSocket } from "../../../../src/utils/socket-path.ts";

const test = process.platform === "win32" ? _test.skip : _test;

function tempSocketPath(suffix: string): string {
	const dir = path.join(os.tmpdir(), `pc-sockstop-${Date.now()}-${suffix}-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	return path.join(dir, "broker.sock");
}

/** A pid that is provably dead (spawned + reaped in this test process). */
function deadPid(): number {
	const res = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
	assert.equal(res.status, 0, "helper process must exit cleanly");
	assert.ok(typeof res.pid === "number" && res.pid > 0);
	return res.pid!;
}

test("B-LOW2: shield is restored when sockPath stays absent across the close", async () => {
	const sockPath = tempSocketPath("restore");
	writeFileSync(sockPath, "foreign\n"); // unprovably-owned entry (identity=null)
	let closed = false;
	const outcome = await stopServerAndRemoveSocket(sockPath, null, async () => {
		closed = true;
		// No rebind during the close.
	});
	assert.equal(outcome, "shielded-foreign");
	assert.ok(closed, "closeServer must have been called exactly once");
	assert.ok(existsSync(sockPath), "foreign entry must be restored to sockPath");
	assert.equal(readFileSync(sockPath, "utf-8"), "foreign\n");
	const leftovers = readdirSync(path.dirname(sockPath)).filter((e) => e.includes(".stopping."));
	assert.deepEqual(leftovers, [], "no shield corpse may remain after a clean restore");
});

test("B-LOW2: rename-back is SKIPPED when a new listener re-binds sockPath during the close", async () => {
	const sockPath = tempSocketPath("rebind");
	writeFileSync(sockPath, "foreign\n");
	let closed = false;
	const outcome = await stopServerAndRemoveSocket(sockPath, null, async () => {
		closed = true;
		// Simulate a new listener binding the leaf while our handle closes.
		writeFileSync(sockPath, "NEW LISTENER\n");
	});
	assert.equal(outcome, "shielded-foreign");
	assert.ok(closed, "closeServer must have been called exactly once");
	// The new listener's leaf must survive UNTOUCHED…
	assert.equal(readFileSync(sockPath, "utf-8"), "NEW LISTENER\n", "rebound leaf must not be clobbered by the rename-back");
	// …and the shield must be KEPT for the corpse sweep (not silently dropped).
	const shields = readdirSync(path.dirname(sockPath)).filter((e) => e.startsWith(`${path.basename(sockPath)}.stopping.`));
	assert.equal(shields.length, 1, "shield must be kept aside instead of clobbering the fresh bind");
});

test("B-LOW2: owned leaf (identity match) is still unlinked before the close", async () => {
	const sockPath = tempSocketPath("owned");
	writeFileSync(sockPath, "ours\n");
	const st = statSync(sockPath);
	const outcome = await stopServerAndRemoveSocket(sockPath, { dev: st.dev, ino: st.ino }, async () => {
		/* no-op close for the unit seam */
	});
	assert.equal(outcome, "unlinked");
	assert.ok(!existsSync(sockPath));
});

test("B-LOW1: removeStaleBrokerSocket sweeps dead-pid shield corpses and keeps live ones", async () => {
	const sockPath = tempSocketPath("sweep");
	const dir = path.dirname(sockPath);
	const base = path.basename(sockPath);
	const dead = `${sockPath}.stopping.${deadPid()}.aabbcc`;
	const alive = `${sockPath}.stopping.${process.pid}.ddee00`;
	const malformed = `${sockPath}.stopping.notapid.xyz`;
	const unrelated = `${sockPath}.stoppingElse`;
	writeFileSync(dead, "corpse\n");
	writeFileSync(alive, "live shield\n");
	writeFileSync(malformed, "malformed\n");
	writeFileSync(unrelated, "unrelated\n");

	const verdict = await removeStaleBrokerSocket(sockPath);

	assert.equal(verdict, "absent", "sockPath itself never existed");
	assert.ok(!existsSync(dead), "dead-pid shield corpse must be swept");
	assert.ok(existsSync(alive), "live-pid shield must be kept");
	assert.ok(existsSync(malformed), "malformed (non-pid) entries are not swept");
	assert.ok(existsSync(unrelated), "unrelated files are untouched");
});

test("B-LOW1: sweep is best-effort when the directory is missing", async () => {
	const sockPath = path.join(os.tmpdir(), `pc-sockstop-nodir-${Date.now()}-${process.pid}`, "broker.sock");
	assert.equal(await removeStaleBrokerSocket(sockPath), "absent");
});
