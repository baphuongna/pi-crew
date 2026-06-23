import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { extractStructuredResult } from "../../src/runtime/result-extractor.ts";

test("empty string returns unstructured", () => {
	const result = extractStructuredResult("");
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
	assert.equal(result.rawText, "");
});

test("whitespace-only string returns unstructured", () => {
	const result = extractStructuredResult("   \n\t  ");
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
});

test("direct JSON object extraction", () => {
	const json = '{"name":"test","value":42}';
	const result = extractStructuredResult(json);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { name: "test", value: 42 });
	assert.equal(result.rawText, json);
});

test("direct JSON array extraction", () => {
	const json = '[1,2,3]';
	const result = extractStructuredResult(json);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, [1, 2, 3]);
	assert.equal(result.rawText, json);
});

test("fenced JSON extraction", () => {
	const text = 'Here is the result:\n```json\n{"status":"ok"}\n```\nDone.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { status: "ok" });
});

test("fenced JSON with whitespace", () => {
	const text = '```json\n  {\n    "a": 1,\n    "b": 2\n  }\n```';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { a: 1, b: 2 });
});

test("RESULT: marker extraction", () => {
	const text = 'Some text before\nRESULT: {"found": true}';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { found: true });
});

test("OUTPUT: marker extraction", () => {
	const text = 'Processing...\nOUTPUT: [10, 20, 30]';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, [10, 20, 30]);
});

test("ANSWER: marker extraction", () => {
	const text = 'The answer is:\nANSWER: {"x": 5}';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { x: 5 });
});

test("plain text returns unstructured", () => {
	const text = "This is just plain text without any JSON.";
	const result = extractStructuredResult(text);
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
	assert.equal(result.rawText, text);
});

test("invalid JSON in fence returns unstructured", () => {
	const text = '```json\n{not valid json}\n```';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
});

test("nested JSON brackets matched correctly", () => {
	const text = 'RESULT: {"outer": {"inner": [1, 2, {"deep": true}]}} and some trailing text';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { outer: { inner: [1, 2, { deep: true }] } });
});

test("bracket matching with strings containing brackets", () => {
	const text = 'RESULT: {"value": "contains } and { chars"} and more';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { value: "contains } and { chars" });
});

test("direct JSON takes priority over fenced", () => {
	const json = '{"priority":"direct"}';
	const result = extractStructuredResult(json);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { priority: "direct" });
});

test("schema parameter validates extracted value against TypeBox schema", () => {
	const json = '{"name":"test","value":42}';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { name: "test", value: 42 });
});

test("### Result marker extraction", () => {
	const text = 'Analysis complete.\n### Result\n{"score": 0.95}';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { score: 0.95 });
});

test("## Output marker extraction", () => {
	const text = 'Processing done.\n## Output\n{"items": [1, 2]}';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { items: [1, 2] });
});

// --- Strategy 4: embedded JSON in prose (preamble/epilogue without markers) ---
// This is the real-world case that motivated Strategy 4. Models (MiniMax-M3,
// GLM, etc.) frequently emit prose like "Here's my review:" before the JSON,
// without fences or RESULT:/OUTPUT: markers.

test("Strategy 4: JSON after prose preamble", () => {
	const text = 'Here is my review of the work:\n{"outcome":"accept","feedback":"looks good"}';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { outcome: "accept", feedback: "looks good" });
});

test("Strategy 4: JSON surrounded by prose on both sides", () => {
	const text = 'Let me analyze. {"verdict": true} That concludes my review.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { verdict: true });
});

test("Strategy 4: JSON in a sentence", () => {
	const text = 'The result is {"score": 42} as requested.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { score: 42 });
});

test("Strategy 4: JSON array embedded in prose", () => {
	const text = 'Items found: [1, 2, 3] done.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, [1, 2, 3]);
});

test("Strategy 4: nested JSON object in prose", () => {
	const text = 'Review complete. {"outer": {"inner": [1, 2]}} Thank you.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { outer: { inner: [1, 2] } });
});

test("Strategy 4: malformed brace is skipped, valid JSON found later", () => {
	// Prose has a stray '{' that isn't valid JSON, followed by real JSON.
	const text = 'Set of {things} here. {"real": "data"} done.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { real: "data" });
});

test("Strategy 4: brace inside string literal does not break matching", () => {
	const text = 'Review: {"msg": "contains } and { chars"} end.';
	const result = extractStructuredResult(text);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { msg: "contains } and { chars" });
});

// ---------------------------------------------------------------------------
// round-13 P0-3: TypeBox schema validation
// ---------------------------------------------------------------------------

test("round-13 P0-3: valid schema passes; result.structured=true", () => {
	const json = '{"name":"test","value":42}';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { name: "test", value: 42 });
	assert.equal(result.error, undefined);
});

test("round-13 P0-3: invalid schema returns structured:false with error message", () => {
	const json = '{"name":"test","value":"not-a-number"}';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
	assert.match(result.error ?? "", /does not match schema/);
});

test("round-13 P0-3: missing required property returns structured:false", () => {
	const json = '{"name":"test"}';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
	assert.match(result.error ?? "", /does not match schema/);
});

test("round-13 P0-3: extra properties are allowed (TypeBox default)", () => {
	const json = '{"name":"test","value":42,"extra":"ok"}';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { name: "test", value: 42, extra: "ok" });
});

test("round-13 P0-3: schema validates fenced JSON", () => {
	const text = '```json\n{"name":"a","value":1}\n```';
	const schema = Type.Object({ name: Type.String(), value: Type.Number() });
	const result = extractStructuredResult(text, schema);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { name: "a", value: 1 });
});

test("round-13 P0-3: empty text returns unstructured even with schema", () => {
	const schema = Type.Object({ name: Type.String() });
	const result = extractStructuredResult("", schema);
	assert.equal(result.structured, false);
	assert.equal(result.data, null);
	assert.equal(result.rawText, "");
});

test("round-13 P0-3: backward compat — no schema returns existing behavior", () => {
	const json = '{"foo":"bar"}';
	const result = extractStructuredResult(json);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, { foo: "bar" });
});

test("round-13 P0-3: schema validates array shape", () => {
	const json = '[1,2,3]';
	const schema = Type.Array(Type.Number());
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, true);
	assert.deepEqual(result.data, [1, 2, 3]);
});

test("round-13 P0-3: schema rejects array with wrong element type", () => {
	const json = '[1,"two",3]';
	const schema = Type.Array(Type.Number());
	const result = extractStructuredResult(json, schema);
	assert.equal(result.structured, false);
	assert.match(result.error ?? "", /does not match schema/);
});
