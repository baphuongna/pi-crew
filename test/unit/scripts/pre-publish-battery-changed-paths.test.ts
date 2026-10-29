/**
 * Regression pin — audit finding
 * `pre-publish-battery.changedPaths.quoted-path-trigger-blindness` (MEDIUM).
 *
 * The HARD release gate (scripts/pre-publish-battery.mjs, wired into
 * .githooks/pre-push:64 and prepublishOnly via scripts/prepublish-ci.mjs:151)
 * decides the T7 live real-Pi smoke by regex-matching changed paths parsed
 * from `git diff --name-only` / `git status --porcelain`. Under git's default
 * core.quotePath=true, any changed path containing non-ASCII bytes, control
 * characters, an embedded double quote or a backslash is emitted C-quoted
 * (e.g. "src/runtime/h\303\240ck.ts") — and no anchored T7_TRIGGERS regex can
 * match a string starting with '"'. A diff whose spawn-affecting changes are
 * confined to such filenames evaluated needsT7=false: the live smoke silently
 * skipped with a benign count-only audit entry, while the gate still exited 0
 * — a red-gate bypass by blind spot, with NO audit marker (unlike the explicit
 * PI_CREW_BATTERY_SKIP=1 path).
 *
 * Fix under test (two layers):
 *   1. the battery pins `-c core.quotePath=false` on BOTH git invocations;
 *   2. every parsed entry is routed through the pure unquoteGitPath() decoder
 *      before trigger matching (quote/backslash names stay C-quoted even with
 *      the pin — verified against git 2.43 behavior — so layer 2 is required).
 *
 * These tests pin the decoder against the exact byte forms git emits and pin
 * main()'s matching line (paths.some(p => T7_TRIGGERS.some(re => re.test(p))))
 * to fire on decoded quoted paths — the case that used to evaluate false.
 * The script's top-level `await main()` is behind the analyze-run.mjs-style
 * CLI main-guard (import.meta.url vs pathToFileURL(argv[1])), so importing it
 * here does NOT execute the gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error TS7016 — dev-only script, no .d.mts (prepublish-ci/test-runner-exit pattern).
import { T7_TRIGGERS, unquoteGitPath } from "../../../scripts/pre-publish-battery.mjs";

const BATTERY = fileURLToPath(new URL("../../../scripts/pre-publish-battery.mjs", import.meta.url));

/** Exact mirror of the battery's trigger decision in main(). */
const needsT7 = (paths: string[]) => paths.some((p) => T7_TRIGGERS.some((re: RegExp) => re.test(p)));

test("plain (unquoted) paths pass through verbatim and still trigger", () => {
	assert.equal(unquoteGitPath("src/runtime/foo.ts"), "src/runtime/foo.ts");
	assert.equal(unquoteGitPath("scripts/pre-publish-battery.mjs"), "scripts/pre-publish-battery.mjs");
	assert.equal(unquoteGitPath(".github/workflows/ci.yml"), ".github/workflows/ci.yml");
	assert.equal(unquoteGitPath("docs/plain-file with space.md"), "docs/plain-file with space.md");
	assert.ok(needsT7(["src/runtime/foo.ts"]));
});

test("RED pin: the raw C-quoted form can never match a trigger (the shipped bug)", () => {
	// Verbatim git output byte-for-byte as emitted under default
	// core.quotePath=true for a unicode filename under src/runtime/ (PoC in the
	// audit brief): leading '"' makes every anchored T7 regex miss.
	const rawQuoted = '"src/runtime/h\\303\\240ck-\\303\\274n\\303\\257code.ts"';
	assert.ok(rawQuoted.startsWith('"'), "fixture sanity: raw form is quote-wrapped");
	assert.equal(needsT7([rawQuoted]), false, "the blind spot: quoted trigger path evaluated needsT7=false pre-fix");
});

test("GREEN: quoted unicode form decodes to the true path and triggers", () => {
	const rawQuoted = '"src/runtime/h\\303\\240ck-\\303\\274n\\303\\257code.ts"';
	const decoded = unquoteGitPath(rawQuoted);
	assert.equal(decoded, "src/runtime/hàck-ünïcode.ts");
	assert.equal(needsT7([decoded]), true);
});

test("GREEN: embedded-double-quote filename decodes and triggers (still quoted even with quotePath=false)", () => {
	// git C-quotes names containing '"' even with -c core.quotePath=false.
	const rawQuoted = '"src/runtime/q\\"uote.ts"';
	assert.equal(unquoteGitPath(rawQuoted), 'src/runtime/q"uote.ts');
	assert.equal(needsT7([unquoteGitPath(rawQuoted)]), true);
});

test("GREEN: backslash-named file decodes and triggers", () => {
	const rawQuoted = '"src/runtime/back\\\\slash.ts"';
	assert.equal(unquoteGitPath(rawQuoted), "src/runtime/back\\slash.ts");
	assert.equal(needsT7([unquoteGitPath(rawQuoted)]), true);
});

test("C escapes decode to their control bytes (\\a \\b \\t \\n \\v \\f \\r)", () => {
	assert.equal(unquoteGitPath('"src/runtime/a\\tb\\nc.ts"'), "src/runtime/a\tb\nc.ts");
	assert.equal(unquoteGitPath('"src/runtime/x\\a\\b\\v\\f\\ry.ts"'), "src/runtime/x\x07\b\v\f\ry.ts");
});

test("octal escapes decode UTF-8-aware, not per-code-unit", () => {
	// 0303 0251 = 0xC3 0xA9 = "é" in UTF-8 (two bytes, one code point).
	assert.equal(unquoteGitPath('"src/runtime/caf\\303\\251.ts"'), "src/runtime/café.ts");
});

test("decoding is idempotent: decoded/plain paths re-enter unchanged", () => {
	// The Set-based path collection can only feed each entry once, but the
	// decoder must be safe if a decoded path is ever re-processed (non-quoted
	// input passes through verbatim, even with non-ASCII content).
	const once = unquoteGitPath('"src/runtime/h\\303\\240ck.ts"');
	assert.equal(unquoteGitPath(once), once);
	assert.equal(unquoteGitPath("src/runtime/hàck.ts"), "src/runtime/hàck.ts");
});

test("malformed quoted forms return null — callers fail closed, never matchable", () => {
	// git never emits these today; the contract keeps them from silently
	// bypassing trigger matching (changedPaths() forces the live smoke on null).
	assert.equal(unquoteGitPath('"src/runtime/unclosed'), null);
	assert.equal(unquoteGitPath('"src/runtime/bad\\qescape.ts"'), null);
	assert.equal(unquoteGitPath('"'), null);
});

test("battery pins core.quotePath=false on BOTH git path-listing invocations", () => {
	const src = readFileSync(BATTERY, "utf8");
	assert.ok(
		src.includes('"git", ["-c", "core.quotePath=false", "diff", "--name-only"'),
		"git diff --name-only must run with core.quotePath=false",
	);
	assert.ok(
		src.includes('"git", ["-c", "core.quotePath=false", "status", "--porcelain"'),
		"git status --porcelain must run with core.quotePath=false",
	);
});

test("battery routes changed-path entries through the decoder (no raw adds / naive quote-strip left)", () => {
	const src = readFileSync(BATTERY, "utf8");
	assert.ok(!src.includes("paths.add(f.trim())"), "diff entries must go through addGitPath/unquoteGitPath");
	assert.ok(!src.includes('replace(/^"(.*)"$/, "$1")'), "the old naive rename-side quote-strip (kept octal escapes) must be gone");
	assert.ok(src.includes("addGitPath(entry)"), "status entries must go through addGitPath/unquoteGitPath");
});
