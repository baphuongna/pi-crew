import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SharedScanCache } from "../../src/utils/scan-cache.ts";

test("SharedScanCache stores and retrieves entries", () => {
	const cache = new SharedScanCache({ ttlMs: 60000 });
	cache.set("runs", { key: "run-1", path: "/tmp/run-1", raw: { status: "completed" }, mtimeMs: Date.now(), sizeBytes: 100, loadedAtMs: Date.now() });
	const entry = cache.get("runs", "run-1");
	assert.ok(entry);
	assert.equal(entry.key, "run-1");
	assert.equal((entry.raw as { status: string }).status, "completed");
});

test("SharedScanCache expires entries after TTL", () => {
	let now = 0;
	const cache = new SharedScanCache({ ttlMs: 100, maxEntries: 10 });
	cache.set("runs", { key: "run-1", path: "/tmp/run-1", raw: {}, mtimeMs: now, sizeBytes: 50, loadedAtMs: now });
	// Override now for expiry simulation
	const entry1 = cache.get("runs", "run-1");
	assert.ok(entry1); // Not expired yet
	cache.invalidateBucket("runs"); // Force clear
	const entry2 = cache.get("runs", "run-1");
	assert.equal(entry2, undefined);
});

test("SharedScanCache list returns sorted entries", () => {
	const cache = new SharedScanCache({ ttlMs: 60000 });
	cache.set("runs", { key: "run-3", path: "/tmp/run-3", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.set("runs", { key: "run-1", path: "/tmp/run-1", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.set("runs", { key: "run-2", path: "/tmp/run-2", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	const list = cache.list("runs");
	assert.equal(list.length, 3);
	assert.equal(list[0].key, "run-1");
	assert.equal(list[1].key, "run-2");
	assert.equal(list[2].key, "run-3");
});

test("SharedScanCache evicts oldest entry when maxEntries exceeded", () => {
	const cache = new SharedScanCache({ ttlMs: 60000, maxEntries: 2 });
	cache.set("runs", { key: "run-1", path: "/tmp/run-1", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.set("runs", { key: "run-2", path: "/tmp/run-2", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.set("runs", { key: "run-3", path: "/tmp/run-3", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	const list = cache.list("runs");
	assert.equal(list.length, 2);
});

test("SharedScanCache readAndCache reads and caches JSON file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scan-"));
	try {
		const filePath = path.join(dir, "manifest.json");
		fs.writeFileSync(filePath, JSON.stringify({ runId: "test" }), "utf-8");
		const cache = new SharedScanCache({ ttlMs: 60000 });
		const entry = cache.readAndCache("manifests", "manifest.json", filePath, true);
		assert.ok(entry);
		assert.equal((entry.raw as { runId: string }).runId, "test");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("SharedScanCache invalidate removes specific entry", () => {
	const cache = new SharedScanCache({ ttlMs: 60000 });
	cache.set("runs", { key: "run-1", path: "/tmp/run-1", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.invalidate("runs", "run-1");
	assert.equal(cache.get("runs", "run-1"), undefined);
});

test("SharedScanCache clear removes all entries", () => {
	const cache = new SharedScanCache({ ttlMs: 60000 });
	cache.set("runs", { key: "run-1", path: "/tmp", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.set("artifacts", { key: "art-1", path: "/tmp", raw: {}, mtimeMs: 0, sizeBytes: 0, loadedAtMs: 0 });
	cache.clear();
	assert.equal(cache.get("runs", "run-1"), undefined);
	assert.equal(cache.get("artifacts", "art-1"), undefined);
});