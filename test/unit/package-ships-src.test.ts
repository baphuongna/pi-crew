import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression guard for the v0.9.52 / v0.9.53 / v0.9.54 incidents.
 *
 * pi-crew's child-worker `pi` process loads `src/prompt/prompt-runtime.ts` BY
 * PATH (pi-args.ts → PROMPT_RUNTIME_EXTENSION_PATH = packageRoot()/src/prompt/
 * prompt-runtime.ts, passed to the child as `--extension`). Likewise the
 * extension entry can fall back to `src/extension/register.ts` via strip-types.
 *
 * These path loads require the `src/` tree to be SHIPPED in the npm tarball.
 * PKG-2 (Sprint 6) removed `src/` from the `files` allowlist to slim the
 * tarball, which broke delegation (child could not find prompt-runtime.ts →
 * "pi-crew run failed") AND masked the esbuild-devDep load bug. This guard
 * ensures `src/` stays in `files` and the key path-loaded files exist.
 */
test("package ships src/ (child workers load src files by path)", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, "..", "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

	assert.ok(
		pkg.files?.some((f: string) => f === "src/" || f === "src"),
		`package.json "files" must include "src/" — child-worker pi loads src/prompt/` +
			`prompt-runtime.ts by path (pi-args.ts PROMPT_RUNTIME_EXTENSION_PATH). ` +
			`Removing src/ from files (the PKG-2 regression) breaks delegation.`,
	);

	// The specific files the runtime loads by path — must exist in the repo
	// (and therefore ship, since src/ is in files).
	const required = [
		"src/prompt/prompt-runtime.ts", // child worker's extension (delegation)
		"src/extension/register.ts", // extension entry (strip-types fallback)
	];
	for (const rel of required) {
		assert.ok(existsSync(join(root, rel)), `required path-loaded file missing: ${rel}`);
	}
});
