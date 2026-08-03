import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { parsePiJsonOutput } from "../../src/runtime/output/pi-json-output.ts";

test("parsePiJsonOutput extracts final text and usage", () => {
	const stdout = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			},
		}),
		JSON.stringify({
			type: "message",
			content: [{ type: "text", text: "final" }],
		}),
		JSON.stringify({
			type: "message_end",
			usage: {
				input: 12,
				output: 5,
				cache_read_tokens: 2,
				cost_usd: 0.03,
				turns: 1,
			},
		}),
	].join("\n");
	const parsed = parsePiJsonOutput(stdout);
	assert.equal(parsed.jsonEvents, 3);
	assert.equal(parsed.finalText, "final");
	assert.equal(parsed.usage?.input, 12);
	assert.equal(parsed.usage?.output, 5);
	assert.equal(parsed.usage?.cacheRead, 2);
	assert.equal(parsed.usage?.cost, 0.03);
});

test("parsePiJsonOutput ignores user prompt text when extracting final output", () => {
	const stdout = [
		JSON.stringify({
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "secret prompt" }],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "clean answer" }],
			},
		}),
	].join("\n");
	const parsed = parsePiJsonOutput(stdout);
	assert.equal(parsed.finalText, "clean answer");
	assert.equal(parsed.textEvents.includes("secret prompt"), false);
});

test("parsePiJsonOutput handles fixture JSONL", () => {
	const fixture = fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "pi-json-output.jsonl"), "utf-8");
	const parsed = parsePiJsonOutput(fixture);
	assert.equal(parsed.finalText, "Final answer from Pi");
	assert.equal(parsed.usage?.input, 10);
	assert.equal(parsed.usage?.output, 5);
});
