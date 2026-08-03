import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveCwdOverride } from "../../../../src/extension/registration/team-tool.ts";

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
	let root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cwd-"));
	try {
		// Canonicalize to long-name form matching production code (projectCrewRoot uses .native)
		try {
			const r = fs.realpathSync.native(root);
			root = r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			/* keep as-is */
		}
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });
		const result = resolveCwdOverride(root, "child");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.cwd, fs.realpathSync.native(child));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
