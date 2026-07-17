/**
 * T5 (v0.8.5) — per-write validator (real-time feedback).
 *
 * Distilled from pi-lens (apmantza). Tests pin the latency-safe contract:
 * zero-cost synchronous validation, dedup-by-content, cheap skip for
 * unvalidated extensions, and the blocker-block builder. Uses the test seam
 * `setPerWriteValidatorsForTest` to inject a known validator + a temp dir.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	buildValidationBlocker,
	extensionKey,
	extractPathFromInput,
	resetPerWriteValidatorCache,
	setPerWriteValidatorsForTest,
	validateJson,
	validateWrittenFile,
} from "../../src/runtime/per-write-validator.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "t5-pwv-"));
	setPerWriteValidatorsForTest(undefined); // default registry (json)
	resetPerWriteValidatorCache();
});

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	setPerWriteValidatorsForTest(undefined);
	resetPerWriteValidatorCache();
});

describe("T5: validateJson", () => {
	test("valid JSON is ok", () => {
		assert.deepEqual(validateJson('{"a":1}', "x.json"), { ok: true });
		assert.deepEqual(validateJson("[1,2,3]", "x.json"), { ok: true });
		assert.deepEqual(validateJson("null", "x.json"), { ok: true });
	});

	test("malformed JSON is not ok with a message", () => {
		const r = validateJson("{not valid", "x.json");
		assert.equal(r.ok, false);
		assert.ok(r.error?.includes("Invalid JSON"), `error was: ${r.error}`);
	});

	test("empty file is treated as ok (absence, not a parse error)", () => {
		assert.deepEqual(validateJson("", "x.json"), { ok: true });
		assert.deepEqual(validateJson("   \n  ", "x.json"), { ok: true });
	});
});

describe("T5: extensionKey", () => {
	test("lowercases and strips the leading dot", () => {
		assert.equal(extensionKey("foo/bar.JSON"), "json");
		assert.equal(extensionKey("x.Ts"), "ts");
	});
	test("no extension → empty string", () => {
		assert.equal(extensionKey("Makefile"), "");
		assert.equal(extensionKey("dir/"), "");
	});
});

describe("T5: extractPathFromInput", () => {
	test("extracts filePath / path / file (first hit wins)", () => {
		assert.equal(extractPathFromInput({ filePath: "/a/b.json" }), "/a/b.json");
		assert.equal(extractPathFromInput({ path: "/c/d.json" }), "/c/d.json");
		assert.equal(extractPathFromInput({ file: "/e/f.json" }), "/e/f.json");
	});

	test("returns undefined when no known path field or non-string", () => {
		assert.equal(extractPathFromInput({}), undefined);
		assert.equal(extractPathFromInput({ path: 123 }), undefined);
		assert.equal(extractPathFromInput(undefined), undefined);
		assert.equal(extractPathFromInput("not-an-object"), undefined);
	});
});

describe("T5: validateWrittenFile — skip behavior", () => {
	test("returns null for an extension with no validator (cheap skip)", () => {
		writeFileSync(join(dir, "f.ts"), "garbage that we won't check");
		assert.equal(validateWrittenFile(join(dir, "f.ts")), null);
	});

	test("returns null for a file that can't be read (never block)", () => {
		assert.equal(validateWrittenFile(join(dir, "missing.json")), null);
	});

	test("returns null when content is valid", () => {
		writeFileSync(join(dir, "ok.json"), '{"ok":true}');
		assert.equal(validateWrittenFile(join(dir, "ok.json")), null);
	});
});

describe("T5: validateWrittenFile — JSON failure path", () => {
	test("returns ok:false for malformed JSON", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "{ broken");
		const r = validateWrittenFile(p);
		assert.ok(r, "should return a result");
		assert.equal(r.ok, false);
		assert.ok(r.error?.includes("Invalid JSON"));
	});
});

describe("T5: validateWrittenFile — dedup by content", () => {
	test("the same malformed content is reported only once per process", () => {
		const p = join(dir, "dup.json");
		writeFileSync(p, "{ broken");
		const first = validateWrittenFile(p);
		assert.ok(first && !first.ok, "first call reports the error");
		const second = validateWrittenFile(p);
		assert.equal(second, null, "identical content → dedup'd to null");
	});

	test("changed content re-validates", () => {
		const p = join(dir, "chg.json");
		writeFileSync(p, "{ broken");
		assert.ok(validateWrittenFile(p)?.ok === false, "first is broken");
		writeFileSync(p, '{"fixed":true}');
		assert.equal(validateWrittenFile(p), null, "fixed content → valid → null");
		writeFileSync(p, "[ also broken");
		assert.ok(validateWrittenFile(p)?.ok === false, "re-broken → reported again");
	});
});

describe("T5: custom validator registry (extensibility for future .js/.py)", () => {
	test("a registered extension is validated, an unregistered one is skipped", () => {
		setPerWriteValidatorsForTest(
			new Map([
				[
					"js",
					(_content, _path) => ({
						ok: false,
						error: "would-be-process-spawn (mock)",
					}),
				],
			]),
		);
		writeFileSync(join(dir, "x.js"), "anything");
		writeFileSync(join(dir, "y.txt"), "anything");
		const jsResult = validateWrittenFile(join(dir, "x.js"));
		assert.ok(jsResult && !jsResult.ok, "registered extension is validated");
		assert.equal(validateWrittenFile(join(dir, "y.txt")), null, "unregistered extension skipped");
	});
});

describe("T5: buildValidationBlocker", () => {
	test("produces a text block with a strong 🔴 signal + path + error", () => {
		const block = buildValidationBlocker("/p/bad.json", "Invalid JSON: foo");
		assert.equal(block.type, "text");
		assert.ok(block.text.includes("🔴"), "strong signal prefix");
		assert.ok(block.text.includes("/p/bad.json"), "path in the block");
		assert.ok(block.text.includes("Invalid JSON: foo"), "error in the block");
		assert.ok(block.text.toLowerCase().includes("fix"), "instructs to fix");
	});
});
