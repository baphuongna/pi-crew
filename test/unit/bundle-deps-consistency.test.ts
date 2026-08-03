import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the v0.9.52 / v0.9.53 incidents.
 *
 * The shipped bundle `dist/index.mjs` is the code Pi actually loads. It
 * `import`s external packages at runtime. EVERY such package MUST be declared
 * in `dependencies` or `peerDependencies` — NOT just `devDependencies`.
 *
 * `devDependencies` are NOT installed by `npm install pi-crew` (production),
 * so a runtime import of a devDep fails to resolve → the bundle fails to load
 * → index.ts falls back to the src/ strip-types path → which also fails if
 * `src/` isn't shipped → "Cannot find module './src/extension/register.ts'".
 *
 * v0.9.52/53 broke because `esbuild` (imported at runtime by
 * `src/runtime/goal-workflow/dynamic-workflow-runner.ts` for `transformSync`) was declared
 * as a devDependency. It was masked pre-0.9.52 because `src/` was shipped
 * (strip-types loaded register.ts without eagerly pulling in the
 * dynamic-workflow runner's esbuild import). PKG-2 removed `src/`, surfacing
 * the latent bundle-load failure.
 *
 * This test parses the bundle's external imports and asserts each is declared
 * as a runtime dep. It runs in CI's Test step.
 */
test("dist/index.mjs: every external import is declared in dependencies or peerDependencies (not devDependencies-only)", () => {
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
	const bundle = readFileSync(`${root}/dist/index.mjs`, "utf8");

	const runtimeDeps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
	const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));

	// Find external specifiers from `import ... from "x"` and `import("x")`.
	// Capture group = the quoted specifier.
	// NOTE: the middle `[^'"`;]*?` (NOT `[^;{}]*?`) is deliberate — named imports
	// like `import { transformSync } from "esbuild"` CONTAIN braces, so excluding
	// `{}` would hide them (false negative — exactly the v0.9.53 bug class). We
	// exclude quotes/backtick/semicolon instead so the match never crosses into
	// another string or statement.
	const importRe = /\bimport\b\s*[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\b\s*\(\s*["']([^"']+)["']\s*\)/g;
	// Strict npm package name (filters false positives like `${x}`, code fragments).
	const validPkg = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)$/;

	const externals = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = importRe.exec(bundle))) {
		const spec = m[1] ?? m[2];
		if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("data:") || !validPkg.test(spec)) {
			continue;
		}
		// Normalize to package root (@scope/name or name)
		const norm = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
		externals.add(norm);
	}

	const undeclared = [...externals].filter((e) => !runtimeDeps.has(e));
	const onlyDev = [...externals].filter((e) => devDeps.has(e) && !runtimeDeps.has(e));

	assert.deepEqual(
		undeclared,
		[],
		`dist/index.mjs imports packages NOT declared in dependencies/peerDependencies. ` +
			`These fail to resolve on a fresh \`npm install pi-crew\` (devDependencies are ` +
			`not installed in production) → bundle load failure → extension crash. ` +
			`Move each to "dependencies" (or "peerDependencies" if provided by Pi):\n  ` +
			undeclared.map((e) => `${e} (devDep? ${devDeps.has(e)})`).join("\n  "),
	);
	// Redundant explicit check — makes the failure message crystal clear.
	assert.deepEqual(
		onlyDev,
		[],
		`These packages are imported at runtime by the bundle but declared ONLY as ` +
			`devDependencies: ${onlyDev.join(", ")}. Move them to "dependencies".`,
	);
});
