/**
 * Module-scoped import latch for the live-session peer dependency.
 *
 * Root cause of the 2026-06-16 subagent-cold-start failures:
 * When N in-process live-session subagents spawn CONCURRENTLY (e.g. several
 * `Agent({ run_in_background: true })` calls issued in one turn), each used to
 * call `await import("@earendil-works/pi-coding-agent")` independently. Under
 * the tsx loader (which registers `load`/`resolve` hooks), concurrent
 * first-imports can each enter the loader and race module-record
 * instantiation. The result is a namespace binding observed mid-evaluation as
 * `undefined`:
 *   - `Cannot read properties of undefined (reading 'existsSync')`
 *   - `Cannot read properties of undefined (reading 'validateWorkflowForTeam')`
 *
 * Observed during the 4-repo UI/UX research deep-dive: 4 explorer subagents
 * launched together (`pi-sub`, `pi-bar`, `pi-status`, `pi-powerline-footer`);
 * 3 of 4 crashed with the above errors. All 3 succeeded on SEQUENTIAL retry,
 * which confirms a cold-start race rather than a logic bug (same code, same
 * args, same repo — only the concurrency changed).
 *
 * ESM engines memoize dynamic imports, but that memoization is not guaranteed
 * to be observed synchronously across concurrent evaluation under transpiling
 * loaders, so we add an explicit JS-level latch: the FIRST caller sets the
 * module-scoped promise; every later caller awaits the same in-flight promise.
 * This guarantees a single module-record instantiation regardless of loader
 * behavior.
 *
 * Tests below guard the latch (presence + that the old un-memoized call site
 * is gone) so it can't regress.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Resolve the source file relative to THIS test file's directory
// (test/unit/ → ../../src/runtime/...). fileURLToPath(new URL(rel, base))
// resolves `rel` against the test file's URL without the dirname-of-
// trailing-slash pitfall that path.dirname() introduces.
const SRC = fileURLToPath(
	new URL("../../src/runtime/live-session-runtime.ts", import.meta.url),
);
// dynamic import() requires a file:// URL on Windows (a bare D:\ path is
// rejected as ERR_UNSUPPORTED_ESM_URL_SCHEME). pathToFileURL handles that
// cross-platform; on POSIX it round-trips to the same path.
const SRC_URL = pathToFileURL(SRC).href;

describe("live-session import latch (module-scoped memoization)", () => {
	it("the live-session-runtime module loads cleanly and exports runLiveSessionTask", async () => {
		const mod = await import(SRC_URL);
		assert.ok(typeof mod === "object" && mod !== null, "module loads cleanly");
		assert.equal(typeof mod.runLiveSessionTask, "function", "exports runLiveSessionTask");
	});

	it("the module-scoped latch is present and the un-memoized call site is gone (regression guard)", () => {
		const src = readFileSync(SRC, "utf-8");
		// Latch must exist.
		assert.ok(
			src.includes("let liveSessionModulePromise"),
			"module-scoped latch variable must exist (prevents concurrent-import cold-start race)",
		);
		// First-caller-wins check-before-set.
		assert.ok(
			src.includes("if (!liveSessionModulePromise)"),
			"latch must check-before-set so the first caller wins",
		);
		// The single memoized loader helper must be called at the use site.
		assert.ok(
			src.includes("await loadLiveSessionModule()"),
			"use site must call loadLiveSessionModule() instead of a direct await import()",
		);
		// The old un-memoized pattern — a dynamic import assigned straight to
		// the cast `as unknown as LiveSessionModule` — must be GONE. Strip all
		// JSDoc/doc-comment blocks first so a documentation mention doesn't
		// satisfy this check by accident.
		const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		assert.ok(
			!codeOnly.includes("import(\"@earendil-works/pi-coding-agent\") as unknown as LiveSessionModule"),
			"the un-memoized direct import (with cast) must be replaced by the latched loader",
		);
	});
});
