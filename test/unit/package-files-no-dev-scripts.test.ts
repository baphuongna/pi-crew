import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * PR-F13 / QA-2 regression guard.
 *
 * The `files` field historically used `*.ts`/`*.mjs` globs which npm matches
 * RECURSIVELY, shipping ~128KB of dev-only scripts to consumers (incl.
 * build-bundle.mjs, which the postinstall lifecycle would then try to run on
 * every consumer install). Those globs were replaced by an explicit allow-list
 * (`src/`, `dist/`, `index.ts`, `install.mjs`, etc.). This test runs a real
 * `npm pack --dry-run` and asserts that dev-only scripts under `scripts/` and
 * root dev-only `.ts` files are excluded from the published tarball.
 *
 * `--ignore-scripts` keeps the test hermetic: tarball file inclusion is
 * determined solely by the `files` field + `.npmignore`, independent of the
 * prepack/postinstall lifecycle scripts, so the computed file list is identical
 * while avoiding the prepack side-effect of deleting strip-types `.js`
 * companions from `src/`.
 */
function npmPackDryRun(root: string): string {
	// npm writes the `npm notice` tarball-contents listing to STDERR, so both
	// streams are captured and merged. status is asserted so a pack failure
	// surfaces as a clear error rather than a misleading assertion failure.
	const res = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 100_000,
	});
	assert.equal(res.status, 0, `npm pack --dry-run failed (exit ${res.status}): ${res.stderr}`);
	return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

test("npm pack --dry-run excludes dev-only scripts and root dev .ts (QA-2)", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, "..", "..");
	const output = npmPackDryRun(root);

	// Dev-only scripts that must NOT ship to consumers. The headline offender is
	// build-bundle.mjs — postinstall would otherwise execute it on every consumer
	// install. These were swept in by the recursive `*.ts`/`*.mjs` file globs.
	const devOnly = [
		"scripts/build-bundle.mjs",
		"scripts/test-runner.mjs",
		"scripts/check-bundle-size.mjs",
		"scripts/check-bundle-staleness.mjs",
		"scripts/check-lazy-imports.mjs",
		"scripts/check-conflict-markers.mjs",
		"scripts/dev-runner.mjs",
		"scripts/watch-bundle.mjs",
		"scripts/release-smoke.mjs",
		"scripts/profile-startup.mjs",
		"scripts/run-bench.mjs",
		"scripts/bench-check.mjs",
		"scripts/bench-cold-start.mjs",
		// Root dev-only .ts files (previously swept in by the *.ts glob).
		"index.bundle.ts",
		"test-integration-check.ts",
	];
	for (const rel of devOnly) {
		assert.ok(
			!output.includes(rel),
			`QA-2: dev-only file "${rel}" must NOT appear in npm pack --dry-run output. ` +
				`The "files" field must use an explicit allow-list, not *.ts/*.mjs globs ` +
				`(npm matches those recursively, shipping dev scripts to consumers).`,
		);
	}

	// Sanity: runtime-needed files MUST still ship (guards against over-pruning
	// — the extension entry + bin + lifecycle scripts must survive the switch to
	// an explicit allow-list).
	const mustShip = [
		"dist/index.mjs", // bundle entry (default since v0.9.17)
		"index.ts", // pi.extensions entry (strip-types fallback)
		"install.mjs", // bin entry
		"scripts/postinstall.mjs", // postinstall lifecycle runs this
		"scripts/clean-strip-types.mjs", // prepack lifecycle runs this
	];
	for (const rel of mustShip) {
		assert.ok(
			output.includes(rel),
			`regression: runtime-needed file "${rel}" must remain in npm pack --dry-run output`,
		);
	}
});

test("package.json files[] no longer uses recursive *.ts / *.mjs globs (QA-2 structural guard)", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, "..", "..");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		files?: string[];
	};
	const globs = (pkg.files ?? []).filter(
		(f) => f === "*.ts" || f === "*.mjs" || f === "*.js",
	);
	assert.deepEqual(
		globs,
		[],
		`QA-2: files[] must not contain bare *.ts/*.mjs/*.js globs (they match recursively ` +
			`and ship dev scripts). Use an explicit allow-list instead. Found: ${JSON.stringify(globs)}`,
	);
	// The explicit allow-list must still carry the runtime-needed entries.
	assert.ok(pkg.files?.includes("src/"), 'files[] must include "src/"');
	assert.ok(pkg.files?.includes("dist/index.mjs"), 'files[] must include "dist/index.mjs"');
	assert.ok(pkg.files?.includes("index.ts"), 'files[] must include "index.ts" (pi.extensions entry)');
	assert.ok(pkg.files?.includes("install.mjs"), 'files[] must include "install.mjs" (bin entry)');
});
