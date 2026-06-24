import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSkills, getLastDiscoveryDiagnostics } from "../../src/skills/discover-skills.ts";

describe("discoverSkills", () => {
	it("returns package skills from pi-crew skills directory", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const skills = discoverSkills(cwd);
			assert.ok(Array.isArray(skills));
			// Package skills should always exist (pi-crew ships with skills/)
			assert.ok(skills.length > 0, "should find at least one package skill");
			// F6 (v0.7.9): skills may now come from any of the expanded source
			// set (project-pi, project-agents, project, user-pi, user-agents,
			// package). The test cwd is fresh but user-skill-roots from
			// $HOME can still leak in on a developer machine — accept any
			// valid source rather than asserting the old 2-source set.
			const validSources = new Set([
				"project", "package", "project-pi", "user-pi", "project-agents", "user-agents",
			]);
			assert.ok(skills.every((s) => validSources.has(s.source)));
			// All should have SKILL.md path
			for (const skill of skills) {
				assert.ok(fs.existsSync(skill.path), `skill path should exist: ${skill.path}`);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reads project skills from cwd/skills directory", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const projectSkillsDir = path.join(cwd, "skills", "test-skill");
			fs.mkdirSync(projectSkillsDir, { recursive: true });
			fs.writeFileSync(path.join(projectSkillsDir, "SKILL.md"), "---\ndescription: Test skill description\n---\n\nTest skill body.");
			const skills = discoverSkills(cwd);
			const projectSkill = skills.find((s) => s.name === "test-skill" && s.source === "project");
			assert.ok(projectSkill, "should find project skill");
			assert.equal(projectSkill.description, "Test skill description");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("handles SKILL.md without frontmatter", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const projectSkillsDir = path.join(cwd, "skills", "no-frontmatter");
			fs.mkdirSync(projectSkillsDir, { recursive: true });
			fs.writeFileSync(path.join(projectSkillsDir, "SKILL.md"), "Just a plain skill file without frontmatter.");
			const skills = discoverSkills(cwd);
			const skill = skills.find((s) => s.name === "no-frontmatter");
			assert.ok(skill, "should find skill without frontmatter");
			assert.equal(skill.description, "");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("handles missing skills directory gracefully", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const skills = discoverSkills(cwd);
			// Should still return package skills, but no project skills
			assert.ok(Array.isArray(skills));
			assert.ok(!skills.some((s) => s.source === "project"));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips directories without SKILL.md", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const noSkillDir = path.join(cwd, "skills", "no-skill-md");
			fs.mkdirSync(noSkillDir, { recursive: true });
			fs.writeFileSync(path.join(noSkillDir, "README.md"), "Not a skill.");
			const skills = discoverSkills(cwd);
			assert.ok(!skills.some((s) => s.name === "no-skill-md"));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips skill directories with unsafe names", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			for (const unsafeName of ["../escape", "..\\win", ".hidden", "has space", "dot.path"]) {
				const skillDir = path.join(cwd, "skills", unsafeName);
				try {
					fs.mkdirSync(skillDir, { recursive: true });
					fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: unsafe\n---\nunsafe");
				} catch { /* some names may fail mkdir on certain platforms */ }
			}
			const skills = discoverSkills(cwd);
			for (const skill of skills) {
				assert.ok(/^[A-Za-z0-9_-]+$/.test(skill.name), `skill name should be safe: ${skill.name}`);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips symlinked skill directories", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const outsideDir = path.join(cwd, "outside");
			fs.mkdirSync(outsideDir, { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "SKILL.md"), "---\ndescription: leaked\n---\nleaked");
			const skillsDir = path.join(cwd, "skills");
			fs.mkdirSync(skillsDir, { recursive: true });
			try {
				fs.symlinkSync(outsideDir, path.join(skillsDir, "symlinked"));
			} catch { /* symlinks may not be supported on some Windows configs */ }
			const skills = discoverSkills(cwd);
			const symlinked = skills.find((s) => s.name === "symlinked" && s.source === "project");
			assert.equal(symlinked, undefined, "should not discover symlinked skill directories");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("skips symlinked SKILL.md files", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-"));
		try {
			const outsideFile = path.join(cwd, "outside.md");
			fs.writeFileSync(outsideFile, "---\ndescription: leaked\n---\nleaked");
			const skillDir = path.join(cwd, "skills", "linked-md");
			fs.mkdirSync(skillDir, { recursive: true });
			try {
				fs.symlinkSync(outsideFile, path.join(skillDir, "SKILL.md"));
			} catch { /* symlinks may not be supported */ }
			const skills = discoverSkills(cwd);
			const linked = skills.find((s) => s.name === "linked-md" && s.source === "project");
			assert.equal(linked, undefined, "should not discover symlinked SKILL.md files");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	// L3: strict validation + diagnostics plumbing.
	it("excludes malformed skills and records HARD diagnostics", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-diag-"));
		try {
			const badDir = path.join(cwd, "skills", "bad-name-UpperCase");
			fs.mkdirSync(badDir, { recursive: true });
			fs.writeFileSync(path.join(badDir, "SKILL.md"), "---\nname: BadName\ndescription: x\n---\nbody");
			const skills = discoverSkills(cwd);
			const found = skills.find((s) => s.name === "bad-name-UpperCase");
			assert.equal(found, undefined, "malformed skill must be excluded");
			const diagnostics = getLastDiscoveryDiagnostics();
			assert.ok(
				diagnostics.some((d) => d.field === "name" && d.severity === "error"),
				"diagnostics should include a HARD name error",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("includes bundled package skills with valid frontmatter", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skills-pkg-"));
		try {
			// No project skills; we should still get the bundled ones.
			const skills = discoverSkills(cwd);
			assert.ok(skills.length > 0, "should find at least the bundled package skills");
			// Filter to ONLY bundled (package source) skills so user-skill
			// diagnostics in the home dir don't pollute the assertion.
			const bundled = skills.filter((s) => s.source === "package");
			assert.ok(bundled.length > 0, "should find at least one bundled package skill");
			for (const s of bundled) {
				assert.ok(s.name.length > 0, `bundled skill must have a name: ${s.path}`);
				assert.ok(typeof s.description === "string", `description must be a string: ${s.path}`);
			}
			// L3 HYBRID policy: bundled skills should not produce HARD diagnostics
			// for their own frontmatter (we pre-flighted them when we wrote the
			// strictness). However, user-skill HARD diagnostics in the home dir
			// are NOT a regression — they're surfacing real frontmatter bugs
			// the user should know about. So we filter assertions to package
			// source only.
			const diagnostics = getLastDiscoveryDiagnostics();
			const bundledPaths = new Set(bundled.map((s) => path.dirname(s.path)));
			const hardFromBundled = diagnostics.filter((d) => d.severity === "error" && bundledPaths.has(d.path));
			assert.equal(hardFromBundled.length, 0, `bundled skills must produce no HARD diagnostics; got: ${JSON.stringify(hardFromBundled, null, 2)}`);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
