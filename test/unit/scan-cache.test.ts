/**
 * Tests for src/utils/scan-cache.ts
 * Coverage:
 * - get/set/list/invalidate basic lifecycle
 * - TTL expiration
 * - maxEntries eviction (oldest by insertion order)
 * - readAndCache: cache hit, cache miss, file not found
 * - scanAndCache: directory scan, JSON parse
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SharedScanCache } from "../../src/utils/scan-cache.ts";

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "scan-cache-test-"));

test("SharedScanCache get returns undefined for missing bucket", () => {
	const cache = new SharedScanCache();
	assert.equal(cache.get("nonexistent", "key"), undefined);
});

test("SharedScanCache set then get returns the entry", () => {
	const cache = new SharedScanCache();
	cache.set("bucket", { key: "k1", path: "/x", raw: "data", mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	const entry = cache.get("bucket", "k1");
	assert.ok(entry);
	assert.equal(entry?.raw, "data");
});

test("SharedScanCache list returns sorted entries", () => {
	const cache = new SharedScanCache();
	const now = Date.now();
	cache.set("b", { key: "b", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	cache.set("b", { key: "a", path: "", raw: 2, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	cache.set("b", { key: "c", path: "", raw: 3, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	const list = cache.list("b");
	assert.deepEqual(list.map((e) => e.key), ["a", "b", "c"]);
});

test("SharedScanCache TTL expiration", async () => {
	const cache = new SharedScanCache({ ttlMs: 50 });
	cache.set("b", { key: "k", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	assert.ok(cache.get("b", "k"));
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(cache.get("b", "k"), undefined);
});

test("SharedScanCache maxEntries evicts oldest insertion", () => {
	const cache = new SharedScanCache({ maxEntries: 2, ttlMs: 60_000 });
	const now = Date.now();
	cache.set("b", { key: "k1", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	cache.set("b", { key: "k2", path: "", raw: 2, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	cache.set("b", { key: "k3", path: "", raw: 3, mtimeMs: 1, sizeBytes: 1, loadedAtMs: now });
	// k1 should be evicted (oldest)
	assert.equal(cache.get("b", "k1"), undefined);
	assert.ok(cache.get("b", "k2"));
	assert.ok(cache.get("b", "k3"));
});

test("SharedScanCache invalidate removes a specific key", () => {
	const cache = new SharedScanCache();
	cache.set("b", { key: "k1", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.set("b", { key: "k2", path: "", raw: 2, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.invalidate("b", "k1");
	assert.equal(cache.get("b", "k1"), undefined);
	assert.ok(cache.get("b", "k2"));
});

test("SharedScanCache invalidateBucket removes the entire bucket", () => {
	const cache = new SharedScanCache();
	cache.set("b1", { key: "k", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.set("b2", { key: "k", path: "", raw: 2, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.invalidateBucket("b1");
	assert.equal(cache.get("b1", "k"), undefined);
	assert.ok(cache.get("b2", "k"));
});

test("SharedScanCache clear removes everything", () => {
	const cache = new SharedScanCache();
	cache.set("b1", { key: "k", path: "", raw: 1, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.set("b2", { key: "k", path: "", raw: 2, mtimeMs: 1, sizeBytes: 1, loadedAtMs: Date.now() });
	cache.clear();
	assert.equal(cache.get("b1", "k"), undefined);
	assert.equal(cache.get("b2", "k"), undefined);
});

test("SharedScanCache readAndCache returns undefined for missing file", () => {
	const cache = new SharedScanCache();
	const result = cache.readAndCache("b", "k", "/nonexistent/file/path");
	assert.equal(result, undefined);
});

test("SharedScanCache readAndCache parses JSON and caches", () => {
	const dir = makeTempDir();
	try {
		const filePath = path.join(dir, "test.json");
		fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: "two" }));
		const cache = new SharedScanCache();
		const entry = cache.readAndCache("b", "k", filePath);
		assert.ok(entry);
		assert.deepEqual(entry?.raw, { a: 1, b: "two" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SharedScanCache readAndCache returns cached entry on second call", () => {
	const dir = makeTempDir();
	try {
		const filePath = path.join(dir, "test.json");
		fs.writeFileSync(filePath, JSON.stringify({ v: 1 }));
		const cache = new SharedScanCache();
		const first = cache.readAndCache("b", "k", filePath);
		const second = cache.readAndCache("b", "k", filePath);
		assert.strictEqual(first, second, "should return same cached object");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SharedScanCache readAndCache re-reads on file change", () => {
	const dir = makeTempDir();
	try {
		const filePath = path.join(dir, "test.json");
		fs.writeFileSync(filePath, JSON.stringify({ v: 1 }));
		const cache = new SharedScanCache();
		const first = cache.readAndCache("b", "k", filePath);
		// Modify file - write first, then force mtime forward for cache invalidation
		fs.writeFileSync(filePath, JSON.stringify({ v: 2 }));
		const futureMtime = new Date(Date.now() + 2000);
		fs.utimesSync(filePath, futureMtime, futureMtime);
		const second = cache.readAndCache("b", "k", filePath);
		assert.notStrictEqual(first, second, "should re-read on mtime change");
		assert.deepEqual(second?.raw, { v: 2 });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SharedScanCache scanAndCache returns sorted file list", () => {
	const dir = makeTempDir();
	try {
		fs.writeFileSync(path.join(dir, "c.json"), "{}");
		fs.writeFileSync(path.join(dir, "a.json"), "{}");
		fs.writeFileSync(path.join(dir, "b.json"), "{}");
		const cache = new SharedScanCache();
		const entries = cache.scanAndCache("b", dir);
		assert.equal(entries.length, 3);
		assert.deepEqual(entries.map((e) => e.key), ["a.json", "b.json", "c.json"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SharedScanCache scanAndCache returns empty for missing dir", () => {
	const cache = new SharedScanCache();
	const entries = cache.scanAndCache("b", "/nonexistent/dir");
	assert.equal(entries.length, 0);
});

test("SharedScanCache scanAndCache skips subdirectories", () => {
	const dir = makeTempDir();
	try {
		fs.writeFileSync(path.join(dir, "file.json"), "{}");
		fs.mkdirSync(path.join(dir, "subdir"));
		const cache = new SharedScanCache();
		const entries = cache.scanAndCache("b", dir);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.key, "file.json");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
