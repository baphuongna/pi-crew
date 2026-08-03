/**
 * Unit tests for src/runtime/resilient-edit.ts (ZERO-COVERAGE module).
 *
 * Public API under test:
 *   - wrapEditWithResilientReplace(pi, tools?): boolean
 *
 * wrapEditWithResilientReplace monkey-patches the native `edit` tool so that
 * on an "old_string not found" failure it retries with the cascading replace()
 * engine (../runtime/replace.ts). These tests drive the REAL exported function
 * with a stub edit tool + a temp file on disk, exercising:
 *   - pass-through on success (native result returned unchanged),
 *   - fallback when the native result signals not-found (retry reads file,
 *     applies the replace cascade, writes the file, returns strategy info),
 *   - fallback when the native execute throws a not-found error,
 *   - both camelCase and snake_case param conventions,
 *   - skip when pi-diff is detected (no patching),
 *   - skip when no edit tool is present,
 *   - error path when params are insufficient to retry.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { wrapEditWithResilientReplace } from "../../../../src/runtime/resilient-edit.ts";

/** Minimal structural type for the stub edit tool accepted by the module. */
interface StubEdit {
	name: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown) => Promise<unknown>;
}

/** A no-op pi with NO extensions (so isPiDiffLoaded() returns false). */
function makePi(extensions?: unknown[]): unknown {
	if (extensions === undefined) return {};
	return { extensions };
}

/** A normal "success" edit result that is NOT a not-found signal. */
function okResult(): unknown {
	return { content: [{ type: "text", text: "Edited successfully." }] };
}

/** A result whose serialized text matches the not-found patterns. */
function notFoundResult(text = "old_string not found"): unknown {
	return { content: [{ type: "text", text }] };
}

function makeEdit(execute: StubEdit["execute"]): StubEdit {
	return { name: "edit", description: "d", parameters: {}, execute };
}

function tmpFile(content: string): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resilient-edit-"));
	const file = path.join(dir, "target.txt");
	fs.writeFileSync(file, content, "utf8");
	return { dir, file };
}

test("wrapEditWithResilientReplace: native success passes through unchanged (no retry)", async () => {
	const original = okResult();
	const edit = makeEdit(async () => original);
	const pi = makePi();
	let callCount = 0;
	const wrapped = makeEdit(async (...args) => {
		callCount += 1;
		return edit.execute(...args);
	});

	const applied = wrapEditWithResilientReplace(pi as never, { edit: wrapped });
	assert.equal(applied, true, "wrapper applied");

	const result = await wrapped.execute("call-1", { path: "ignored" }, undefined, undefined);
	assert.equal(result, original, "native success result returned as-is");
	assert.equal(callCount, 1, "native execute invoked exactly once");
});

test("wrapEditWithResilientReplace: not-found result triggers resilient cascade that rewrites the file", async () => {
	const { file, dir } = tmpFile("function hello() {\n\treturn 1;\n}\n");
	try {
		// Native edit reports not-found; resilient retry must apply an exact match.
		const edit = makeEdit(async () => notFoundResult());
		const pi = makePi();
		const applied = wrapEditWithResilientReplace(pi as never, { edit });
		assert.equal(applied, true);

		const result = (await edit.execute(
			"call-1",
			{ path: file, oldString: "return 1;", newString: "return 2;" },
			undefined,
			undefined,
		)) as { content: Array<{ text: string }>; _replaceStrategy: string };

		const text = result.content[0]?.text ?? "";
		assert.ok(text.includes("resilient cascade"), "result announces resilient cascade");
		assert.ok(text.includes(file), "result references the edited path");
		assert.equal(result._replaceStrategy, "simple", "exact-match strategy recorded");
		// File was actually rewritten by the retry.
		const after = fs.readFileSync(file, "utf8");
		assert.ok(after.includes("return 2;"), "new string present in file");
		assert.ok(!after.includes("return 1;"), "old string replaced in file");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("wrapEditWithResilientReplace: not-found THROW triggers resilient cascade (snake_case params)", async () => {
	const { file, dir } = tmpFile("const x = 10;\n");
	try {
		const edit = makeEdit(async () => {
			throw new Error("old_string not found");
		});
		const pi = makePi();
		wrapEditWithResilientReplace(pi as never, { edit });

		// Use snake_case param names to exercise the alias fallbacks.
		const result = (await edit.execute("call-2", { old_string: "x = 10", new_string: "x = 42", path: file }, undefined, undefined)) as {
			content: Array<{ text: string }>;
			_replaceStrategy: string;
		};

		assert.ok(result.content[0]?.text.includes("resilient cascade"), "retry ran after thrown not-found");
		const after = fs.readFileSync(file, "utf8");
		assert.ok(after.includes("x = 42"), "snake_case params applied to file");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("wrapEditWithResilientReplace: non-not-found error rethrows (retry not attempted)", async () => {
	const edit = makeEdit(async () => {
		throw new Error("permission denied");
	});
	const pi = makePi();
	wrapEditWithResilientReplace(pi as never, { edit });

	await assert.rejects(
		() => edit.execute("c", { path: "/nope", oldString: "a", newString: "b" }, undefined, undefined),
		/permission denied/,
		"unrelated error propagates unchanged",
	);
});

test("wrapEditWithResilientReplace: not-found with insufficient params throws a not-found error", async () => {
	const edit = makeEdit(async () => notFoundResult());
	const pi = makePi();
	wrapEditWithResilientReplace(pi as never, { edit });

	// Missing old/new strings → retry path cannot proceed.
	await assert.rejects(
		() => edit.execute("c", { path: "/tmp/whatever" }, undefined, undefined),
		/old_string not found \(and resilient retry skipped: missing path\/old\/new\)/,
		"missing params surface a descriptive not-found error",
	);
});

test("wrapEditWithResilientReplace: exhausted cascade rethrows a not-found error naming the strategy", async () => {
	const { file, dir } = tmpFile("unchanged content\n");
	try {
		const edit = makeEdit(async () => notFoundResult());
		const pi = makePi();
		wrapEditWithResilientReplace(pi as never, { edit });

		await assert.rejects(
			() => edit.execute("c", { path: file, oldString: "this does not exist anywhere", newString: "x" }, undefined, undefined),
			/old_string not found \(resilient cascade exhausted, strategy=none\)/,
			"no match surfaces strategy=none",
		);
		// File untouched.
		assert.equal(fs.readFileSync(file, "utf8"), "unchanged content\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("wrapEditWithResilientReplace: skipped (returns false) when pi-diff is loaded", () => {
	const edit = makeEdit(async () => okResult());
	const originalExecute = edit.execute;
	// pi.extensions contains a pi-diff entry → auto-disable to avoid double-wrap.
	const pi = makePi([{ name: "pi-diff" }]);

	const applied = wrapEditWithResilientReplace(pi as never, { edit });

	assert.equal(applied, false, "not applied when pi-diff present");
	assert.equal(edit.execute, originalExecute, "execute left unpatched");
});

test("wrapEditWithResilientReplace: skipped when no edit tool is present", () => {
	const pi = makePi();
	// Edit object present but with no execute function → module must skip.
	const toolsNoExec = { edit: { name: "edit", description: "", parameters: {} } } as never;
	const applied = wrapEditWithResilientReplace(pi as never, toolsNoExec);
	assert.equal(applied, false, "no execute function → not applied");
});

test("wrapEditWithResilientReplace: replaceAll flag threads through to the cascade", async () => {
	const { file, dir } = tmpFile("dup\ndup\ndup\n");
	try {
		const edit = makeEdit(async () => notFoundResult());
		const pi = makePi();
		wrapEditWithResilientReplace(pi as never, { edit });

		// Provide oldString that does NOT exact-match the file (forces cascade),
		// with replaceAll so the trimmed-line strategy replaces every line.
		const result = (await edit.execute(
			"c",
			{ path: file, oldString: "dup ", newString: "ok", replaceAll: true },
			undefined,
			undefined,
		)) as { content: Array<{ text: string }> };

		assert.ok(result.content[0]?.text.includes("resilient cascade"), "cascade ran");
		const after = fs.readFileSync(file, "utf8");
		assert.equal((after.match(/ok/g) ?? []).length, 3, "all occurrences replaced via replaceAll");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
