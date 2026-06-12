import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCwdOverride } from "../../src/extension/registration/team-tool.ts";

test("resolveCwdOverride rejects directories outside the base cwd", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cwd-"));
	try {
		const base = path.join(root, "base");
		const sibling = path.join(root, "sibling");
		fs.mkdirSync(base, { recursive: true });
		fs.mkdirSync(sibling, { recursive: true });
		const result = resolveCwdOverride(base, "../sibling");
		assert.equal(result.ok, false);
		assert.match(result.error, /Invalid cwd override|outside/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resolveCwdOverride allows contained child directories", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cwd-"));
	try {
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });
		const result = resolveCwdOverride(root, "child");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.cwd, fs.realpathSync(child));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
