import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	atomicWriteFile,
	atomicWriteJson,
	atomicWriteJsonAsync,
	atomicWriteFileAsync,
	readJsonFile,
	renameWithRetry,
	flushPendingAtomicWrites,
	atomicWriteJsonCoalesced,
} from "../../src/state/atomic-write.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function tmpDir(): string {
	return createTrackedTempDir("pi-crew-aw-cov-");
}

describe("atomicWriteFile", () => {
	it("writes content to a new file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.txt");
		atomicWriteFile(filePath, "hello world");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "hello world");
		removeTrackedTempDir(dir);
	});

	it("overwrites existing file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.txt");
		atomicWriteFile(filePath, "first");
		atomicWriteFile(filePath, "second");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "second");
		removeTrackedTempDir(dir);
	});

	it("creates parent directories if needed", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "sub", "dir", "file.txt");
		atomicWriteFile(filePath, "nested");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "nested");
		removeTrackedTempDir(dir);
	});

	it("writes UTF-8 content", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "utf8.txt");
		atomicWriteFile(filePath, "héllo wörld 你好");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "héllo wörld 你好");
		removeTrackedTempDir(dir);
	});
});

describe("atomicWriteJson", () => {
	it("writes pretty-printed JSON", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "data.json");
		atomicWriteJson(filePath, { a: 1, b: "two" });
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		assert.equal(parsed.a, 1);
		assert.equal(parsed.b, "two");
		assert.ok(content.includes("\n"), "should be pretty-printed");
		removeTrackedTempDir(dir);
	});

	it("overwrites existing JSON file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "data.json");
		atomicWriteJson(filePath, { v: 1 });
		atomicWriteJson(filePath, { v: 2 });
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(data.v, 2);
		removeTrackedTempDir(dir);
	});

	it("handles arrays", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "arr.json");
		atomicWriteJson(filePath, [1, 2, 3]);
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.deepEqual(data, [1, 2, 3]);
		removeTrackedTempDir(dir);
	});
});

describe("atomicWriteFileAsync", () => {
	it("writes content asynchronously", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "async.txt");
		await atomicWriteFileAsync(filePath, "async hello");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "async hello");
		removeTrackedTempDir(dir);
	});

	it("creates parent directories", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "deep", "file.txt");
		await atomicWriteFileAsync(filePath, "deep content");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "deep content");
		removeTrackedTempDir(dir);
	});
});

describe("atomicWriteJsonAsync", () => {
	it("writes JSON asynchronously", async () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "async.json");
		await atomicWriteJsonAsync(filePath, { key: "value" });
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(parsed.key, "value");
		removeTrackedTempDir(dir);
	});
});

describe("readJsonFile", () => {
	it("reads and parses existing JSON file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "read.json");
		fs.writeFileSync(filePath, '{"x":42}');
		const result = readJsonFile<{ x: number }>(filePath);
		assert.equal(result?.x, 42);
		removeTrackedTempDir(dir);
	});

	it("returns undefined for missing file", () => {
		const result = readJsonFile("/nonexistent/path/file.json");
		assert.equal(result, undefined);
	});

	it("returns undefined for invalid JSON", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "bad.json");
		fs.writeFileSync(filePath, "not json");
		const result = readJsonFile(filePath);
		assert.equal(result, undefined);
		removeTrackedTempDir(dir);
	});
});

describe("renameWithRetry", () => {
	it("renames a file", () => {
		const dir = tmpDir();
		const src = path.join(dir, "src.txt");
		const dst = path.join(dir, "dst.txt");
		fs.writeFileSync(src, "data");
		renameWithRetry(src, dst);
		assert.ok(fs.existsSync(dst));
		assert.ok(!fs.existsSync(src));
		removeTrackedTempDir(dir);
	});

	it("retries on retryable errors", () => {
		let attempts = 0;
		const rename = (_src: string, _dst: string) => {
			attempts++;
			if (attempts < 3) {
				const err = new Error("busy") as NodeJS.ErrnoException;
				err.code = "EBUSY";
				throw err;
			}
		};
		// Should succeed after retrying
		renameWithRetry("/tmp/x", "/tmp/y", 5, rename);
		assert.ok(attempts >= 3);
	});

	it("throws on non-retryable error", () => {
		const rename = () => {
			const err = new Error("nope") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		};
		assert.throws(() => renameWithRetry("/tmp/x", "/tmp/y", 3, rename));
	});
});

describe("atomicWriteJsonCoalesced + flushPendingAtomicWrites", () => {
	it("coalesces multiple writes and flushes", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "coalesced.json");
		// Write multiple times rapidly — only last value should win
		atomicWriteJsonCoalesced(filePath, { v: 1 }, 10);
		atomicWriteJsonCoalesced(filePath, { v: 2 }, 10);
		atomicWriteJsonCoalesced(filePath, { v: 3 }, 10);
		// Flush immediately
		flushPendingAtomicWrites();
		const result = readJsonFile<{ v: number }>(filePath);
		assert.equal(result?.v, 3);
		removeTrackedTempDir(dir);
	});
});
