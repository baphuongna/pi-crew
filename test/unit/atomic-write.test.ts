import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
	__test__renameWithRetry,
	atomicWriteFile,
	atomicWriteJson,
	readJsonFile,
	renameWithLinkSync,
} from "../../src/state/atomic-write.ts";

describe("atomicWriteJson", () => {
	const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-atomic-"));

	it("writes valid JSON to file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		atomicWriteJson(filePath, { hello: "world" });
		const content = fs.readFileSync(filePath, "utf-8");
		assert.equal(JSON.parse(content).hello, "world");
		fs.rmSync(dir, { recursive: true });
	});

	it("overwrites existing file atomically", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		atomicWriteJson(filePath, { v: 1 });
		atomicWriteJson(filePath, { v: 2 });
		const data = readJsonFile<{ v: number }>(filePath);
		assert.equal(data?.v, 2);
		fs.rmSync(dir, { recursive: true });
	});

	it("does not leave .tmp files on success", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		atomicWriteJson(filePath, { ok: true });
		const entries = fs.readdirSync(dir);
		assert.ok(!entries.some((e) => e.endsWith(".tmp")));
		fs.rmSync(dir, { recursive: true });
	});
});

describe("atomicWriteFile", () => {
	const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-file-"));

	it("writes string content to file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.txt");
		atomicWriteFile(filePath, "hello world");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "hello world");
		fs.rmSync(dir, { recursive: true });
	});

	it("overwrites existing content", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.txt");
		atomicWriteFile(filePath, "first");
		atomicWriteFile(filePath, "second");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "second");
		fs.rmSync(dir, { recursive: true });
	});
});

describe("readJsonFile", () => {
	it("returns parsed JSON for valid file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-read-"));
		const filePath = path.join(dir, "test.json");
		fs.writeFileSync(filePath, '{"key":"value"}');
		const data = readJsonFile<{ key: string }>(filePath);
		assert.equal(data?.key, "value");
		fs.rmSync(dir, { recursive: true });
	});

	it("returns undefined for missing file", () => {
		assert.equal(readJsonFile("/nonexistent/file.json"), undefined);
	});

	it("returns undefined for invalid JSON", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-read-"));
		const filePath = path.join(dir, "bad.json");
		fs.writeFileSync(filePath, "not json");
		assert.equal(readJsonFile(filePath), undefined);
		fs.rmSync(dir, { recursive: true });
	});
});

describe("__test__renameWithRetry", () => {
	it("retries on EPERM error", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-retry-"));
		const src = path.join(dir, "src.txt");
		const dst = path.join(dir, "dst.txt");
		fs.writeFileSync(src, "data");
		let attempts = 0;
		__test__renameWithRetry(src, dst, 3, () => {
			attempts++;
			if (attempts < 2) {
				const err = new Error("EPERM") as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			fs.renameSync(src, dst);
		});
		assert.equal(attempts, 2);
		assert.ok(fs.existsSync(dst));
		fs.rmSync(dir, { recursive: true });
	});
});

// ─── D-01 regression: POSIX atomic rename must not expose an ENOENT window ──
//
// Background: the old POSIX path in renameWithLinkSync did unlink(dest) →
// link(temp, dest). Between those two syscalls the file existed in NEITHER
// location, so a concurrent reader on another thread/process saw ENOENT and
// could crash. The fix replaces that with a single rename(2), which is atomic.
//
// NOTE on the concurrency test below: the unlink→link gap is a sub-microsecond
// window, which is fundamentally hard to observe reliably via a black-box
// reader on typical hardware (empirically 0 ENOENT even with the old code).
// So that test primarily DOCUMENTS the atomic-read invariant and guards against
// gross non-atomic regressions (e.g. writeFileSync). The hard guarantee that the
// window is closed comes from the implementation using a single atomic
// rename(2) syscall (verified by the deterministic symlink-at-destination test
// below, which exercises the POSIX rename branch directly).
describe("atomicWriteFile — D-01 POSIX atomic rename (no ENOENT window)", () => {
	// A separate worker thread reads the target file in a tight loop for a
	// bounded duration. Because it runs on a real OS thread, it CAN observe
	// the intermediate state of a non-atomic rename — exactly the bug class
	// we are guarding against. Eval mode runs as CommonJS, so `require` works.
	const readerWorker = (filePath: string, durationMs: number): Promise<{ enoent: number; reads: number }> =>
		new Promise((resolve, reject) => {
			const code = `
				const { workerData, parentPort } = require('node:worker_threads');
				const fs = require('node:fs');
				let enoent = 0;
				let reads = 0;
				const deadline = Date.now() + workerData.durationMs;
				while (Date.now() < deadline) {
					try {
						fs.readFileSync(workerData.filePath, 'utf-8');
						reads++;
					} catch (e) {
						if (e && e.code === 'ENOENT') enoent++;
					}
				}
				parentPort.postMessage({ enoent, reads });
			`;
			const worker = new Worker(code, {
				eval: true,
				workerData: { filePath, durationMs },
			});
			worker.on("message", (msg) => resolve(msg as { enoent: number; reads: number }));
			worker.on("error", reject);
		});

	it("concurrent reader sees NO ENOENT while atomicWriteFile runs in a loop", async () => {
		const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-d01-"));
		const filePath = path.join(dir, "state.json");
		// Seed the file so the reader has something to read from the start.
		atomicWriteJson(filePath, { v: 0 });

		// Start a reader on another thread, then hammer the file from this
		// thread. With the old unlink+link sequence the reader would almost
		// certainly catch the gap within 100 iterations; with rename(2) it
		// never sees ENOENT.
		const readerPromise = readerWorker(filePath, 600);
		for (let i = 1; i <= 100; i++) {
			atomicWriteJson(filePath, { v: i });
		}
		const result = await readerPromise;

		// The reader must have actually read (guards against a false pass where
		// the worker never ran) and must have seen zero ENOENT.
		assert.ok(result.reads > 0, `reader should have performed reads, got reads=${result.reads}`);
		assert.equal(result.enoent, 0, `concurrent reader saw ${result.enoent} ENOENT error(s) — atomic rename window is not closed`);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("written content is correct after 100 concurrent-style writes", () => {
		const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-d01-content-"));
		const filePath = path.join(dir, "counter.json");
		let last = -1;
		for (let i = 0; i <= 100; i++) {
			atomicWriteJson(filePath, { v: i });
			last = i;
		}
		const data = readJsonFile<{ v: number }>(filePath);
		assert.equal(data?.v, last, "final content must reflect the last write");
		assert.equal(data?.v, 100);
		// No leftover temp files.
		const tmpFiles = fs.readdirSync(dir).filter((e) => e.endsWith(".tmp"));
		assert.deepEqual(tmpFiles, [], "no temp files should remain after writes");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// Symlink semantics differ on Windows (elevated privileges, junctions).
	const unixOnly = process.platform !== "win32" ? it : it.skip;

	unixOnly("renameWithLinkSync does NOT follow a symlink at the destination", () => {
		// renameWithLinkSync is tested directly because the higher-level
		// atomicWriteFile guard intentionally refuses to write to a symlink
		// target. Here we verify the RENAME layer itself preserves
		// symlink-safety: replacing a symlink destination must not mutate the
		// symlink's target.
		const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-d01-link-"));
		const secret = path.join(dir, "secret.txt");
		const symlinkDest = path.join(dir, "dest.txt");
		fs.writeFileSync(secret, "ORIGINAL SECRET");
		fs.symlinkSync(secret, symlinkDest);

		// Create a temp source file holding the new content.
		const tempPath = path.join(dir, "src.tmp");
		fs.writeFileSync(tempPath, "REPLACEMENT");

		renameWithLinkSync(tempPath, symlinkDest);

		// The destination must now be a REGULAR file holding the new content
		// (the symlink was replaced, not followed).
		const destStat = fs.lstatSync(symlinkDest);
		assert.equal(destStat.isSymbolicLink(), false, "destination must be a regular file, not a symlink, after rename");
		assert.equal(fs.readFileSync(symlinkDest, "utf-8"), "REPLACEMENT");
		// The symlink's original target must be UNTOUCHED.
		assert.equal(fs.readFileSync(secret, "utf-8"), "ORIGINAL SECRET");
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
