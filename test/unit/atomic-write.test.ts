import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeAtomicJson, readJsonFile, appendJsonlLine } from "../../src/utils/atomic-write.ts";

describe("writeAtomicJson", () => {
	const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-atomic-"));

	it("writes valid JSON to file", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		writeAtomicJson(filePath, { hello: "world" });
		const content = fs.readFileSync(filePath, "utf-8");
		assert.equal(JSON.parse(content).hello, "world");
		fs.rmSync(dir, { recursive: true });
	});

	it("writes pretty JSON when requested", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		writeAtomicJson(filePath, { a: 1 }, true);
		const content = fs.readFileSync(filePath, "utf-8");
		assert.ok(content.includes("\n"));
		fs.rmSync(dir, { recursive: true });
	});

	it("overwrites existing file atomically", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		writeAtomicJson(filePath, { v: 1 });
		writeAtomicJson(filePath, { v: 2 });
		const data = readJsonFile<{ v: number }>(filePath);
		assert.equal(data?.v, 2);
		fs.rmSync(dir, { recursive: true });
	});

	it("does not leave .tmp files on success", () => {
		const dir = tmpDir();
		const filePath = path.join(dir, "test.json");
		writeAtomicJson(filePath, { ok: true });
		const entries = fs.readdirSync(dir);
		assert.ok(!entries.some((e) => e.endsWith(".tmp")));
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

describe("appendJsonlLine", () => {
	it("appends JSON lines to file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-jsonl-"));
		const filePath = path.join(dir, "log.jsonl");
		appendJsonlLine(filePath, { a: 1 });
		appendJsonlLine(filePath, { b: 2 });
		const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]).a, 1);
		assert.equal(JSON.parse(lines[1]).b, 2);
		fs.rmSync(dir, { recursive: true });
	});
});
