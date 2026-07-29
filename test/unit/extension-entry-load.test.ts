import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the v0.9.52 incident.
 *
 * Published npm packages EXCLUDE `src/` from the tarball (package.json
 * "files" field — keeps the package ~5MB vs ~16MB). `index.ts` is the
 * extension entry point that Pi loads via strip-types. It MUST NOT have any
 * top-level STATIC value imports from `./src/...`, because the module loader
 * resolves static imports BEFORE any code in the file runs — so a static
 * `import { x } from "./src/..."` breaks every fresh `npm install`
 * ("Cannot find module './src/...'") even though the bundle
 * (dist/index.mjs) is present and self-contained.
 *
 * v0.9.52 broke because PKG-2 (Sprint 6) removed src/ from the tarball while
 * index.ts still had static src/ imports. v0.9.53+ uses dynamic `import()`
 * for the src/ fallback (only reached when the bundle is absent — i.e. dev
 * clones). See `index.ts` for the full rationale.
 *
 * This test matches STATIC value imports from ./src/ and FAILS if any exist.
 * It intentionally allows:
 *   - `import type { ... } from "./src/..."`  (type-only, erased at runtime)
 *   - `import("./src/...")`                    (dynamic, deferred to fallback)
 *   - `typeof import("./src/...")`             (type query, erased at runtime)
 */
test("index.ts: no static top-level imports from ./src/ (would break npm installs that lack src/)", () => {
	const url = new URL("../../index.ts", import.meta.url);
	const src = readFileSync(fileURLToPath(url), "utf8");
	// Static value import: `import ... from "./src/..."` but NOT `import type`.
	// The `(?!type\b)` lookahead excludes type-only imports (erased at runtime).
	const staticSrcImports = src.match(/^\s*import\s+(?!type\b)\S[^;\n]*?\bfrom\s+["']\.\/src\//gm);
	assert.equal(
		staticSrcImports,
		null,
		`index.ts has static top-level ./src/ imports — these break published ` +
			`npm installs (src/ is excluded from the tarball, so the module ` +
			`loader fails to resolve them BEFORE the bundle-detection code runs). ` +
			`Move them to dynamic import() inside the fallback path. Found:\n` +
			`${staticSrcImports?.join("\n")}`,
	);
});

/**
 * Positive companion: index.ts MUST reach src/ only via dynamic import() in
 * the fallback path. Asserts the dynamic src/ imports exist so a future
 * refactor can't silently delete the fallback (which would break dev clones
 * that run without a built bundle).
 */
test("index.ts: src/ fallback uses dynamic import() (reachable when bundle is absent)", () => {
	const url = new URL("../../index.ts", import.meta.url);
	const src = readFileSync(fileURLToPath(url), "utf8");
	assert.match(
		src,
		/import\(\s*["']\.\/src\/extension\/register\.ts["']\s*\)/,
		"index.ts must dynamically import ./src/extension/register.ts in the fallback path",
	);
	assert.match(
		src,
		/import\(\s*["']\.\/src\/runtime\/run-tracker\.ts["']\s*\)/,
		"index.ts must dynamically import ./src/runtime/run-tracker.ts in the fallback path",
	);
});
