import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type IncrementalReadState, readJsonlSince, readLinesSince } from "../../../src/utils/incremental-reader.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inc-reader-"));
}

function initial(offset = 0, count = 0): IncrementalReadState {
	return { byteOffset: offset, lineCount: count };
}

test("reads all lines from a fresh file (offset=0)", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "fresh.txt");
	try {
		fs.writeFileSync(filePath, "line1\nline2\nline3\n", "utf-8");
		const result = readLinesSince(filePath, initial());
		assert.deepEqual(result.lines, ["line1", "line2", "line3"]);
		assert.equal(result.state.lineCount, 3);
		assert.equal(result.eof, true);
		assert.equal(result.state.byteOffset, fs.statSync(filePath).size);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("reads only new lines after initial read", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "grow.txt");
	try {
		fs.writeFileSync(filePath, "alpha\nbeta\n", "utf-8");
		const first = readLinesSince(filePath, initial());
		assert.deepEqual(first.lines, ["alpha", "beta"]);
		assert.equal(first.state.lineCount, 2);

		// Append more lines
		fs.appendFileSync(filePath, "gamma\ndelta\n", "utf-8");
		const second = readLinesSince(filePath, first.state);
		assert.deepEqual(second.lines, ["gamma", "delta"]);
		assert.equal(second.state.lineCount, 4);
		assert.equal(second.eof, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("handles empty file", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "empty.txt");
	try {
		fs.writeFileSync(filePath, "", "utf-8");
		const result = readLinesSince(filePath, initial());
		assert.deepEqual(result.lines, []);
		assert.equal(result.state.lineCount, 0);
		assert.equal(result.eof, true);
		assert.equal(result.state.byteOffset, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("handles file not found gracefully", () => {
	const result = readLinesSince("/nonexistent/path/file.txt", initial());
	assert.deepEqual(result.lines, []);
	assert.equal(result.state.lineCount, 0);
	assert.equal(result.eof, true);
	assert.equal(result.state.byteOffset, 0);
});

test("readJsonlSince parses valid JSONL", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "valid.jsonl");
	try {
		const entries = [
			{ type: "start", runId: "r1" },
			{ type: "done", runId: "r1" },
			{ type: "start", runId: "r2" },
		];
		fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
		const result = readJsonlSince<{ type: string; runId: string }>(filePath, initial());
		assert.equal(result.items.length, 3);
		assert.equal(result.items[0].type, "start");
		assert.equal(result.items[1].runId, "r1");
		assert.equal(result.items[2].runId, "r2");
		assert.equal(result.eof, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readJsonlSince skips malformed lines", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "mixed.jsonl");
	try {
		const lines = ['{"type":"ok","id":1}', "NOT VALID JSON", '{"type":"ok","id":2}', "{broken", '{"type":"ok","id":3}'];
		fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
		const result = readJsonlSince<{ type: string; id: number }>(filePath, initial());
		assert.equal(result.items.length, 3);
		assert.equal(result.items[0].id, 1);
		assert.equal(result.items[1].id, 2);
		assert.equal(result.items[2].id, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("handles partial last line (incomplete line at EOF)", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "partial.txt");
	try {
		// Write complete lines + a partial line without trailing newline
		fs.writeFileSync(filePath, "complete1\ncomplete2\npartial_no_newline", "utf-8");
		const result = readLinesSince(filePath, initial());
		assert.deepEqual(result.lines, ["complete1", "complete2"]);
		assert.equal(result.state.lineCount, 2);
		// offset should be at start of partial line, not end of file
		const expectedOffset = Buffer.byteLength("complete1\ncomplete2\n", "utf-8");
		assert.equal(result.state.byteOffset, expectedOffset);
		assert.equal(result.eof, false);

		// Now complete the line
		fs.appendFileSync(filePath, "\n", "utf-8");
		const result2 = readLinesSince(filePath, result.state);
		assert.deepEqual(result2.lines, ["partial_no_newline"]);
		assert.equal(result2.state.lineCount, 3);
		assert.equal(result2.eof, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("state tracks byteOffset correctly across multiple reads", () => {
	const dir = makeTempDir();
	const filePath = path.join(dir, "multi.txt");
	try {
		// Write incrementally and verify offsets
		fs.writeFileSync(filePath, "a\n", "utf-8");
		const r1 = readLinesSince(filePath, initial());
		assert.deepEqual(r1.lines, ["a"]);
		assert.equal(r1.state.byteOffset, 2); // "a\n" = 2 bytes

		fs.appendFileSync(filePath, "bb\n", "utf-8");
		const r2 = readLinesSince(filePath, r1.state);
		assert.deepEqual(r2.lines, ["bb"]);
		assert.equal(r2.state.byteOffset, 5); // "a\nbb\n" = 5 bytes

		fs.appendFileSync(filePath, "ccc\n", "utf-8");
		const r3 = readLinesSince(filePath, r2.state);
		assert.deepEqual(r3.lines, ["ccc"]);
		assert.equal(r3.state.byteOffset, 9); // "a\nbb\nccc\n" = 9 bytes
		assert.equal(r3.state.lineCount, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
