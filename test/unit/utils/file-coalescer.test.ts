import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFileCoalescer, readJsonFileCoalesced } from "../../../src/utils/file-coalescer.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

describe("createFileCoalescer", () => {
	it("schedules a file and invokes handler after delay", () => {
		const calls: string[] = [];
		const coalescer = createFileCoalescer((file) => calls.push(file), 10, {
			setTimeout: (handler, _ms) => {
				handler();
				return 1;
			},
			clearTimeout: () => undefined,
		});
		coalescer.schedule("test.txt");
		assert.deepEqual(calls, ["test.txt"]);
	});

	it("returns true for new file schedule", () => {
		const coalescer = createFileCoalescer(() => undefined, 1000, {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
		});
		const result = coalescer.schedule("a.txt");
		assert.equal(result, true);
	});

	it("returns false for already-scheduled file", () => {
		const coalescer = createFileCoalescer(() => undefined, 1000, {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
		});
		coalescer.schedule("a.txt");
		const result = coalescer.schedule("a.txt");
		assert.equal(result, false);
	});

	it("allows scheduling a file again after it fires", () => {
		const calls: string[] = [];
		const timers: Array<() => void> = [];
		const coalescer = createFileCoalescer((file) => calls.push(file), 0, {
			setTimeout: (handler) => {
				timers.push(handler);
				return timers.length;
			},
			clearTimeout: () => undefined,
		});
		coalescer.schedule("a.txt");
		// Fire the first timer manually (simulates delay elapsing)
		timers[0]!();
		coalescer.schedule("a.txt");
		timers[1]!();
		assert.deepEqual(calls, ["a.txt", "a.txt"]);
	});

	it("clear() cancels all pending timers", () => {
		let cleared = 0;
		const coalescer = createFileCoalescer(() => undefined, 10000, {
			setTimeout: () => Symbol("timer"),
			clearTimeout: () => {
				cleared++;
			},
		});
		coalescer.schedule("a.txt");
		coalescer.schedule("b.txt");
		coalescer.clear();
		assert.equal(cleared, 2);
	});
});

describe("readJsonFileCoalesced", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-coalescer-");
	});

	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("reads fresh file and caches result", () => {
		const filePath = path.join(tmpDir, "data.json");
		fs.writeFileSync(filePath, '{"value":42}', "utf-8");
		let readCount = 0;
		const result = readJsonFileCoalesced(filePath, 60_000, () => {
			readCount++;
			return JSON.parse(fs.readFileSync(filePath, "utf-8"));
		});
		assert.deepEqual(result, { value: 42 });
		assert.equal(readCount, 1);
		// Second read should be cached
		const result2 = readJsonFileCoalesced(filePath, 60_000, () => {
			readCount++;
			return JSON.parse(fs.readFileSync(filePath, "utf-8"));
		});
		assert.deepEqual(result2, { value: 42 });
		assert.equal(readCount, 1, "should have used cache on second call");
	});

	it("re-reads when file mtime changes", () => {
		const filePath = path.join(tmpDir, "mutable.json");
		fs.writeFileSync(filePath, '{"v":1}', "utf-8");
		let readCount = 0;
		readJsonFileCoalesced(filePath, 60_000, () => {
			readCount++;
			return { v: readCount };
		});
		assert.equal(readCount, 1);

		// Update the file (change mtime)
		fs.writeFileSync(filePath, '{"v":2}', "utf-8");
		// Force mtime change (Windows has coarse mtime granularity)
		const now = new Date();
		fs.utimesSync(filePath, now, new Date(now.getTime() + 1000));

		readJsonFileCoalesced(filePath, 60_000, () => {
			readCount++;
			return { v: readCount };
		});
		assert.equal(readCount, 2, "should re-read after mtime change");
	});

	it("re-reads when TTL expires", () => {
		const filePath = path.join(tmpDir, "ttl.json");
		fs.writeFileSync(filePath, '{"x":1}', "utf-8");
		let readCount = 0;
		// TTL of 0 means immediately expired
		readJsonFileCoalesced(filePath, 0, () => {
			readCount++;
			return { x: readCount };
		});
		assert.equal(readCount, 1);
		readJsonFileCoalesced(filePath, 0, () => {
			readCount++;
			return { x: readCount };
		});
		assert.equal(readCount, 2, "should re-read when TTL is 0");
	});

	it("handles missing file gracefully", () => {
		const filePath = path.join(tmpDir, "nonexistent.json");
		let readCount = 0;
		const result = readJsonFileCoalesced(filePath, 60_000, () => {
			readCount++;
			return undefined;
		});
		assert.equal(result, undefined);
		assert.equal(readCount, 1);
	});
});
