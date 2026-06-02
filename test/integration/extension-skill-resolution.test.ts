import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Integration test for the "in-place extension loading" pattern introduced
 * in oh-my-pi commit c5e3698f4 (2026-06-02). Pi-crew's `resources_discover`
 * handler in src/extension/register.ts:1734 uses
 *
 *     path.dirname(fileURLToPath(import.meta.url)) + "/../../skills"
 *
 * to locate the shipped skills. The new in-place loader keeps
 * `import.meta.url` pointing at the real source path (instead of a
 * mirrored temp dir), so this expression MUST resolve to a directory
 * containing SKILL.md files. If the resolution breaks (e.g. someone
 * adopts a "mirror" loader), the test below fails immediately.
 *
 * This test runs at test/integration/ so it can assert against the real
 * package layout (skills/ sibling to src/) without mocking.
 */
test("pi-crew skill directory resolves from import.meta.url (in-place loader compat)", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const extSkillDir = path.resolve(here, "..", "..", "skills");

	assert.ok(fs.existsSync(extSkillDir), `skill dir should exist at ${extSkillDir}`);
	const entries = fs.readdirSync(extSkillDir, { withFileTypes: true });
	const skillDirs = entries.filter((e) => e.isDirectory());
	assert.ok(skillDirs.length >= 1, `expected >=1 skill directory, got ${skillDirs.length} in ${extSkillDir}`);

	// At least one skill must contain a SKILL.md.
	let foundSkillMd = false;
	for (const dir of skillDirs) {
		const skillMd = path.join(extSkillDir, dir.name, "SKILL.md");
		if (fs.existsSync(skillMd)) {
			foundSkillMd = true;
			break;
		}
	}
	assert.ok(foundSkillMd, "at least one shipped skill must have SKILL.md");
});

test("session-scope skill dir is independent of extension-scope skill dir (no collision)", () => {
	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scope-isolated-"));
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const extSkillDir = path.resolve(here, "..", "..", "skills");
		const sessionSkillDir = path.resolve(tmpCwd, "skills");

		assert.notEqual(extSkillDir, sessionSkillDir, "session and ext skill dirs must differ");
		// session dir is freshly created and empty by default; ext dir is
		// shipped and non-empty. The two-layer lookup (session first, then
		// ext) must keep them separate so session overrides do not clobber
		// shipped skills.
		assert.ok(fs.existsSync(extSkillDir), "ext skill dir should be populated");
		assert.ok(!fs.existsSync(sessionSkillDir), "session skill dir should not exist by default");
	} finally {
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	}
});
