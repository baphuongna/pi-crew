import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const root = process.cwd();

function readPackage(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as Record<string, unknown>;
}

test("package snapshot keeps Phase 6 runtime docs, skills, and jiti loader dependency shippable", () => {
	const pkg = readPackage();
	const files = pkg.files as string[];
	// PKG-2: src/ no longer shipped (dist/index.mjs bundle is the entry since
	// v0.9.17; src/ was historical bloat). PKG-5: docs/ wholesale replaced by
	// a consumer whitelist. PKG-3: dist sourcemap excluded. skills/** +
	// schema.json still shipped.
	assert.ok(!files.includes("src/**/*.ts"), "PKG-2: src/ no longer shipped (bundle is the entry)");
	assert.ok(files.includes("dist/index.mjs"), "bundle shipped");
	assert.ok(!files.includes("dist/index.mjs.map"), "PKG-3: sourcemap excluded from tarball");
	assert.ok(!files.includes("docs/"), "PKG-5: docs/ wholesale replaced by whitelist");
	assert.ok(files.includes("docs/actions-reference.md"), "whitelisted consumer doc shipped");
	assert.ok(files.includes("docs/architecture.md"), "whitelisted consumer doc shipped");
	assert.ok(files.includes("skills/**"));
	assert.ok(!files.includes("skills/REFERENCE.md"));
	assert.ok(files.includes("schema.json"));

	const dependencies = pkg.dependencies as Record<string, string>;
	assert.ok(dependencies.jiti, "installed async runner requires jiti at runtime");

	const pi = pkg.pi as { extensions?: string[]; skills?: string[] };
	assert.deepEqual(pi.extensions, ["./index.ts"]);
	assert.deepEqual(pi.skills, ["./skills"]);

	for (const relativePath of [
		"docs/architecture.md",
		"docs/runtime-flow.md",
		"docs/commands-reference.md",
		"docs/actions-reference.md",
		"skills/safe-bash/SKILL.md",
		"skills/verification-before-done/SKILL.md",
		"skills/git-master/SKILL.md",
		"skills/read-only-explorer/SKILL.md",
		"skills/event-log-tracing/SKILL.md",
	]) {
		assert.equal(fs.existsSync(path.join(root, relativePath)), true, `${relativePath} must exist for npm pack`);
	}
});
