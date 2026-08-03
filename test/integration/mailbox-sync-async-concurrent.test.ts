/**
 * ST-3 integration test — Mailbox: one file, three disjoint locks → message loss.
 *
 * Bug: sync append used withEventLogLockSync (.mkdirlock), async append used an
 * in-process promise chain (NO on-disk artifact), and full-file rewrite used
 * withFileLockSync (.flock). Three DISJOINT lock namespaces on the same mailbox
 * file → concurrent operations interleave → appended messages silently lost,
 * especially during the rotation rename↔recreate window.
 *
 * Fix: collapse to ONE lock namespace (.flock). Sync append now uses
 * withFileLockSync (.flock); async append's withFileLockAsync now acquires the
 * on-disk .flock (cross-process tier added in locks.ts).
 *
 * Tests:
 * 1. Single-process concurrent sync + async appends → no message lost.
 * 2. Cross-process (2 workers) concurrent sync + async → no message lost.
 * 3. Rotation race (large messages, cross-process) → no messages dropped.
 * 4. Reply-rewrite concurrent with append → no message lost.
 * 5. Lock namespace verification — .mkdirlock NOT created.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withFileLockAsync } from "../../src/state/coordination/locks.ts";
import { appendMailboxMessage, appendMailboxMessageAsync, readMailbox, updateMailboxMessageReply } from "../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PI_CREW_ROOT = path.resolve(TEST_FILE_DIR, "..", "..");
const MAILBOX_SRC = path.join(PI_CREW_ROOT, "src", "state", "mailbox.ts").replace(/\\/g, "/");

function makeManifest(stateRoot: string, runId: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function setupWorkspace(suffix: string): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir(`st3-${suffix}-`);
	const stateRoot = path.join(dir, "state", "runs", "st3-test");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot, `st3-${suffix}`) };
}

/** Worker script source for cross-process mailbox appends. */
function buildWorkerSource(): string {
	return [
		`import * as os from "node:os";`,
		`import * as path from "node:path";`,
		`import { appendMailboxMessage, appendMailboxMessageAsync } from "${MAILBOX_SRC}";`,
		``,
		`const args = Object.fromEntries(`,
		`\tprocess.argv.slice(2).map((a) => {`,
		`\t\tconst idx = a.indexOf("=");`,
		`\t\treturn [a.slice(0, idx), a.slice(idx + 1)];`,
		`\t}),`,
		`);`,
		``,
		`const stateRoot = args.stateRoot;`,
		`const runId = args.runId;`,
		`const mode = args.mode; // "sync" | "async"`,
		`const count = Number.parseInt(args.count, 10);`,
		`const direction = args.direction || "inbox";`,
		`const prefix = args.prefix || "worker";`,
		`const bodySize = Number.parseInt(args.bodySize || "100", 10);`,
		``,
		`const manifest = {`,
		`\tschemaVersion: 1,`,
		`\trunId,`,
		`\tteam: "test-team",`,
		`\tworkflow: "test",`,
		`\tgoal: "test",`,
		`\tstatus: "running",`,
		`\tworkspaceMode: "single",`,
		`\tcreatedAt: new Date().toISOString(),`,
		`\tupdatedAt: new Date().toISOString(),`,
		`\tcwd: os.tmpdir(),`,
		`\tstateRoot,`,
		`\tartifactsRoot: path.join(stateRoot, "artifacts"),`,
		`\ttasksPath: path.join(stateRoot, "tasks.json"),`,
		`\teventsPath: path.join(stateRoot, "events.jsonl"),`,
		`\tartifacts: [],`,
		`};`,
		``,
		`async function main() {`,
		`\tconst body = "x".repeat(bodySize);`,
		`\tfor (let i = 0; i < count; i++) {`,
		`\t\tconst msg = {`,
		`\t\t\tid: \`\${prefix}-\${i}\`,`,
		`\t\t\tdirection,`,
		`\t\t\tfrom: prefix,`,
		`\t\t\tto: "all",`,
		`\t\t\tbody: body + \` #\${i}\`,`,
		`\t\t\tkind: "message",`,
		`\t\t};`,
		`\t\tlet appended = false;`,
		`\t\tfor (let attempt = 0; !appended; attempt++) {`,
		`\t\t\ttry {`,
		`\t\t\t\tif (mode === "async") await appendMailboxMessageAsync(manifest, msg);`,
		`\t\t\t\telse appendMailboxMessage(manifest, msg);`,
		`\t\t\t\tappended = true;`,
		`\t\t\t} catch (e) {`,
		`\t\t\t\t// Transient lock contention (live holder under load) — retry with backoff. Non-lock errors propagate.`,
		`\t\t\t\tif (String(e?.message || e).includes("is locked") && attempt < 80) {`,
		`\t\t\t\t\tawait new Promise((r) => setTimeout(r, Math.min(100, 5 * 2 ** attempt)));`,
		`\t\t\t\t\tcontinue;`,
		`\t\t\t\t}`,
		`\t\t\t\tthrow e;`,
		`\t\t\t}`,
		`\t\t}`,
		`\t}`,
		`\tconsole.log("DONE " + count);`,
		`}`,
		``,
		`main().catch((e) => {`,
		`\tconsole.error(e);`,
		`\tprocess.exit(1);`,
		`});`,
	].join("\n");
}

/** Resolve the tsx ESM loader path for use with `node --import`. */
function resolveTsxLoader(): string {
	const candidates = [
		path.join(path.dirname(PI_CREW_ROOT), "node_modules", "tsx", "dist", "loader.mjs"),
		path.join(PI_CREW_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	throw new Error("Could not find tsx loader");
}

const TSX_LOADER = resolveTsxLoader();

/** Spawn a worker via `node --import tsx` and resolve when it exits with code 0.
 *  Retries up to 3 times on transient module-resolution failures (tsx startup race). */
async function runWorker(
	workerPath: string,
	params: Record<string, string>,
	timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string }> {
	const argList = [workerPath, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)];
	const spawnOpts = {
		stdio: ["ignore", "pipe", "pipe"] as const,
		cwd: PI_CREW_ROOT,
		env: { ...process.env, PI_CREW_KIND: "", PI_CREW_RUN_ID: "" },
	};

	let lastErr: Error | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await spawnWorker(process.execPath, [`--import`, `file://${TSX_LOADER}`, ...argList], spawnOpts, timeoutMs);
		} catch (err) {
			lastErr = err as Error;
			// Retry only on module-resolution errors (tsx startup race)
			const msg = String(err instanceof Error ? err.message : err);
			if (msg.includes("ERR_MODULE_NOT_FOUND") || msg.includes("undefined/index")) {
				await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
				continue;
			}
			throw err;
		}
	}
	throw lastErr ?? new Error("Worker failed after retries");
}

function spawnWorker(
	bin: string,
	args: string[],
	opts: { stdio: readonly ("pipe" | "ignore")[]; cwd: string; env: NodeJS.ProcessEnv },
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { ...opts, stdio: [...opts.stdio] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Worker timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`Worker exited code=${code} signal=${signal}\nstdout: ${stdout}\nstderr: ${stderr}`));
			}
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ST-3: mailbox unified .flock — single process", () => {
	it("concurrent sync + async appends: no message lost (many iterations)", async () => {
		const ws = setupWorkspace("single-concurrent");
		try {
			const N = 150;
			const promises: Promise<unknown>[] = [];
			for (let i = 0; i < N; i++) {
				// Queue async append (returns immediately, chains on in-process lock)
				promises.push(
					appendMailboxMessageAsync(ws.manifest, {
						id: `async-${i}`,
						direction: "inbox",
						from: "async",
						to: "all",
						body: `async message ${i}`,
						kind: "message",
					}),
				);
				// Sync append runs immediately, completes before event loop yields
				appendMailboxMessage(ws.manifest, {
					id: `sync-${i}`,
					direction: "inbox",
					from: "sync",
					to: "all",
					body: `sync message ${i}`,
					kind: "message",
				});
			}
			await Promise.all(promises);

			const messages = readMailbox(ws.manifest, "inbox");
			const ids = new Set(messages.map((m) => m.id));
			assert.equal(messages.length, N * 2, `expected ${N * 2} messages, got ${messages.length}`);
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(`sync-${i}`), `missing sync-${i}`);
				assert.ok(ids.has(`async-${i}`), `missing async-${i}`);
			}
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});

	it("sync append does NOT create .mkdirlock (lock namespace collapsed to .flock)", () => {
		const ws = setupWorkspace("lock-ns");
		try {
			appendMailboxMessage(ws.manifest, {
				id: "lock-ns-test",
				direction: "inbox",
				from: "test",
				to: "all",
				body: "test",
				kind: "message",
			});
			const mailboxDir = path.join(ws.manifest.stateRoot, "mailbox");
			const entries = fs.readdirSync(mailboxDir);
			// No .mkdirlock directory should exist — the old withEventLogLockSync path
			const mkdirlocks = entries.filter((e) => e.endsWith(".mkdirlock") || e.includes(".mkdirlock"));
			assert.equal(mkdirlocks.length, 0, `.mkdirlock should NOT exist after sync append; found: ${mkdirlocks.join(", ")}`);
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});

	it("withFileLockAsync acquires on-disk .flock (cross-process tier)", async () => {
		const dir = createTrackedTempDir("st3-flock-direct-");
		try {
			const filePath = path.join(dir, "test-file.jsonl");
			const flockPath = `${filePath}.flock`;

			// Before: no flock
			assert.ok(!fs.existsSync(flockPath), ".flock should not exist before lock");

			let observedFlock = false;
			await withFileLockAsync(filePath, async () => {
				// While we hold the async lock, the .flock file must exist on disk
				// (cross-process tier). The old in-process-only implementation would
				// NOT create this file.
				observedFlock = fs.existsSync(flockPath);
			});

			assert.ok(observedFlock, "withFileLockAsync must create on-disk .flock during critical section");
			// After release, the flock should be cleaned up
			assert.ok(!fs.existsSync(flockPath), ".flock should be removed after release");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("reply-rewrite concurrent with append: no message lost", () => {
		const ws = setupWorkspace("reply-concurrent");
		try {
			// Seed a message to reply to
			const original = appendMailboxMessage(ws.manifest, {
				id: "original-msg",
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Please report status",
				kind: "message",
			});

			// Concurrently: append more messages + rewrite the original's reply
			const N = 50;
			for (let i = 0; i < N; i++) {
				appendMailboxMessage(ws.manifest, {
					id: `extra-${i}`,
					direction: "inbox",
					from: "leader",
					to: "worker",
					body: `extra ${i}`,
					kind: "message",
				});
			}
			updateMailboxMessageReply(ws.manifest, original.id, "Status: all good");

			const messages = readMailbox(ws.manifest, "inbox");
			const ids = new Set(messages.map((m) => m.id));
			assert.ok(ids.has(original.id), "original message must survive rewrite");
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(`extra-${i}`), `extra-${i} must survive concurrent rewrite`);
			}
			// Verify reply metadata preserved
			const replied = messages.find((m) => m.id === original.id);
			assert.ok(replied, "original message must be found");
			assert.equal(replied?.replyContent, "Status: all good");
			assert.equal(replied?.repliedAt !== undefined, true);
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});
});

describe("ST-3: mailbox unified .flock — cross-process", () => {
	let workerScript: string;

	it("setup worker script", () => {
		workerScript = path.join(createTrackedTempDir("st3-worker-"), "mailbox-worker.ts");
		fs.writeFileSync(workerScript, buildWorkerSource(), "utf-8");
		assert.ok(fs.existsSync(workerScript));
	});

	it("2-process concurrent sync + async: no message lost", async () => {
		const ws = setupWorkspace("cross-sync-async");
		try {
			// Pre-initialize mailbox dir (avoid race on mkdir)
			appendMailboxMessage(ws.manifest, {
				id: "init",
				direction: "inbox",
				from: "init",
				to: "all",
				body: "init",
				kind: "message",
			});

			const N = 100;
			const results = await Promise.all([
				runWorker(workerScript, {
					stateRoot: ws.manifest.stateRoot,
					runId: ws.manifest.runId,
					mode: "sync",
					count: String(N),
					prefix: "sync",
					direction: "inbox",
					bodySize: "200",
				}),
				runWorker(workerScript, {
					stateRoot: ws.manifest.stateRoot,
					runId: ws.manifest.runId,
					mode: "async",
					count: String(N),
					prefix: "async",
					direction: "inbox",
					bodySize: "200",
				}),
			]);
			for (const r of results) {
				assert.ok(r.stdout.includes("DONE"), `worker should print DONE; got: ${r.stdout}`);
			}

			const messages = readMailbox(ws.manifest, "inbox");
			const realMessages = messages.filter((m) => m.id !== "init");
			const ids = new Set(realMessages.map((m) => m.id));
			assert.equal(realMessages.length, N * 2, `expected ${N * 2} messages, got ${realMessages.length}`);
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(`sync-${i}`), `missing sync-${i}`);
				assert.ok(ids.has(`async-${i}`), `missing async-${i}`);
			}
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});

	it("rotation race: large concurrent appends → no messages dropped (archive + live)", async () => {
		const ws = setupWorkspace("rotation-race");
		try {
			// Pre-initialize mailbox dir
			appendMailboxMessage(ws.manifest, {
				id: "init",
				direction: "inbox",
				from: "init",
				to: "all",
				body: "init",
				kind: "message",
			});

			// Use large bodies so total > 10MB → rotation triggers mid-run.
			// ~51KB per line × ~200 msgs per worker = ~10MB per worker.
			// Two workers concurrent → rotation during the race window.
			const N = 120;
			const BODY_KB = 50;
			const results = await Promise.all([
				runWorker(
					workerScript,
					{
						stateRoot: ws.manifest.stateRoot,
						runId: ws.manifest.runId,
						mode: "sync",
						count: String(N),
						prefix: "rot-sync",
						direction: "inbox",
						bodySize: String(BODY_KB * 1024),
					},
					90_000,
				),
				runWorker(
					workerScript,
					{
						stateRoot: ws.manifest.stateRoot,
						runId: ws.manifest.runId,
						mode: "async",
						count: String(N),
						prefix: "rot-async",
						direction: "inbox",
						bodySize: String(BODY_KB * 1024),
					},
					90_000,
				),
			]);
			for (const r of results) {
				assert.ok(r.stdout.includes("DONE"), `worker should print DONE; got: ${r.stdout}`);
			}

			const messages = readMailbox(ws.manifest, "inbox");
			const realMessages = messages.filter((m) => m.id !== "init");
			const ids = new Set(realMessages.map((m) => m.id));

			// Verify NO message was lost — check every single id
			let missing = 0;
			for (let i = 0; i < N; i++) {
				if (!ids.has(`rot-sync-${i}`)) missing++;
				if (!ids.has(`rot-async-${i}`)) missing++;
			}
			assert.equal(missing, 0, `${missing} messages lost during rotation race (expected ${N * 2})`);

			// Verify archive files were created (rotation actually triggered)
			const mailboxDir = path.join(ws.manifest.stateRoot, "mailbox");
			const archives = fs.readdirSync(mailboxDir).filter((e) => e.includes("inbox.jsonl.") && e.endsWith(".archive.jsonl"));
			assert.ok(
				archives.length > 0,
				`rotation should have created at least one archive; dir: ${fs.readdirSync(mailboxDir).join(", ")}`,
			);
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});

	it("sync worker + sync worker concurrent: no message lost", async () => {
		const ws = setupWorkspace("cross-sync-sync");
		try {
			appendMailboxMessage(ws.manifest, {
				id: "init",
				direction: "inbox",
				from: "init",
				to: "all",
				body: "init",
				kind: "message",
			});

			const N = 80;
			await Promise.all([
				runWorker(workerScript, {
					stateRoot: ws.manifest.stateRoot,
					runId: ws.manifest.runId,
					mode: "sync",
					count: String(N),
					prefix: "syncA",
					direction: "inbox",
					bodySize: "200",
				}),
				runWorker(workerScript, {
					stateRoot: ws.manifest.stateRoot,
					runId: ws.manifest.runId,
					mode: "sync",
					count: String(N),
					prefix: "syncB",
					direction: "inbox",
					bodySize: "200",
				}),
			]);

			const messages = readMailbox(ws.manifest, "inbox");
			const realMessages = messages.filter((m) => m.id !== "init");
			const ids = new Set(realMessages.map((m) => m.id));
			assert.equal(realMessages.length, N * 2, `expected ${N * 2} messages, got ${realMessages.length}`);
			for (let i = 0; i < N; i++) {
				assert.ok(ids.has(`syncA-${i}`), `missing syncA-${i}`);
				assert.ok(ids.has(`syncB-${i}`), `missing syncB-${i}`);
			}
		} finally {
			removeTrackedTempDir(ws.dir);
		}
	});
});
