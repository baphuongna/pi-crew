/**
 * pingSocketSync dual-module-mode regression lock (battery 2026-10-07 finding).
 *
 * The herdr liveness probe evaluates a Worker source string with bare
 * `require(...)`. An eval'd Worker inherits the HOST's module detection:
 * under a `--input-type=module` host the source parses as ESM, `require`
 * throws ReferenceError, and the ping fail-closed to false — herdr degraded
 * "socket not live" against a LIVE socket (found live during the T10c probe;
 * CJS hosts like the real pi CLI were unaffected).
 *
 * The worker source is now dual-mode (require try → dynamic import fallback).
 * Pinned against a REAL unix socket in BOTH module contexts:
 *   1. in-process — this suite runs as ESM (`type: "module"`), i.e. the
 *      previously-broken eval-worker path,
 *   2. a child node forced ESM via --input-type=module (the exact battery
 *      repro), and
 *   3. fail-closed false on a socket with no listener.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pingSocketSync } from "../../../../src/runtime/surface/resolve-surface.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESOLVE_SURFACE_SRC = path.join(MODULE_DIR, "..", "..", "..", "..", "src", "runtime", "surface", "resolve-surface.ts");

/** Real listening IPC endpoint on a throwaway path.
 *
 * unix: a real unix-domain socket under a tmp dir. win32: file-path IPC is
 * unsupported, so use a named pipe (\\.\pipe\…) — same liveness semantics
 * for connect-only probes. */
function ipcListenPath(tag: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pc-ping-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-ping-${tag}-`));
	return path.join(dir, "ping.sock");
}

function withLiveSocket<T>(fn: (socketPath: string) => T): T {
	const socketPath = ipcListenPath("live");
	const cleanup = () => {
		if (process.platform !== "win32") {
			fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
		}
	};
	const server = net.createServer(() => {
		// accept-and-forget — the liveness probe only needs connect()
	});
	server.listen(socketPath);
	try {
		return fn(socketPath);
	} finally {
		server.close();
		cleanup();
	}
}

test("pingSocketSync: live socket → true in-process (ESM host, type:module)", () => {
	withLiveSocket((socketPath) => {
		assert.equal(pingSocketSync(socketPath, 2000), true, "live socket must ping true in an ESM host");
	});
});

test("pingSocketSync: live socket → true from a forced-ESM child (--input-type=module)", () => {
	withLiveSocket((socketPath) => {
		const probe = `
			const m = await import(${JSON.stringify(pathToFileURL(RESOLVE_SURFACE_SRC).href)});
			console.log(m.pingSocketSync(${JSON.stringify(socketPath)}, 2000));
		`;
		const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", probe], {
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(r.status, 0, `ESM child failed: ${r.stderr}`);
		assert.match(r.stdout, /true/, `ESM child ping must be true, got: ${r.stdout}`);
	});
});

test("pingSocketSync: dead path (no listener) → false, fail-closed", () => {
	const deadPath = ipcListenPath("dead");
	if (process.platform !== "win32") {
		// keep the parent dir for cleanup; on win32 the pipe name simply does
		// not exist server-side.
		assert.equal(pingSocketSync(deadPath, 2000), false, "dead socket path must fail closed");
		fs.rmSync(path.dirname(deadPath), { recursive: true, force: true });
	} else {
		assert.equal(pingSocketSync(deadPath, 2000), false, "dead pipe path must fail closed");
	}
});
