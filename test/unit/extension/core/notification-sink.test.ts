import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createJsonlSink } from "../../../../src/extension/notification-sink.ts";

test("JSONL notification sink writes daily redacted records", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sink-"));
	try {
		const sink = createJsonlSink(root, 7);
		sink.write({
			severity: "warning",
			source: "test",
			title: "hello",
			body: "body",
			timestamp: Date.parse("2026-01-02T00:00:00.000Z"),
		});
		const file = path.join(root, "state", "notifications", "2026-01-02.jsonl");
		assert.equal(fs.existsSync(file), true);
		assert.match(fs.readFileSync(file, "utf-8"), /hello/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("JSONL notification sink prunes old files on date change", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sink-prune-"));
	try {
		const dir = path.join(root, "state", "notifications");
		fs.mkdirSync(dir, { recursive: true });
		const oldFile = path.join(dir, "2026-01-01.jsonl");
		fs.writeFileSync(oldFile, "{}\n", "utf-8");
		fs.utimesSync(oldFile, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
		const sink = createJsonlSink(root, 1);
		sink.write({
			severity: "warning",
			source: "test",
			title: "new",
			timestamp: Date.parse("2026-01-10T00:00:00.000Z"),
		});
		assert.equal(fs.existsSync(oldFile), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("JSONL notification sink redacts sensitive fields", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sink-redact-"));
	try {
		const sink = createJsonlSink(root, 7);
		sink.write({
			severity: "warning",
			source: "test",
			title: "secret",
			body: "apiToken=abc",
			timestamp: Date.parse("2026-01-03T00:00:00.000Z"),
		});
		const text = fs.readFileSync(path.join(root, "state", "notifications", "2026-01-03.jsonl"), "utf-8");
		assert.doesNotMatch(text, /abc/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
