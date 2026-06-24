/**
 * L3 — SKILL.md frontmatter validator tests (table-driven).
 *
 * Mirrors the test strategy in the implementation plan (§ L3 Step 1):
 *   - valid skill (all fields) → ok
 *   - missing/empty name → HARD error (but back-compat: derives from dir)
 *   - name with uppercase/underscore/length>64 → HARD error
 *   - missing description → HARD error
 *   - description with `<` / `>` / length>1024 → HARD error
 *   - unknown prop → SOFT warn, ok stays true
 *   - allowed-tools not array → HARD error
 *   - metadata not object → HARD error
 *   - YAML parse error → HARD error
 *   - parseSkillFrontmatter handles multi-line folded (`>`), quoted strings,
 *     and nested mappings correctly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseSkillFrontmatter,
	validateSkillFrontmatter,
	ALLOWED_SKILL_PROPS,
} from "../../src/skills/validate.ts";

const tempDirs: string[] = [];

function freshSkillDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-validate-"));
	tempDirs.push(dir);
	return dir;
}

function makeSkill(skillDir: string, skillMdBody: string): void {
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillMdBody, "utf-8");
}

function cleanup(): void {
	while (tempDirs.length > 0) {
		const d = tempDirs.pop()!;
		try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

describe("ALLOWED_SKILL_PROPS whitelist", () => {
	it("contains exactly the 8 documented properties", () => {
		assert.deepEqual(
			[...ALLOWED_SKILL_PROPS].sort(),
			["allowed-tools", "author", "compatibility", "description", "license", "metadata", "name", "version"].sort(),
		);
	});
});

describe("parseSkillFrontmatter", () => {
	it("returns empty object when no frontmatter", () => {
		const r = parseSkillFrontmatter("Just a body.\nNo frontmatter here.");
		assert.equal(r.ok, true);
		if (r.ok) assert.deepEqual(r.data, {});
	});

	it("parses simple key:value", () => {
		const r = parseSkillFrontmatter("---\nname: foo\ndescription: bar\n---\nbody");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.data.name, "foo");
			assert.equal(r.data.description, "bar");
		}
	});

	it("parses quoted strings (single + double)", () => {
		const r1 = parseSkillFrontmatter('---\nname: "foo-bar"\ndescription: \'hello world\'\n---\nbody');
		assert.equal(r1.ok, true);
		if (r1.ok) {
			assert.equal(r1.data.name, "foo-bar");
			assert.equal(r1.data.description, "hello world");
		}
	});

	it("parses multi-line folded scalar (description: >)", () => {
		const r = parseSkillFrontmatter(
			"---\nname: my-skill\ndescription: >\n  This is a long\n  description that spans\n  multiple lines.\n---\nbody",
		);
		assert.equal(r.ok, true);
		if (r.ok) {
			// Folded scalars join lines with spaces.
			assert.match(r.data.description as string, /This is a long description that spans multiple lines\./);
		}
	});

	it("parses lists (allowed-tools / triggers)", () => {
		const r = parseSkillFrontmatter(
			"---\nname: my-skill\ndescription: x\nallowed-tools:\n  - read\n  - grep\n---\nbody",
		);
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.deepEqual(r.data["allowed-tools"], ["read", "grep"]);
		}
	});

	it("parses nested object (metadata)", () => {
		const r = parseSkillFrontmatter(
			"---\nname: my-skill\ndescription: x\nmetadata:\n  audience: internal\n  priority: high\n---\nbody",
		);
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.deepEqual(r.data.metadata, { audience: "internal", priority: "high" });
		}
	});

	it("rejects scalar frontmatter", () => {
		const r = parseSkillFrontmatter("---\njust-a-string\n---\nbody");
		assert.equal(r.ok, false);
	});

	it("rejects invalid YAML with parse error", () => {
		const r = parseSkillFrontmatter("---\nname: [unclosed\n---\nbody");
		assert.equal(r.ok, false);
	});
});

describe("validateSkillFrontmatter — valid cases", () => {
	it("ok=true for fully valid skill", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: good-skill\ndescription: A valid skill.\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, true);
			assert.equal(r.errors.length, 0);
			assert.equal(r.manifest?.name, "good-skill");
			assert.equal(r.manifest?.description, "A valid skill.");
		} finally { cleanup(); }
	});

	it("ok=true with all optional fields populated", () => {
		const dir = freshSkillDir();
		makeSkill(
			dir,
			"---\nname: full-skill\ndescription: Full skill.\nlicense: MIT\nallowed-tools:\n  - read\n  - grep\nmetadata:\n  audience: internal\ncompatibility: \">=1.0.0\"\nversion: 1.2.3\nauthor: tester\n---\nbody",
		);
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, true);
			assert.equal(r.manifest?.license, "MIT");
			assert.deepEqual(r.manifest?.allowedTools, ["read", "grep"]);
			assert.deepEqual(r.manifest?.metadata, { audience: "internal" });
			assert.equal(r.manifest?.compatibility, ">=1.0.0");
			assert.equal(r.manifest?.version, "1.2.3");
			assert.equal(r.manifest?.author, "tester");
		} finally { cleanup(); }
	});

	it("ok=true for SOFT warning (unknown prop keeps skill)", () => {
		const dir = freshSkillDir();
		// `origin` and `triggers` are unknown props commonly used by bundled skills.
		makeSkill(dir, "---\nname: bundled-style\ndescription: ok\norigin: pi-crew\ntriggers:\n  - \"do thing\"\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, true);
			// Two soft warnings: <unknown-prop:origin> and <unknown-prop:triggers>
			const softFields = r.errors.filter((e) => e.severity === "warn").map((e) => e.field);
			assert.ok(softFields.includes("<unknown-prop:origin>"));
			assert.ok(softFields.includes("<unknown-prop:triggers>"));
		} finally { cleanup(); }
	});

	it("ok=true with derived name when frontmatter omits name (back-compat)", () => {
		const dir = path.join(freshSkillDir(), "derived-name-skill");
		fs.mkdirSync(dir, { recursive: true });
		makeSkill(dir, "---\ndescription: only description, no name\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, true);
			assert.equal(r.manifest?.name, "derived-name-skill"); // derived from dir
			assert.ok(r.errors.some((e) => e.severity === "warn" && e.field === "name"));
		} finally { cleanup(); }
	});

	it("ok=true for empty SKILL.md (no frontmatter at all)", () => {
		const dir = path.join(freshSkillDir(), "no-frontmatter");
		fs.mkdirSync(dir, { recursive: true });
		makeSkill(dir, "Just plain markdown body, no YAML block.");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, true);
			assert.equal(r.manifest?.name, "no-frontmatter");
			assert.equal(r.manifest?.description, "");
		} finally { cleanup(); }
	});
});

describe("validateSkillFrontmatter — HARD errors", () => {
	it("ok=false when name has uppercase", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: BadName\ndescription: x\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && e.field === "name"));
		} finally { cleanup(); }
	});

	it("ok=false when name has underscore", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: bad_name\ndescription: x\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && e.field === "name"));
		} finally { cleanup(); }
	});

	it("ok=false when name exceeds 64 chars", () => {
		const dir = freshSkillDir();
		const longName = "a".repeat(65);
		makeSkill(dir, `---\nname: ${longName}\ndescription: x\n---\nbody`);
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && /exceeds 64/.test(e.reason)));
		} finally { cleanup(); }
	});

	it("ok=false when description contains '<' or '>'", () => {
		const dir1 = freshSkillDir();
		makeSkill(dir1, "---\nname: skill-lt\ndescription: bad <script> tag\n---\nbody");
		const dir2 = freshSkillDir();
		makeSkill(dir2, "---\nname: skill-gt\ndescription: bad >here\n---\nbody");
		try {
			const r1 = validateSkillFrontmatter(dir1);
			const r2 = validateSkillFrontmatter(dir2);
			assert.equal(r1.ok, false);
			assert.equal(r2.ok, false);
			assert.ok(r1.errors.some((e) => e.severity === "error" && e.field === "description"));
		} finally { cleanup(); }
	});

	it("ok=false when description exceeds 1024 chars", () => {
		const dir = freshSkillDir();
		const longDesc = "x".repeat(1025);
		makeSkill(dir, `---\nname: long-desc\ndescription: ${longDesc}\n---\nbody`);
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && /exceeds 1024/.test(e.reason)));
		} finally { cleanup(); }
	});

	it("ok=false when description is missing", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: no-desc\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && /Required field 'description'/.test(e.reason)));
		} finally { cleanup(); }
	});

	it("ok=false when allowed-tools is not array of strings", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: bad-tools\ndescription: x\nallowed-tools: just-a-string\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && e.field === "allowed-tools"));
		} finally { cleanup(); }
	});

	it("ok=false when metadata is not object", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: bad-meta\ndescription: x\nmetadata: \"a string, not an object\"\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && e.field === "metadata"));
		} finally { cleanup(); }
	});

	it("ok=false when version is not semver-ish", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: bad-ver\ndescription: x\nversion: not-semver\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.severity === "error" && e.field === "version"));
		} finally { cleanup(); }
	});

	it("ok=false when SKILL.md cannot be read", () => {
		const dir = freshSkillDir(); // exists but no SKILL.md inside
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.field === "SKILL.md"));
		} finally { cleanup(); }
	});

	it("ok=false on YAML parse error", () => {
		const dir = freshSkillDir();
		makeSkill(dir, "---\nname: [unclosed bracket\ndescription: x\n---\nbody");
		try {
			const r = validateSkillFrontmatter(dir);
			assert.equal(r.ok, false);
			assert.ok(r.errors.some((e) => e.field === "frontmatter" && /YAML parse error/.test(e.reason)));
		} finally { cleanup(); }
	});
});
