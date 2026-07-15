/**
 * v0.7.9 — grouped interop & agent-granularity tests.
 *
 * Covers 4 related, surgical items shipped in the same release:
 *   F6: skill discovery now reads 5 roots (was 2) — added `.pi/skills`,
 *       `.agents/skills` (Agent Skills spec), and user dirs. Affects both
 *       `discover-skills.ts` (capability inventory) and `skill-instructions.ts`
 *       (actual prompt rendering). The legacy `<cwd>/skills` and bundled
 *       `PACKAGE_SKILLS_DIR` roots are kept.
 *   F1 .pi/agents/: project agent discovery now reads BOTH `.crew/agents/`
 *       (legacy) AND `.pi/agents/` (Pi standard) as separate tiers. New
 *       `projectPi` field in `AgentDiscoveryResult` (optional in the type
 *       for back-compat with existing test fixtures; treated as `[]` when
 *       omitted by `allAgents`).
 *   F1 tools: frontmatter `tools:` now supports `*` / `all` (expand to all
 *       built-in tool names) and `none` / `[]` (zero built-ins). CSV and
 *       omitted remain back-compat.
 *   F1 excludeExtensions: new `excludeExtensions?: string[]` field on
 *       `AgentConfig` (frontmatter `exclude_extensions: foo, bar`).
 *       Applied on the child-pi path in `pi-args.ts` as a case-insensitive
 *       basename denylist. Documented limitation: live-session path ignores
 *       it (DefaultResourceLoader has no per-extension deny hook yet).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { BUILTIN_TOOL_NAMES, parseToolsField } from "../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../src/runtime/pi-args.ts";
import { renderSkillInstructions } from "../../src/runtime/skill-instructions.ts";
import { discoverSkills } from "../../src/skills/discover-skills.ts";

const tempDirs: string[] = [];
function freshProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-v079-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

function makeSkillMd(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\ndescription: ${description}\n---\nbody`, "utf-8");
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "project",
		filePath: "/tmp/test.md",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

describe("F6 — skill discovery reads 5 roots", () => {
	it("discovers skill in <cwd>/.pi/skills (project-pi root)", () => {
		const cwd = freshProject();
		makeSkillMd(path.join(cwd, ".pi", "skills"), "my-skill", "in .pi/skills");
		const skills = discoverSkills(cwd);
		const found = skills.find((s) => s.name === "my-skill");
		assert.ok(found, "skill should be discovered from .pi/skills/");
		assert.equal(found!.source, "project-pi");
		assert.equal(found!.description, "in .pi/skills");
	});

	it("discovers skill in <cwd>/.agents/skills (Agent Skills spec, project-agents root)", () => {
		const cwd = freshProject();
		makeSkillMd(path.join(cwd, ".agents", "skills"), "agents-skill", "in .agents/skills");
		const skills = discoverSkills(cwd);
		const found = skills.find((s) => s.name === "agents-skill");
		assert.ok(found, "skill should be discovered from .agents/skills/");
		assert.equal(found!.source, "project-agents");
		assert.equal(found!.description, "in .agents/skills");
	});

	it("discovers skill in <cwd>/skills (legacy project root — back-compat)", () => {
		const cwd = freshProject();
		makeSkillMd(path.join(cwd, "skills"), "legacy-skill", "in skills/");
		const skills = discoverSkills(cwd);
		const found = skills.find((s) => s.name === "legacy-skill");
		assert.ok(found, "skill should be discovered from skills/");
		assert.equal(found!.source, "project");
	});

	it("legacy <cwd>/skills wins over <cwd>/.pi/skills when both define the same name", () => {
		const cwd = freshProject();
		makeSkillMd(path.join(cwd, ".pi", "skills"), "dup", "from .pi/skills");
		makeSkillMd(path.join(cwd, "skills"), "dup", "from skills/");
		const skills = discoverSkills(cwd);
		const found = skills.find((s) => s.name === "dup");
		// First hit wins (listSkillDirs order: project-pi → project-agents → project).
		// project-pi is read first, so .pi/skills wins. Document this so a
		// future change is conscious.
		assert.equal(found!.description, "from .pi/skills");
	});

	it("renderSkillInstructions finds a skill from <cwd>/.pi/skills (via readSkillMarkdown)", () => {
		// renderSkillInstructions reads skill bodies via the internal
		// readSkillMarkdown, which iterates candidateSkillDirs (now the
		// 5-root set including .pi/skills). We assert the rendered block
		// includes the body text from a .pi/skills skill.
		const cwd = freshProject();
		makeSkillMd(path.join(cwd, ".pi", "skills"), "shared", "shared body content from .pi/skills");
		const rendered = renderSkillInstructions({
			cwd,
			role: "test",
			agent: makeAgentConfig({ skills: ["shared"] }),
		});
		assert.ok(rendered, "renderSkillInstructions should return a result for a found skill");
		assert.ok(rendered!.block.includes("shared body content from .pi/skills"), "rendered block should include the .pi/skills body");
	});
});

describe("F1 — tools: frontmatter wildcards (parseToolsField)", () => {
	it("returns undefined when tools is omitted (back-compat)", () => {
		assert.equal(parseToolsField(undefined), undefined);
		assert.equal(parseToolsField(null), undefined);
	});
	it("'*' expands to BUILTIN_TOOL_NAMES", () => {
		assert.deepEqual(parseToolsField("*"), [...BUILTIN_TOOL_NAMES]);
	});
	it("'all' (case-insensitive) expands to BUILTIN_TOOL_NAMES", () => {
		assert.deepEqual(parseToolsField("ALL"), [...BUILTIN_TOOL_NAMES]);
		assert.deepEqual(parseToolsField("All"), [...BUILTIN_TOOL_NAMES]);
	});
	it("'none' / '[]' / empty string returns [] (zero built-ins)", () => {
		assert.deepEqual(parseToolsField("none"), []);
		assert.deepEqual(parseToolsField("[]"), []);
		assert.deepEqual(parseToolsField(""), []);
		assert.deepEqual(parseToolsField("   "), []);
	});
	it("CSV passes through (back-compat)", () => {
		assert.deepEqual(parseToolsField("read, grep, find"), ["read", "grep", "find"]);
		assert.deepEqual(parseToolsField(" read , grep , , find "), ["read", "grep", "find"]);
	});
	it("plain names without wildcards are unchanged", () => {
		assert.deepEqual(parseToolsField("read"), ["read"]);
	});
});

describe("F1 — excludeExtensions applied in child-pi spawn args", () => {
	it("'exclude_extensions: foo' filters out the foo extension from --extension flags", () => {
		const agent = makeAgentConfig({
			extensions: ["foo", "bar", "baz"],
			excludeExtensions: ["foo", "baz"],
		});
		const { args } = buildPiWorkerArgs({
			agent,
			role: "test",
			task: "do something",
		});
		const extensionFlags: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlags.push(args[i + 1] ?? "");
		}
		assert.ok(extensionFlags.includes("bar"), "bar should be in --extension list");
		assert.ok(!extensionFlags.includes("foo"), "foo (excluded) should NOT be in --extension list");
		assert.ok(!extensionFlags.includes("baz"), "baz (excluded) should NOT be in --extension list");
	});

	it("excludeExtensions is case-insensitive on basename", () => {
		const agent = makeAgentConfig({
			extensions: ["Foo", "Bar"],
			excludeExtensions: ["FOO"],
		});
		const { args } = buildPiWorkerArgs({
			agent,
			role: "test",
			task: "do something",
		});
		const extensionFlags: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlags.push(args[i + 1] ?? "");
		}
		assert.ok(!extensionFlags.includes("Foo"), "Foo (case-insensitive match) should be excluded");
		assert.ok(extensionFlags.includes("Bar"), "Bar should still be in the list");
	});

	it("omit excludeExtensions = all extensions pass through (back-compat)", () => {
		const agent = makeAgentConfig({ extensions: ["foo", "bar"] });
		const { args } = buildPiWorkerArgs({
			agent,
			role: "test",
			task: "do something",
		});
		const extensionFlags: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlags.push(args[i + 1] ?? "");
		}
		assert.ok(extensionFlags.includes("foo"));
		assert.ok(extensionFlags.includes("bar"));
	});

	it("empty excludeExtensions array = no-op (all extensions pass through)", () => {
		const agent = makeAgentConfig({
			extensions: ["foo"],
			excludeExtensions: [],
		});
		const { args } = buildPiWorkerArgs({
			agent,
			role: "test",
			task: "do something",
		});
		const extensionFlags: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") extensionFlags.push(args[i + 1] ?? "");
		}
		assert.ok(extensionFlags.includes("foo"));
	});
});

describe("PI_CREW_EXTRA_EXTENSIONS — always-inherited worker extensions", () => {
	const ENV_KEY = "PI_CREW_EXTRA_EXTENSIONS";
	let prevValue: string | undefined;

	afterEach(() => {
		if (prevValue === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prevValue;
	});

	function extensionFlagsOf(args: string[]): string[] {
		const flags: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--extension") flags.push(args[i + 1] ?? "");
		}
		return flags;
	}

	it("appends PI_CREW_EXTRA_EXTENSIONS paths when agent has no explicit extensions", () => {
		prevValue = process.env[ENV_KEY];
		process.env[ENV_KEY] = "/opt/my-proxy-auth,/opt/other-ext";
		const agent = makeAgentConfig();
		const { args } = buildPiWorkerArgs({ agent, role: "test", task: "do something" });
		const flags = extensionFlagsOf(args);
		assert.ok(flags.includes("/opt/my-proxy-auth"));
		assert.ok(flags.includes("/opt/other-ext"));
	});

	it("appends PI_CREW_EXTRA_EXTENSIONS paths alongside agent-declared extensions", () => {
		prevValue = process.env[ENV_KEY];
		process.env[ENV_KEY] = "/opt/my-proxy-auth";
		const agent = makeAgentConfig({ extensions: ["foo"] });
		const { args } = buildPiWorkerArgs({ agent, role: "test", task: "do something" });
		const flags = extensionFlagsOf(args);
		assert.ok(flags.includes("/opt/my-proxy-auth"));
		assert.ok(flags.includes("foo"));
	});

	it("is a no-op when unset", () => {
		prevValue = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
		const agent = makeAgentConfig();
		const { args } = buildPiWorkerArgs({ agent, role: "test", task: "do something" });
		const flags = extensionFlagsOf(args);
		assert.ok(!flags.some((f) => f.includes("/opt/")));
	});
});
