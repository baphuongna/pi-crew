import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const expectedSkills = ["safe-bash", "verification-before-done", "git-master", "read-only-explorer", "event-log-tracing"];

test("package ships built-in coding skills", () => {
	const root = process.cwd();
	for (const name of expectedSkills) {
		const skillPath = path.join(root, "skills", name, "SKILL.md");
		assert.equal(fs.existsSync(skillPath), true, `${name} should have SKILL.md`);
		const content = fs.readFileSync(skillPath, "utf-8");
		// Check frontmatter with optional triggers field
		assert.match(content, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+`));
		// Check skill title appears somewhere in the file (after frontmatter)
		assert.ok(content.includes(`# ${name}`), `${name} should contain # ${name} heading`);
		assert.ok(content.length > 100, `${name} should contain usable guidance`);
	}
});