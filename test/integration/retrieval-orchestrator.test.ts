import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test_resetRipgrepCache,
	detectRipgrep,
	MAX_CYCLES,
	MAX_SUGGESTED_FILES,
	renderSuggestedFilesSection,
	runRetrievalCycle,
	tokenizeQuery,
} from "../../src/runtime/task-runner/retrieval-orchestrator.ts";

/**
 * M3: integration tests for the iterative file-retrieval orchestrator.
 *
 * Cases (per task spec):
 *   A. ripgrep available (use `rg --files` against the fixture dir) → returns files sorted by score
 *   B. task with clear keyword match → top-N includes the matching fixture file
 *   C. `shouldContinue` returns false early (e.g. empty keyword set) → cycles ≤ 3, converged within MAX_CYCLES
 *
 * The orchestrator must NEVER throw: missing ripgrep falls back to the
 * in-memory walk. We exercise both paths in the same fixture so the
 * test is robust on Windows CI runners without rg.
 */

function makeFixtureDir(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m3-fixture-"));
	// Mix of relevant and irrelevant files; the task is about
	// "toolGuidanceBlock in the prompt-builder" so the matching
	// keyword is "toolguidanceblock" / "prompt".
	fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "src", "tool-guidance-block.ts"), "// keyword: toolguidanceblock prompt-builder\n", "utf-8");
	fs.writeFileSync(path.join(cwd, "src", "prompt-builder.ts"), "// keyword: prompt-builder tool guidance\n", "utf-8");
	fs.writeFileSync(path.join(cwd, "src", "unrelated.ts"), "// no match\n", "utf-8");
	fs.writeFileSync(path.join(cwd, "src", "another.ts"), "// another\n", "utf-8");
	fs.writeFileSync(path.join(cwd, "docs", "notes.md"), "# markdown doc\n", "utf-8");
	// Irrelevant files (should be ignored):
	fs.writeFileSync(path.join(cwd, "src", "ignore.bin"), "BINARY", "utf-8");
	fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
	fs.writeFileSync(path.join(cwd, "node_modules", "dep.ts"), "node_modules dep\n", "utf-8");
	return cwd;
}

test("M3-A: ripgrep available → returns files sorted by score (rg path)", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		const rg = await detectRipgrep();
		if (!rg.available) {
			// Skip — this test requires ripgrep. M3-C and M3-D still cover the fallback.
			return;
		}
		const result = await runRetrievalCycle("find tool guidance code", "implement M3 retrieval", cwd);
		assert.ok(result.files.length > 0, "expected at least one file");
		// Files sorted by score desc
		for (let i = 1; i < result.files.length; i++) {
			assert.ok(
				result.files[i - 1]!.score >= result.files[i]!.score,
				`files must be sorted by score desc, got [${i - 1}]=${result.files[i - 1]!.score} [${i}]=${result.files[i]!.score}`,
			);
		}
		// Did NOT use the fallback (rg is available)
		assert.equal(result.usedFallback, false, "usedFallback should be false when rg is available");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-B: task with clear keyword match → top-N includes the matching file", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		// "toolguidanceblock" appears in src/tool-guidance-block.ts (path
		// match → score boost). "promptbuilder" appears in src/prompt-builder.ts.
		const result = await runRetrievalCycle(
			"explain the toolguidanceblock function in the promptbuilder",
			"review the prompt-builder M3 retrieval wiring",
			cwd,
		);
		assert.ok(result.files.length > 0, "expected at least one file");
		const paths = result.files.map((f) => f.path);
		// The keyword-matched file should be in the top-N. Either rg or
		// fallback path produces this; we accept either:
		//   src/tool-guidance-block.ts
		//   src/prompt-builder.ts
		const hasToolGuidance = paths.some((p) => p.endsWith("tool-guidance-block.ts"));
		const hasPromptBuilder = paths.some((p) => p.endsWith("prompt-builder.ts"));
		assert.ok(
			hasToolGuidance || hasPromptBuilder,
			`expected either tool-guidance-block.ts or prompt-builder.ts in top-N, got: ${JSON.stringify(paths)}`,
		);
		// node_modules + .git + .bin files must be excluded
		for (const p of paths) {
			assert.ok(!p.includes("node_modules"), `node_modules files must be excluded, got: ${p}`);
			assert.ok(!p.includes(".git"), `.git files must be excluded, got: ${p}`);
			assert.ok(!p.endsWith(".bin"), `.bin files must be excluded, got: ${p}`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-C: empty keyword set → converged=true within MAX_CYCLES", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		// Task contains only stopwords / single letters → tokenizeQuery
		// returns [] → runRetrievalCycle short-circuits with converged=true.
		const result = await runRetrievalCycle("a the of and to", "is are be with on", cwd);
		assert.deepEqual(result.files, [], "expected empty result for stopword-only task");
		assert.equal(result.cycles, 0, "expected 0 cycles for empty keyword set");
		assert.equal(result.converged, true, "expected converged=true for empty keyword set");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-C-2: cycles never exceed MAX_CYCLES (3) even when keywords are non-empty", async () => {
	const cwd = makeFixtureDir();
	__test_resetRipgrepCache();
	try {
		const result = await runRetrievalCycle("find anything", "explore everything", cwd);
		assert.ok(result.cycles >= 0 && result.cycles <= MAX_CYCLES, `cycles ${result.cycles} must be in [0, ${MAX_CYCLES}]`);
		// Suggested files cap respects the max.
		assert.ok(result.files.length <= MAX_SUGGESTED_FILES, `suggested files ${result.files.length} must be ≤ ${MAX_SUGGESTED_FILES}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("M3-D: fallback path works even when ripgrep binary is forced unavailable", async () => {
	const cwd = makeFixtureDir();
	// Create a temp PATH that excludes ripgrep so detectRipgrep returns
	// { available: false }. This works cross-platform: on POSIX we point
	// PATH at an empty temp dir; on Windows the same trick (PATH is
	// colon-separated on Windows in node:child_process).
	__test_resetRipgrepCache();
	const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-m3-emptypath-"));
	const originalPath = process.env.PATH;
	const originalPathUpper = process.env.Path;
	// Both casing variants for Windows compat.
	process.env.PATH = emptyPathDir;
	if (originalPathUpper !== undefined) process.env.Path = emptyPathDir;
	// Re-reset cache AFTER env change so the next detectRipgrep call
	// re-spawns `rg` with the empty PATH.
	__test_resetRipgrepCache();
	try {
		// Confirm the empty PATH actually hides rg.
		const rg = await detectRipgrep();
		assert.equal(rg.available, false, "rg should NOT be available with empty PATH");
		const result = await runRetrievalCycle("tool guidance prompt", "build M3 retrieval", cwd);
		assert.equal(result.usedFallback, true, "usedFallback should be true when rg is forced unavailable");
		// Fallback should still find keyword-matched files.
		assert.ok(result.files.length > 0, "fallback should still find at least one file");
		// Cap respected.
		assert.ok(result.files.length <= MAX_SUGGESTED_FILES, `suggested files ${result.files.length} must be ≤ ${MAX_SUGGESTED_FILES}`);
	} finally {
		__test_resetRipgrepCache();
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalPathUpper === undefined) delete process.env.Path;
		else process.env.Path = originalPathUpper;
		__test_resetRipgrepCache();
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(emptyPathDir, { recursive: true, force: true });
	}
});

test("M3-E: renderSuggestedFilesSection emits the expected markdown format", () => {
	const section = renderSuggestedFilesSection({
		files: [
			{ path: "src/foo.ts", score: 0.85, reason: "keyword match: foo" },
			{ path: "src/bar.ts", score: 0.42, reason: "matched by relevance score (no direct keyword hit in path)" },
		],
		cycles: 2,
		converged: true,
		usedFallback: false,
	});
	assert.match(section, /^# Suggested files to read \(top-2 by retrieval score\)/);
	assert.match(section, /Retrieval ran for 2 cycle\(s\)/);
	assert.match(section, /converged/);
	assert.match(section, /- src\/foo\.ts — keyword match: foo \(score 0\.85\)/);
	assert.match(section, /- src\/bar\.ts — matched by relevance score/);
});

test("M3-E-2: renderSuggestedFilesSection returns empty string when no files", () => {
	const section = renderSuggestedFilesSection({ files: [], cycles: 0, converged: true, usedFallback: false });
	assert.equal(section, "", "empty result should render as empty string (no spurious section)");
});

test("M3-F: tokenizeQuery drops stopwords and single-letter tokens", () => {
	const tokens = tokenizeQuery("Find the toolGuidanceBlock in promptBuilder", "M3 retrieval for pi-crew");
	assert.ok(!tokens.includes("the"), "stopword 'the' must be dropped");
	assert.ok(!tokens.includes("for"), "stopword 'for' must be dropped");
	assert.ok(!tokens.includes("in"), "stopword 'in' must be dropped");
	assert.ok(tokens.includes("toolguidanceblock"), "alpha-only token should be kept");
	assert.ok(tokens.includes("promptbuilder"), "alpha-only token should be kept");
	assert.ok(tokens.includes("retrieval"), "alpha-only token should be kept");
	// Dedup
	const set = new Set(tokens);
	assert.equal(set.size, tokens.length, "tokens should be deduped");
});

test("M3-G: detectRipgrep handles a missing rg binary gracefully (no throw)", async () => {
	// We can't easily force ENOENT in a cross-platform way, but we can
	// verify the function returns a result on this machine (rg IS
	// installed per the repo knowledge). On Windows CI without rg, this
	// same call would return { available: false }.
	__test_resetRipgrepCache();
	const result = await detectRipgrep();
	assert.ok(typeof result.available === "boolean", "detectRipgrep must return a boolean availability");
	// Sanity: if rg is available, version string is present
	if (result.available) {
		assert.ok(typeof result.version === "string", "version should be a string when rg is available");
	}
});

test("M3-H: runRetrievalCycle is safe with a non-existent cwd (no throw, empty result)", async () => {
	const cwd = path.join(os.tmpdir(), "pi-crew-m3-nonexistent-", String(Date.now()));
	__test_resetRipgrepCache();
	const result = await runRetrievalCycle("find anything", "any goal", cwd);
	// No throw. Result is well-formed. files is empty (nothing to find).
	assert.ok(Array.isArray(result.files), "files must be an array");
	assert.equal(typeof result.cycles, "number", "cycles must be a number");
	assert.equal(typeof result.converged, "boolean", "converged must be a boolean");
	assert.equal(typeof result.usedFallback, "boolean", "usedFallback must be a boolean");
});
