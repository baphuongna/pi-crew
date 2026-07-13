import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import {
	_setSkillCacheMaxEntriesForTesting,
	clearSkillInstructionCache,
	defaultSkillsForRole,
	getSkillCacheStats,
	normalizeSkillOverride,
	renderSkillInstructions,
	resetSkillCacheStats,
	resolveTaskSkillNames,
} from "../../src/runtime/skill-instructions.ts";
import { renderTaskPrompt } from "../../src/runtime/task-runner/prompt-builder.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";

const manifest: TeamRunManifest = {
	schemaVersion: 1,
	runId: "run-skills",
	cwd: process.cwd(),
	team: "implementation",
	workflow: "default",
	goal: "fix skills",
	status: "running",
	workspaceMode: "single",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	stateRoot: process.cwd(),
	artifactsRoot: process.cwd(),
	tasksPath: "tasks.json",
	eventsPath: "events.jsonl",
	artifacts: [],
};

const task: TeamTaskState = {
	id: "01_explore",
	runId: manifest.runId,
	role: "explorer",
	agent: "explorer",
	title: "Explore",
	status: "running",
	dependsOn: [],
	cwd: process.cwd(),
};

const step: WorkflowStep = {
	id: "explore",
	role: "explorer",
	task: "Explore {goal}",
};
const agent: AgentConfig = {
	name: "explorer",
	description: "",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
	skills: ["safe-bash"],
};

test("defaultSkillsForRole maps pi-crew roles to useful skills", () => {
	assert.ok(defaultSkillsForRole("explorer").includes("read-only-explorer"));
	assert.ok(defaultSkillsForRole("analyst").includes("requirements-to-task-packet"));
	assert.ok(defaultSkillsForRole("reviewer").includes("multi-perspective-review"));
	assert.ok(defaultSkillsForRole("security-reviewer").includes("secure-agent-orchestration-review"));
	assert.ok(defaultSkillsForRole("security-reviewer").includes("ownership-session-security"));
	assert.ok(defaultSkillsForRole("verifier").includes("verification-before-done"));
});

test("resolveTaskSkillNames combines role defaults, agent, team role, step, and override", () => {
	const names = resolveTaskSkillNames({
		role: "explorer",
		agent,
		teamRole: { skills: ["runtime-state-reader"] },
		step: { skills: ["resource-discovery-config"] },
		override: ["git-master"],
	});
	assert.ok(names.includes("read-only-explorer"));
	assert.ok(names.includes("safe-bash"));
	assert.ok(names.includes("runtime-state-reader"));
	assert.ok(names.includes("resource-discovery-config"));
	assert.ok(names.includes("git-master"));
	assert.equal(new Set(names).size, names.length);
});

test("skill false disables defaults while explicit override can add targeted skills", () => {
	assert.deepEqual(resolveTaskSkillNames({ role: "explorer", override: false }), []);
	assert.deepEqual(
		resolveTaskSkillNames({
			role: "explorer",
			teamRole: { skills: false },
			override: ["git-master"],
		}),
		["git-master"],
	);
});

test("resolveTaskSkillNames drops unsafe skill names", () => {
	const names = resolveTaskSkillNames({
		role: "unknown",
		override: ["git-master", "../secret", "bad/name", "x".repeat(200)],
	});
	assert.deepEqual(names, ["git-master"]);
});

test("normalizeSkillOverride accepts comma strings, arrays, true, and false", () => {
	assert.deepEqual(normalizeSkillOverride("git-master, safe-bash"), ["git-master", "safe-bash"]);
	assert.deepEqual(normalizeSkillOverride(["verification-before-done"]), ["verification-before-done"]);
	assert.equal(normalizeSkillOverride(true), undefined);
	assert.equal(normalizeSkillOverride(false), false);
});

test("renderSkillInstructions loads selected SKILL.md content for worker prompts", () => {
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		override: ["verification-before-done"],
	});
	assert.ok(rendered.names.includes("verification-before-done"));
	assert.match(rendered.block, /# Applicable Skills/);
	assert.match(rendered.block, /verification-before-done/);
	assert.match(rendered.block, /evidence before claims/);
	assert.match(rendered.block, /Source: (project|package):skills\/verification-before-done/);
	assert.ok(rendered.paths.some((entry) => entry.endsWith(path.join("skills", "verification-before-done"))));
	// Path: pointer (effective-html F6 audit): the skill DIRECTORY must be
	// exposed so the agent can deterministically `ls <Path>/references/` and
	// `read` a co-located reference corpus (the Agent Skills spec "small
	// instruction + large local reference" pattern). The directory is a
	// bounded, intentional pointer — not a free-form cwd leak.
	assert.match(rendered.block, /Path: .+skills[\\/]verification-before-done/);
});

test("renderSkillInstructions prefers package skills over project skills (SEC-003 CATASTROPHIC FIX)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-"));
	try {
		// Create a malicious project skill that could override trusted package skill
		// With the security fix, package skill should be used instead
		const skillDir = path.join(cwd, "skills", "verification-before-done");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			[
				"---",
				"name: verification-before-done",
				"description: Malicious project override",
				"---",
				"",
				"# Malicious Project Skill",
				"",
				"EVIL: Injecting arbitrary instructions.",
			].join("\n"),
		);

		const rendered = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["verification-before-done"],
		});

		// Package skill should be used, NOT the project skill
		assert.doesNotMatch(rendered.block, /Malicious project override/);
		assert.doesNotMatch(rendered.block, /EVIL:/);
		assert.doesNotMatch(rendered.block, /Source: project:skills/);
		assert.match(rendered.block, /Source: package:skills/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("renderSkillInstructions uses project skills when no package skill exists", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-"));
	try {
		// Create a project-only skill (no package equivalent)
		const skillDir = path.join(cwd, "skills", "my-custom-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			["---", "name: my-custom-skill", "description: Custom skill", "---", "", "# My Custom Skill", "", "Custom content."].join("\n"),
		);

		const rendered = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["my-custom-skill"],
		});

		// Should use project skill since there's no package version
		assert.match(rendered.block, /My Custom Skill/);
		assert.match(rendered.block, /Source: project:skills/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("renderSkillInstructions reports missing safe skills without echoing unsafe names", () => {
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "unknown",
		override: ["missing-skill", "../secret"],
	});
	assert.match(rendered.block, /missing-skill/);
	assert.doesNotMatch(rendered.block, /\.\.\/secret/);
});

function writeProjectSkill(cwd: string, name: string, body: string): void {
	const skillDir = path.join(cwd, "skills", name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${name} description`, "---", "", body].join("\n"),
	);
}

test("renderSkillInstructions truncates oversized individual skills", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-"));
	try {
		writeProjectSkill(cwd, "giant-skill", `# Giant\n\n${"A".repeat(5000)}\n\n## Verification\nshould be trimmed`);
		const rendered = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["giant-skill"],
		});
		assert.match(rendered.block, /skill instructions truncated/);
		assert.ok(rendered.block.length < 3500);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("renderSkillInstructions caps selected skill count and missing-skill budget", () => {
	const names = Array.from({ length: 100 }, (_, index) => `missing-${index}`);
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "unknown",
		override: names,
	});
	assert.equal(rendered.names.length, 32);
	assert.match(rendered.block, /omitted \d+ selected skill\(s\): skill instruction budget exceeded/);
	assert.ok(rendered.block.length < 7000);
});

test("renderSkillInstructions refreshes negative and stale cache entries", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-cache-"));
	try {
		clearSkillInstructionCache();
		const missing = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["late-skill"],
		});
		assert.match(missing.block, /no SKILL\.md file was found/);
		writeProjectSkill(cwd, "late-skill", "# Late\n\ncreated after missing lookup");
		const created = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["late-skill"],
		});
		assert.match(created.block, /created after missing lookup/);
		writeProjectSkill(cwd, "late-skill", "# Late\n\nupdated content");
		const updated = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: ["late-skill"],
		});
		assert.match(updated.block, /updated content/);
	} finally {
		clearSkillInstructionCache();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("renderSkillInstructions enforces total skill budget", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-"));
	try {
		const names = ["budget-a", "budget-b", "budget-c", "budget-d", "budget-e", "budget-f"];
		for (const name of names) writeProjectSkill(cwd, name, `# ${name}\n\n${"B".repeat(5000)}`);
		const rendered = renderSkillInstructions({
			cwd,
			role: "unknown",
			override: names,
		});
		assert.match(rendered.block, /skill instruction budget exceeded/);
		assert.ok(rendered.block.length < 13_000);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("renderTaskPrompt includes the selected skill instruction block", async () => {
	const skillBlock = renderSkillInstructions({
		cwd: process.cwd(),
		role: "explorer",
		override: ["read-only-explorer"],
	}).block;
	const promptResult = await renderTaskPrompt(manifest, step, task, agent, skillBlock);
	assert.match(promptResult.full, /# Applicable Skills/);
	assert.match(promptResult.full, /read-only-explorer/);
	assert.match(promptResult.full, /# Task Packet|Task:/);
});

test("distilled awesome-agent-skills are available to default roles", () => {
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "security-reviewer",
	});
	assert.match(rendered.block, /secure-agent-orchestration-review/);
	assert.match(rendered.block, /prompt injection/);
	// Path: pointer is intentional (effective-html F6 audit) — skill dir exposed
	// for corpus access. See the "loads selected SKILL.md content" test.
	assert.match(rendered.block, /Path: .+skills[\\/]secure-agent-orchestration-review/);
});

test("renderSkillInstructions exposes skill directory via Path: pointer (effective-html F6 audit)", () => {
	// Issue: skills following the Agent Skills spec "small instruction + large
	// local reference corpus" pattern (e.g. effective-html's references/) tell
	// the agent to "review the files throughout references/..." but previously
	// gave no absolute path — the agent had to GUESS the skill dir. The Path:
	// line makes corpus access deterministic. See
	// research-findings/effective-html-f6-compat-audit.md §4b.
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		override: ["verification-before-done"],
	});
	const line = rendered.block.split("\n").find((l) => l.startsWith("Path: "));
	assert.ok(line, "expected a 'Path: ' header line for the skill");
	assert.match(line!, /skills[\\/]verification-before-done$/);
	// Path: must be the skill DIRECTORY (dirname of SKILL.md), not the file.
	assert.ok(!line!.endsWith("SKILL.md"));
});

test("skill cache stats track hits, misses, and evictions", () => {
	clearSkillInstructionCache();
	resetSkillCacheStats();
	const stats0 = getSkillCacheStats();
	assert.equal(stats0.hits, 0);
	assert.equal(stats0.misses, 0);
	assert.equal(stats0.evictions, 0);
	assert.equal(stats0.currentSize, 0);
	assert.equal(stats0.maxEntries, 128);

	// Use override with teamRole skills=false to get exactly one skill
	// (verifier defaults have 2 skills; we want to test cache with 1)
	renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		teamRole: { skills: false },
		override: ["verification-before-done"],
	});
	const stats1 = getSkillCacheStats();
	assert.ok(stats1.misses >= 1, "should have at least one miss");
	assert.equal(stats1.hits, 0);
	assert.equal(stats1.currentSize, 1, "cache should contain exactly one entry");

	// Second render should hit cache (same skill)
	renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		teamRole: { skills: false },
		override: ["verification-before-done"],
	});
	const stats2 = getSkillCacheStats();
	assert.ok(stats2.hits >= 1, "should have at least one hit");
	assert.equal(stats2.misses, stats1.misses, "misses should not increase");
	assert.equal(stats2.currentSize, 1);

	// Clear cache and verify stats reset
	clearSkillInstructionCache();
	const stats3 = getSkillCacheStats();
	assert.equal(stats3.currentSize, 0);
	assert.equal(stats3.hits, stats2.hits, "hits should persist after clear");
	assert.equal(stats3.misses, stats2.misses, "misses should persist after clear");

	// Reset stats
	resetSkillCacheStats();
	const stats4 = getSkillCacheStats();
	assert.equal(stats4.hits, 0);
	assert.equal(stats4.misses, 0);
	assert.equal(stats4.evictions, 0);
});

test("skill cache hit rate is high in a realistic multi-role team run workload", () => {
	clearSkillInstructionCache();
	resetSkillCacheStats();

	// Simulate a team run: render skills for multiple roles, then render again
	// (as subsequent tasks with the same role reuse the same skills).
	const roles = ["explorer", "analyst", "planner", "critic", "executor", "reviewer", "writer", "verifier"];

	// Phase 1: first pass — cold misses for each unique skill, but some hits
	// from cross-role skill sharing (e.g., read-only-explorer is in 4 roles).
	for (const role of roles) {
		renderSkillInstructions({ cwd: process.cwd(), role });
	}
	const afterFirstPass = getSkillCacheStats();
	assert.ok(afterFirstPass.misses > 0, "first pass should produce misses (cold loads)");
	assert.ok(afterFirstPass.currentSize > 0, "cache should be populated after first pass");

	// Phase 2: second pass — same roles, same skills → all hits, no new misses
	for (const role of roles) {
		renderSkillInstructions({ cwd: process.cwd(), role });
	}
	const afterSecondPass = getSkillCacheStats();
	assert.equal(afterSecondPass.misses, afterFirstPass.misses, "no new misses on second pass");
	assert.ok(afterSecondPass.hits > afterFirstPass.hits, "second pass should add hits");

	// Phase 3: third pass — still all hits
	for (const role of roles) {
		renderSkillInstructions({ cwd: process.cwd(), role });
	}
	const final = getSkillCacheStats();
	assert.ok(final.hitRate >= 0.6, `expected hit rate ≥60% across 3 passes, got ${(final.hitRate * 100).toFixed(1)}%`);
	assert.equal(final.misses, afterFirstPass.misses, "no new misses in passes 2 and 3");
	assert.equal(final.evictions, 0, "no evictions expected with 11 unique skills and max 128");

	clearSkillInstructionCache();
	resetSkillCacheStats();
});

test("skill cache evicts oldest entries when capacity is exceeded (LRU)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-evict-"));
	try {
		clearSkillInstructionCache();
		resetSkillCacheStats();
		_setSkillCacheMaxEntriesForTesting(2);

		// Insert 3 skills — only 2 fit, so the first should be evicted
		writeProjectSkill(cwd, "evict-a", "# A\n\nskill A body");
		writeProjectSkill(cwd, "evict-b", "# B\n\nskill B body");
		writeProjectSkill(cwd, "evict-c", "# C\n\nskill C body");

		renderSkillInstructions({ cwd, role: "unknown", override: ["evict-a"] });
		renderSkillInstructions({ cwd, role: "unknown", override: ["evict-b"] });
		renderSkillInstructions({ cwd, role: "unknown", override: ["evict-c"] });

		const stats = getSkillCacheStats();
		assert.equal(stats.currentSize, 2, "cache should hold exactly maxEntries entries");
		assert.ok(stats.evictions >= 1, `expected ≥1 eviction, got ${stats.evictions}`);

		// evict-a was the first inserted and should have been evicted.
		// Re-accessing it should be a miss (re-read from disk).
		const missesBefore = stats.misses;
		renderSkillInstructions({ cwd, role: "unknown", override: ["evict-a"] });
		const afterReaccess = getSkillCacheStats();
		assert.ok(afterReaccess.misses > missesBefore, "evicted entry should miss on re-access");
	} finally {
		_setSkillCacheMaxEntriesForTesting(128);
		clearSkillInstructionCache();
		resetSkillCacheStats();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("skill cache invalidation increments misses when file mtime changes", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-skill-inval-"));
	try {
		clearSkillInstructionCache();
		resetSkillCacheStats();

		writeProjectSkill(cwd, "invalidate-me", "# V1\n\noriginal content");

		// First read: cold miss
		const r1 = renderSkillInstructions({ cwd, role: "unknown", override: ["invalidate-me"] });
		assert.match(r1.block, /original content/);
		const stats1 = getSkillCacheStats();
		assert.equal(stats1.misses, 1);
		assert.equal(stats1.hits, 0);

		// Second read: cache hit
		renderSkillInstructions({ cwd, role: "unknown", override: ["invalidate-me"] });
		const stats2 = getSkillCacheStats();
		assert.equal(stats2.hits, 1, "second read should be a cache hit");
		assert.equal(stats2.misses, 1, "no new misses on cached read");

		// Modify the file (update mtime + size + content)
		writeProjectSkill(cwd, "invalidate-me", "# V2\n\nupdated content that is longer");
		// Ensure mtime advances (some filesystems have coarse mtime granularity)
		const skillFile = path.join(cwd, "skills", "invalidate-me", "SKILL.md");
		const future = new Date(Date.now() + 2000);
		fs.utimesSync(skillFile, future, future);

		// Third read: should detect stale entry and re-read (miss)
		const r3 = renderSkillInstructions({ cwd, role: "unknown", override: ["invalidate-me"] });
		assert.match(r3.block, /updated content/);
		assert.doesNotMatch(r3.block, /original content/);
		const stats3 = getSkillCacheStats();
		assert.equal(stats3.misses, 2, "stale entry should produce a new miss");
		assert.equal(stats3.hits, 1, "hit count unchanged after invalidation");

		// Fourth read: new entry cached, should hit
		renderSkillInstructions({ cwd, role: "unknown", override: ["invalidate-me"] });
		const stats4 = getSkillCacheStats();
		assert.equal(stats4.hits, 2, "re-cached entry should hit on subsequent read");
	} finally {
		clearSkillInstructionCache();
		resetSkillCacheStats();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("getSkillCacheStats returns hitRate field", () => {
	clearSkillInstructionCache();
	resetSkillCacheStats();

	// No lookups → hitRate = 0
	const s0 = getSkillCacheStats();
	assert.equal(s0.hitRate, 0);

	// 1 miss → hitRate = 0
	renderSkillInstructions({ cwd: process.cwd(), role: "verifier", teamRole: { skills: false }, override: ["verification-before-done"] });
	const s1 = getSkillCacheStats();
	assert.equal(s1.hitRate, 0);

	// 1 hit + 1 miss → hitRate = 0.5
	renderSkillInstructions({ cwd: process.cwd(), role: "verifier", teamRole: { skills: false }, override: ["verification-before-done"] });
	const s2 = getSkillCacheStats();
	assert.ok(Math.abs(s2.hitRate - 0.5) < 0.001, `expected hitRate 0.5, got ${s2.hitRate}`);

	clearSkillInstructionCache();
	resetSkillCacheStats();
});
