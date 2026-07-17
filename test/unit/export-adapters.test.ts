import assert from "node:assert/strict";
import test from "node:test";
import { claudeAdapter } from "../../src/adapters/claude-adapter.ts";
import { codexAdapter } from "../../src/adapters/codex-adapter.ts";
import { cursorAdapter } from "../../src/adapters/cursor-adapter.ts";
import { generateToolExport, resourcesToExportContent } from "../../src/adapters/export-util.ts";
import { createAdapterRegistry } from "../../src/adapters/registry.ts";
import type { ExportContent } from "../../src/adapters/types.ts";

function sampleContent(overrides?: Partial<ExportContent>): ExportContent {
	return {
		id: "explorer",
		name: "Explorer",
		description: "Explores codebases thoroughly",
		category: "research",
		tags: ["explore", "audit"],
		body: "You are an expert codebase explorer.",
		source: { type: "agent", name: "explorer" },
		...overrides,
	};
}

// ── Claude adapter ──────────────────────────────────────────────────

test("claude adapter: getFilePath generates .claude/commands path", () => {
	const path = claudeAdapter.getFilePath(sampleContent());
	assert.equal(path, ".claude/commands/pi-crew/explorer.md");
});

test("claude adapter: formatFile includes YAML frontmatter with safe quoting", () => {
	const output = claudeAdapter.formatFile(sampleContent());
	assert.match(output, /^---\n/);
	assert.match(output, /description: "Explores codebases thoroughly"/);
	assert.match(output, /category: "research"/);
	assert.match(output, /tags:\n {2}- "explore"\n {2}- "audit"/);
	assert.match(output, /# Explorer/);
	assert.match(output, /You are an expert codebase explorer\./);
});

test("claude adapter: formatFile safely quotes values with special YAML characters", () => {
	const output = claudeAdapter.formatFile(
		sampleContent({
			description: "Has: colons, 'quotes', and \"more\"",
			category: "cat: with: colons",
			tags: ["tag:with:colons", "tag'with'quotes"],
		}),
	);
	// JSON.stringify wraps in double quotes and escapes inner quotes
	assert.match(output, /description: "Has: colons, 'quotes', and \\"more\\""/);
	assert.match(output, /category: "cat: with: colons"/);
	assert.match(output, /- "tag:with:colons"/);
	assert.match(output, /- "tag'with'quotes"/);
});

test("claude adapter: formatFile omits tags line when empty", () => {
	const output = claudeAdapter.formatFile(sampleContent({ tags: [] }));
	assert.doesNotMatch(output, /tags:/);
});

// ── Cursor adapter ──────────────────────────────────────────────────

test("cursor adapter: getFilePath generates .cursor/rules path", () => {
	const path = cursorAdapter.getFilePath(sampleContent());
	assert.equal(path, ".cursor/rules/pi-crew-explorer.md");
});

test("cursor adapter: formatFile includes name header and description", () => {
	const output = cursorAdapter.formatFile(sampleContent());
	assert.match(output, /^# Explorer\n\n> Explores codebases thoroughly/);
});

test("cursor adapter: formatFile includes tags when present", () => {
	const output = cursorAdapter.formatFile(sampleContent());
	assert.match(output, /\*\*Tags:\*\* explore, audit/);
});

test("cursor adapter: formatFile omits tags when empty", () => {
	const output = cursorAdapter.formatFile(sampleContent({ tags: [] }));
	assert.doesNotMatch(output, /\*\*Tags:\*\*/);
});

// ── Codex adapter ───────────────────────────────────────────────────

test("codex adapter: getFilePath returns AGENTS.md", () => {
	const path = codexAdapter.getFilePath(sampleContent());
	assert.equal(path, "AGENTS.md");
});

test("codex adapter: formatFile includes section header with tags", () => {
	const output = codexAdapter.formatFile(sampleContent());
	assert.match(output, /## Explorer \(explore, audit\)/);
	assert.match(output, /\*\*Source:\*\* agent\/explorer/);
	assert.match(output, /\*\*Category:\*\* research/);
});

test("codex adapter: formatFile omits tags when empty", () => {
	const output = codexAdapter.formatFile(sampleContent({ tags: [] }));
	assert.match(output, /## Explorer\n/);
	assert.doesNotMatch(output, /## Explorer \(/);
});

// ── Registry ────────────────────────────────────────────────────────

test("registry: register and get adapter", () => {
	const registry = createAdapterRegistry();
	registry.register(claudeAdapter);
	const found = registry.get("claude");
	assert.equal(found, claudeAdapter);
});

test("registry: get returns undefined for unknown toolId", () => {
	const registry = createAdapterRegistry();
	assert.equal(registry.get("nonexistent"), undefined);
});

test("registry: getAll returns all registered adapters", () => {
	const registry = createAdapterRegistry();
	registry.register(claudeAdapter);
	registry.register(cursorAdapter);
	registry.register(codexAdapter);
	const all = registry.getAll();
	assert.equal(all.length, 3);
	const ids = all.map((a) => a.toolId);
	assert.ok(ids.includes("claude"));
	assert.ok(ids.includes("cursor"));
	assert.ok(ids.includes("codex"));
});

test("registry: register overwrites previous adapter with same toolId", () => {
	const registry = createAdapterRegistry();
	registry.register(claudeAdapter);
	registry.register({ ...claudeAdapter, toolName: "Overridden" });
	const found = registry.get("claude");
	assert.equal(found?.toolName, "Overridden");
});

// ── generateToolExport integration ──────────────────────────────────

test("generateToolExport throws for unknown toolId", () => {
	assert.throws(() => generateToolExport("unknown", []), /Unknown export adapter: unknown/);
});

test("generateToolExport produces files for claude adapter", () => {
	const result = generateToolExport("claude", [
		{
			kind: "agent",
			config: {
				name: "Explorer",
				description: "Explores codebases",
				source: "builtin",
				filePath: "/agents/explorer.md",
				systemPrompt: "Explore everything.",
				routing: { category: "research", triggers: ["explore"] },
			},
		},
	]);
	assert.equal(result.toolId, "claude");
	assert.equal(result.files.length, 1);
	assert.equal(result.files[0]!.path, ".claude/commands/pi-crew/explorer.md");
	assert.match(result.files[0]!.content, /# Explorer/);
});

test("resourcesToExportContent converts agent config", () => {
	const contents = resourcesToExportContent([
		{
			kind: "agent",
			config: {
				name: "Explorer",
				description: "Explores codebases",
				source: "builtin",
				filePath: "/agents/explorer.md",
				systemPrompt: "Explore everything.",
			},
		},
	]);
	assert.equal(contents.length, 1);
	assert.equal(contents[0]!.id, "explorer");
	assert.equal(contents[0]!.source.type, "agent");
});

test("resourcesToExportContent converts team config", () => {
	const contents = resourcesToExportContent([
		{
			kind: "team",
			config: {
				name: "Fast Fix",
				description: "Quick bug fixes",
				source: "builtin",
				filePath: "/teams/fast-fix.team.md",
				roles: [
					{
						name: "fixer",
						agent: "executor",
						description: "Applies fixes",
					},
				],
			},
		},
	]);
	assert.equal(contents[0]!.id, "fast-fix");
	assert.equal(contents[0]!.source.type, "team");
	assert.match(contents[0]!.body, /### Roles/);
});

test("resourcesToExportContent converts workflow config", () => {
	const contents = resourcesToExportContent([
		{
			kind: "workflow",
			config: {
				name: "Review Flow",
				description: "Code review pipeline",
				source: "builtin",
				filePath: "/workflows/review-flow.workflow.md",
				steps: [{ id: "review", role: "reviewer", task: "Review code" }],
			},
		},
	]);
	assert.equal(contents[0]!.id, "review-flow");
	assert.equal(contents[0]!.source.type, "workflow");
	assert.match(contents[0]!.body, /### Steps/);
});

test("resourcesToExportContent converts skill descriptor", () => {
	const contents = resourcesToExportContent([
		{
			kind: "skill",
			config: {
				name: "git-master",
				description: "Git operations skill",
				source: "package",
				path: "/skills/git-master/SKILL.md",
			},
		},
	]);
	assert.equal(contents[0]!.id, "git-master");
	assert.equal(contents[0]!.source.type, "skill");
});

// ── Multi-resource Codex export (CRITICAL-2 fix) ──────────────────

test("generateToolExport merges duplicate file paths for codex adapter", () => {
	const result = generateToolExport("codex", [
		{
			kind: "agent",
			config: {
				name: "Explorer",
				description: "Explores codebases",
				source: "builtin",
				filePath: "/agents/explorer.md",
				systemPrompt: "Explore everything.",
			},
		},
		{
			kind: "agent",
			config: {
				name: "Reviewer",
				description: "Reviews code",
				source: "builtin",
				filePath: "/agents/reviewer.md",
				systemPrompt: "Review code carefully.",
			},
		},
	]);
	// Codex maps everything to AGENTS.md, so duplicate paths must be merged
	assert.equal(result.files.length, 1);
	assert.equal(result.files[0]!.path, "AGENTS.md");
	assert.match(result.files[0]!.content, /## Explorer/);
	assert.match(result.files[0]!.content, /## Reviewer/);
});
