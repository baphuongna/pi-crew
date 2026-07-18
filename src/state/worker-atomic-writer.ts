/**
 * Phase 1.5 worker-thread atomic writer (RFC: 15-PHASE1.5-WORKER-WRITER-RFC.md).
 *
 * Background: multi-step goal-wrapped workflows crash silently and
 * non-deterministically during batch transitions. The crash point moves to
 * every `await` yield in the write path (mkdir, open, stat, rename,
 * appendEvent). Sync replacements regress. Hypothesis: V8/libuv-level race
 * during event-loop yields. Mitigation: route writes through a dedicated
 * worker thread that performs SYNC fs operations with no internal yields.
 *
 * Opt-in via `PI_CREW_WORKER_ATOMIC_WRITER=1`. When disabled, callers fall
 * back to the regular async path. Safe to ship behind a flag.
 *
 * Protocol (main → worker):
 *   { kind: "write", id, filePath, content }
 *   { kind: "mkdir", id, dirPath }
 *   { kind: "append", id, filePath, content }
 *
 * Protocol (worker → main):
 *   { kind: "done", id }
 *   { kind: "error", id, message }
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

const require = createRequire(import.meta.url);

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

/** Worker script source — runs SYNC fs ops with no internal yields. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function isSymlinkSafePath(filePath) {
  try {
    // Safe roots: the system temp dir (resolved through any symlinks, e.g.
    // macOS /var → /private/var) and the current project cwd.
    var tmpReal;
    try { tmpReal = fs.realpathSync(require("node:os").tmpdir()); } catch (e2) { tmpReal = require("node:os").tmpdir(); }
    var cwd = process.cwd();
    // Accept a symlink ancestor as safe if the resolved target (a) IS a safe
    // root, (b) is UNDER a safe root (target is a descendant), or (c) is an
    // ANCESTOR of a safe root (target is a parent dir of a safe root).
    // Case (c) is essential on macOS: /var → /private/var is an ancestor of
    // the tmpdir /private/var/folders/…, so it must be allowed.
    var isSafeAncestor = function (real) {
      var roots = [tmpReal, cwd];
      return roots.some(function (root) {
        return real === root
          || real.indexOf(root + path.sep) === 0
          || root.indexOf(real + path.sep) === 0;
      });
    };
    var currentPath = filePath;
    while (currentPath !== path.dirname(currentPath)) {
      var dir = path.dirname(currentPath);
      try {
        var stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink()) {
          var real = fs.realpathSync(dir);
          if (!isSafeAncestor(real)) return false;
        }
      } catch (e3) { /* not found — fine */ }
      currentPath = dir;
    }
    return true;
  } catch (e) { return true; }
}

function syncAtomicWriteFile(filePath, content) {
  if (!isSymlinkSafePath(filePath)) throw new Error("Refusing to write: unsafe path: " + filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, content, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    // If rename raced with another writer that produced identical content, swallow.
    if (error && error.code === "EEXIST") {
      try {
        const existing = fs.readFileSync(filePath, "utf-8");
        if (existing === content) return;
      } catch {}
    }
    throw error;
  }
}

function syncAppend(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content, "utf-8");
}

parentPort.on("message", (msg) => {
  try {
    if (msg.kind === "write") syncAtomicWriteFile(msg.filePath, msg.content);
    else if (msg.kind === "mkdir") fs.mkdirSync(msg.dirPath, { recursive: true });
    else if (msg.kind === "append") syncAppend(msg.filePath, msg.content);
    else throw new Error("worker-atomic-writer: unknown message kind: " + msg.kind);
    parentPort.postMessage({ kind: "done", id: msg.id });
  } catch (error) {
    parentPort.postMessage({ kind: "error", id: msg.id, message: error && error.message ? error.message : String(error) });
  }
});
`;

function getWorker(): Worker {
	if (worker) return worker;
	// Write worker source to a temp file (so Worker can load it as CJS via
	// require() inside the worker, which always has CommonJS available).
	const os = require("node:os");
	const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waw-")), "worker.cjs");
	fs.writeFileSync(tmpPath, WORKER_SOURCE, "utf-8");
	worker = new Worker(tmpPath);
	worker.on("message", (msg: { kind: string; id: number; message?: string }) => {
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		if (msg.kind === "done") entry.resolve();
		else entry.reject(new Error(msg.message ?? "worker-atomic-writer: unknown error"));
	});
	worker.on("error", (error: Error) => {
		// Reject ALL pending requests — worker died.
		for (const [, entry] of pending) entry.reject(error);
		pending.clear();
		worker = undefined;
	});
	worker.unref(); // don't keep event loop alive (unless tests request it)
	if (keepRefForTests) worker.ref();
	return worker;
}

function dispatch(kind: "write" | "mkdir" | "append", payload: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const id = nextRequestId++;
		pending.set(id, { resolve, reject });
		try {
			getWorker().postMessage({ kind, id, ...payload });
		} catch (error) {
			pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

/** Whether the worker writer is enabled (env var opt-in). */
export function isWorkerAtomicWriterEnabled(): boolean {
	return process.env.PI_CREW_WORKER_ATOMIC_WRITER === "1" || process.env.PI_TEAMS_WORKER_ATOMIC_WRITER === "1";
}

/** Atomic-write a file via the worker thread. Sync fs ops inside worker. */
export function atomicWriteFileViaWorker(filePath: string, content: string): Promise<void> {
	return dispatch("write", { filePath, content });
}

/** Append to a file via the worker thread (used by event-log). */
export function appendFileViaWorker(filePath: string, content: string): Promise<void> {
	return dispatch("append", { filePath, content });
}

/** Terminate the worker (for tests / cleanup). */
export function terminateWorkerAtomicWriter(): void {
	if (worker) {
		const w = worker;
		worker = undefined;
		w.terminate().catch(() => {
			/* ignore */
		});
	}
	for (const [, entry] of pending) entry.reject(new Error("worker terminated"));
	pending.clear();
}

/** Tests-only knob: keep the worker ref'd so the test runner doesn't exit
 *  before promises resolve. Production code leaves this false (worker is
 *  unref'd to avoid blocking process exit). */
let keepRefForTests = false;
export function __setKeepWorkerRefForTests(value: boolean): void {
	keepRefForTests = value;
}
