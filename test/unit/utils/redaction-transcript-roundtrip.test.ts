import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { redactJsonLine } from "../../../src/utils/redaction.ts";

test("redactJsonLine strips api_key secrets from JSON lines", () => {
	const raw = JSON.stringify({
		event: "tool_call",
		args: { api_key: "sk-abc123456789" },
	});
	const redacted = redactJsonLine(raw);
	assert.ok(!redacted.includes("sk-abc123456789"));
	assert.ok(redacted.includes("***"));
});

test("redactJsonLine strips bearer tokens from JSON lines", () => {
	const raw = JSON.stringify({
		event: "message",
		headers: {
			Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
		},
	});
	const redacted = redactJsonLine(raw);
	assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
	assert.ok(redacted.includes("***"));
});

test("transcript on disk does not contain raw secrets after redaction", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-redact-"));
	const transcriptPath = path.join(dir, "transcript.jsonl");
	const secretValue = "sk-live-0123456789abcdef";
	const rawLine = JSON.stringify({
		type: "tool_result",
		output: { api_key: secretValue },
	});
	const redacted = redactJsonLine(rawLine);
	fs.writeFileSync(transcriptPath, redacted + "\n", "utf-8");
	const onDisk = fs.readFileSync(transcriptPath, "utf-8");
	assert.ok(!onDisk.includes(secretValue));
	fs.rmSync(dir, { recursive: true, force: true });
});
