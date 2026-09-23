import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSkillInstructions } from "../../../../src/runtime/skill-instructions.ts";
import {
	estimateTokens,
	promptBreakdownEnabled,
	promptSkillMode,
	renderTaskPrompt,
} from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

/**
 * SR-02 (2026-09-23): worker prompt diet.
 *
 * Measured baseline (fast-fix, scratch project): skills were 41-51% of worker
 * prompts; explorer additionally paid twice for read-only instructions (the
 * scaffold's READ-ONLY ROLE CONTRACT duplicates the read-only-explorer skill).
 * Cuts: (1) skills inject compact index entries (name + description + Path +
 * read-on-demand instruction) instead of full bodies; (2) the scaffold
 * read-only block is dropped when the read-only-explorer skill is selected.
 * Escape hatch: PI_CREW_PROMPT_SKILLS=full restores the old behaviour.
 *
 * Mutation: default the mode back to "full" → the index-mode tests go RED.
 */

const envBackup = new Map<string, string | undefined>();
test.beforeEach(() => {
	envBackup.clear();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
	delete process.env.PI_CREW_PROMPT_SKILLS;
	delete process.env.PI_CREW_PROMPT_BREAKDOWN;
});
test.afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!envBackup.has(key)) delete process.env[key];
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("SR-02: default mode is index — entries carry name/description/source/path + read instruction, NOT the body", () => {
	assert.equal(promptSkillMode(), "index");
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		override: ["verification-before-done"],
	});
	assert.match(rendered.block, /# Applicable Skills/);
	assert.match(rendered.block, /## verification-before-done/);
	assert.match(rendered.block, /Source: (project|package):skills\/verification-before-done/);
	assert.match(rendered.block, /Path: .+skills[\\/]verification-before-done/);
	assert.match(rendered.block, /FIRST read .+SKILL\.md and follow it/);
	// The BODY must not be inlined (that is the whole point).
	assert.ok(!rendered.block.includes("<!-- skill: verification-before-done -->"));
	// And the block is dramatically smaller than the full body it replaced.
	assert.ok(rendered.block.length < 1600, `index block should be compact, got ${rendered.block.length}`);
});

test("SR-02 AC-4: PI_CREW_PROMPT_SKILLS=full restores complete inline bodies (rollback path)", () => {
	process.env.PI_CREW_PROMPT_SKILLS = "full";
	assert.equal(promptSkillMode(), "full");
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "verifier",
		override: ["verification-before-done"],
	});
	assert.ok(rendered.block.includes("<!-- skill: verification-before-done -->"), "full bodies inlined again");
	assert.ok(rendered.block.length > 2000, "full mode is materially larger than the index entry");
});

test("SR-02: index entries stay within the per-skill budget even for giant skills", () => {
	const rendered = renderSkillInstructions({
		cwd: process.cwd(),
		role: "executor", // safe-bash is the largest package skill (~8.6k chars)
	});
	assert.match(rendered.block, /## safe-bash/);
	assert.ok(!rendered.block.includes("<!-- skill: safe-bash -->"));
	assert.ok(rendered.block.length < 6000, `whole index block respects the budget, got ${rendered.block.length}`);
});

const PINNED = new Date("2026-09-23T09:00:00.000Z");

function fixture(role: string): { manifest: TeamRunManifest; step: WorkflowStep; task: TeamTaskState } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sr02-"));
	const stateRoot = path.join(cwd, ".crew", "state", "runs", "team_sr02_diet");
	const manifest = {
		runId: "team_sr02_diet",
		schemaVersion: 1,
		status: "running",
		stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifactsRoot: path.join(cwd, ".crew", "artifacts", "team_sr02_diet"),
		team: "fast-fix",
		workflow: "fast-fix",
		goal: "fix the flaky test",
		cwd,
		workspaceMode: "single",
		createdAt: PINNED.toISOString(),
	} as unknown as TeamRunManifest;
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.writeFileSync(manifest.eventsPath, "");
	const step: WorkflowStep = { id: "explore", role, task: "Find the bug in {goal}" };
	const task = {
		id: "01_explore",
		role,
		agent: "explorer",
		status: "running",
		dependsOn: [],
		cwd,
	} as unknown as TeamTaskState;
	return { manifest, step, task };
}

test("SR-02 de-dup: read-only-explorer selected → scaffold READ-ONLY ROLE CONTRACT is dropped", async () => {
	const { manifest, step, task } = fixture("explorer");
	const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, ["read-only-explorer"]);
	assert.ok(!rendered.full.includes("# READ-ONLY ROLE CONTRACT"), "skill supersedes the scaffold duplicate");
});

test("SR-02 de-dup: read-only role WITHOUT the skill keeps the scaffold contract", async () => {
	const { manifest, step, task } = fixture("custom-auditor");
	const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
	// custom-auditor không nằm trong bảng read-only mặc định? permissionForRole quyết định;
	// lấy role chắc chắn read-only: "reviewer"
	const rendered2 = await renderTaskPrompt(
		manifest,
		{ ...step, role: "reviewer" },
		{ ...task, role: "reviewer" },
		undefined,
		"",
		undefined,
		[],
	);
	assert.ok(rendered2.full.includes("# READ-ONLY ROLE CONTRACT"), "no skill → scaffold contract stays");
});

test("SR-02 phase 1: PI_CREW_PROMPT_BREAKDOWN=1 populates per-section char counts", async () => {
	assert.equal(promptBreakdownEnabled(), false);
	process.env.PI_CREW_PROMPT_BREAKDOWN = "1";
	assert.equal(promptBreakdownEnabled(), true);
	const { manifest, step, task } = fixture("explorer");
	const rendered = await renderTaskPrompt(manifest, step, task, undefined, "skill-block-chars", undefined, []);
	assert.ok(rendered.sections, "sections object present when enabled");
	assert.equal(rendered.sections!["dynamic.skills"], "skill-block-chars".length);
	assert.equal(rendered.sections!["total.userPrompt"], rendered.full.length);
	// sums are consistent: stable + dynamic ≈ total (minus join separators)
	const stableSum = Object.entries(rendered.sections!)
		.filter(([k]) => k.startsWith("stable."))
		.reduce((a, [, v]) => a + v, 0);
	const dynamicSum = Object.entries(rendered.sections!)
		.filter(([k]) => k.startsWith("dynamic."))
		.reduce((a, [, v]) => a + v, 0);
	assert.ok(stableSum + dynamicSum <= rendered.full.length, "section sums must not exceed the whole");
	// estTokens heuristic sanity
	assert.equal(estimateTokens(400), 100);
});

test("SR-02 phase 1: breakdown off by default — no sections object, no cost", async () => {
	const { manifest, step, task } = fixture("explorer");
	const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
	assert.equal(rendered.sections, undefined);
});
