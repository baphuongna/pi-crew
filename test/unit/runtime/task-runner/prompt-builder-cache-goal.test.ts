/**
 * prompt-builder-cache-goal.test.ts — BR-06 regression (RED-first).
 *
 * BUG (docs/archive/2026-09-18-backlog-bottlenecks-review.md BR-06):
 * `stableIOCacheKey(cwd, stepTask)` keyed the cross-run I/O cache (P9,
 * 60s TTL) on the UNSUBSTITUTED `step.task` template only — but the cached
 * computation is goal-scored:
 *   - `runRetrievalCycle(step.task, manifest.goal, task.cwd)` → suggested files
 *   - `buildKnowledgeFragment(task.cwd, { goal, taskText, role })` → knowledge
 * So two runs in the same cwd that share the step template but have DIFFERENT
 * goals shared ONE cache entry: run B got run A's suggested-files + knowledge
 * fragment. Reachable in-process — the goal-loop runner calls executeTeamRun
 * once per turn with a different goal and the same step template, and chain
 * steps reuse step templates across runs.
 *
 * FIX: the goal is part of the cross-run key (and of the per-run fast path's
 * identity, since a miss there falls through to the io key).
 *
 * The fixture is deliberately goal-obvious on BOTH halves:
 *   - `.crew/knowledge.md` carries two session-log sections whose headers
 *     match goal A ("alpha widget") and goal B ("beta gadget") respectively,
 *     each with a unique body marker (knowledge fragment is goal-scored);
 *   - the cwd carries `alpha-widget-handler.ts` / `beta-gadget-handler.ts`,
 *     whose PATHS match goal A / goal B keywords (retrieval is goal-scored).
 * Both runs use the SAME step template on purpose — that identity is what
 * triggered the bug.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { clearStablePrefixCache, computeStablePrefixComponents } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/** The SAME unsubstituted step template for both runs (the bug's trigger). */
const SHARED_STEP: WorkflowStep = {
	id: "01",
	role: "executor",
	task: "Investigate the reported defect and report the findings back",
};

const GOAL_ALPHA = "alpha widget repro";
const GOAL_BETA = "beta gadget repro";

function knowledgeMarkdown(version: 1 | 2): string {
	const suffix = version === 2 ? "-rewritten-with-a-clearly-different-size" : "";
	return [
		"## Code Style",
		"- Use TABS for indentation (not spaces).",
		"",
		"## Alpha widget subsystem",
		`alpha-body-marker${suffix}`,
		"",
		"## Beta gadget subsystem",
		`beta-body-marker${suffix}`,
		"",
	].join("\n");
}

function makeManifest(tmpDir: string, runId: string, goal: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId,
		team: "test-team",
		workflow: "test-wf",
		goal,
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: tmpDir,
		stateRoot: tmpDir,
		artifactsRoot: tmpDir,
		tasksPath: path.join(tmpDir, "tasks.json"),
		eventsPath: path.join(tmpDir, "events.jsonl"),
		artifacts: [],
	} as TeamRunManifest;
}

function makeTask(tmpDir: string, runId: string): TeamTaskState {
	return {
		id: "01_exec",
		runId,
		stepId: "01",
		role: "executor",
		agent: "executor",
		title: "Investigate the reported defect",
		status: "running",
		dependsOn: [],
		cwd: tmpDir,
	};
}

/** Temp project: .crew/knowledge.md (2 goal-tagged sections) + 1 file per goal. */
function makeProject(prefix: string): string {
	const dir = createTrackedTempDir(prefix);
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".crew", "knowledge.md"), knowledgeMarkdown(1), "utf8");
	fs.writeFileSync(path.join(dir, "alpha-widget-handler.ts"), "// alpha widget handler\n", "utf8");
	fs.writeFileSync(path.join(dir, "beta-gadget-handler.ts"), "// beta gadget handler\n", "utf8");
	return dir;
}

describe("BR-06: cross-run stable-prefix I/O cache is goal-scoped", () => {
	beforeEach(() => clearStablePrefixCache());
	afterEach(() => clearStablePrefixCache());

	it("two runs with the SAME step template but DIFFERENT goals do not share cached retrieval/knowledge", async () => {
		const dir = makeProject("pi-crew-pbcache-goal-");
		try {
			const alpha = await computeStablePrefixComponents(
				makeManifest(dir, "run-goal-alpha", GOAL_ALPHA),
				SHARED_STEP,
				makeTask(dir, "run-goal-alpha"),
			);
			// Sanity: goal A's own compute carries goal A's context (not the bug).
			assert.match(alpha.knowledgeFragment, /alpha-body-marker/, "goal A must inject its own knowledge section");
			assert.ok(!alpha.knowledgeFragment.includes("beta-body-marker"), "goal A must not inject goal B's knowledge");
			assert.match(alpha.suggestedFilesBlock, /alpha-widget-handler\.ts/, "goal A must suggest its own file");

			// Run B: different runId (⇒ per-run fast path misses) + different goal,
			// same cwd, same step template, well within the 60s TTL.
			const beta = await computeStablePrefixComponents(
				makeManifest(dir, "run-goal-beta", GOAL_BETA),
				SHARED_STEP,
				makeTask(dir, "run-goal-beta"),
			);
			// RED pre-fix: run B receives run A's components (goal-blind io key).
			assert.match(beta.knowledgeFragment, /beta-body-marker/, "run B must inject ITS goal's knowledge section");
			assert.ok(
				!beta.knowledgeFragment.includes("alpha-body-marker"),
				"run B must NOT reuse run A's knowledge fragment (BR-06: goal missing from the io cache key)",
			);
			assert.match(beta.suggestedFilesBlock, /beta-gadget-handler\.ts/, "run B must suggest ITS goal's files");
			assert.ok(
				!beta.suggestedFilesBlock.includes("alpha-widget-handler.ts"),
				"run B must NOT reuse run A's suggested files (BR-06: goal missing from the io cache key)",
			);
			assert.notEqual(beta.knowledgeFragment, alpha.knowledgeFragment, "the two goals' fragments must differ");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("the goal-scoped cache still serves cross-run hits (perf win preserved by the fix)", async () => {
		const dir = makeProject("pi-crew-pbcache-hit-");
		try {
			const first = await computeStablePrefixComponents(
				makeManifest(dir, "run-hit-1", GOAL_ALPHA),
				SHARED_STEP,
				makeTask(dir, "run-hit-1"),
			);
			assert.match(first.knowledgeFragment, /alpha-body-marker/);

			// Mutate the inputs: a fresh compute would pick the rewritten marker up.
			await new Promise((r) => setTimeout(r, 5));
			fs.writeFileSync(path.join(dir, ".crew", "knowledge.md"), knowledgeMarkdown(2), "utf8");

			// NEW runId ⇒ per-run fast path misses ⇒ the cross-run (io) cache is the
			// only way this can return the pre-rewrite fragment.
			const second = await computeStablePrefixComponents(
				makeManifest(dir, "run-hit-2", GOAL_ALPHA),
				SHARED_STEP,
				makeTask(dir, "run-hit-2"),
			);
			assert.match(second.knowledgeFragment, /alpha-body-marker/, "same-goal cross-run read still hits the TTL cache");
			assert.ok(
				!second.knowledgeFragment.includes("-rewritten-with-a-clearly-different-size"),
				"cross-run cache hit must return the cached fragment (goal-scoped key is a cache HIT for the same goal)",
			);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("clearStablePrefixCache still drops the goal-scoped cross-run entries", async () => {
		const dir = makeProject("pi-crew-pbcache-clear-");
		try {
			await computeStablePrefixComponents(makeManifest(dir, "run-c1", GOAL_ALPHA), SHARED_STEP, makeTask(dir, "run-c1"));
			clearStablePrefixCache();
			const afterClear = await computeStablePrefixComponents(
				makeManifest(dir, "run-c2", GOAL_ALPHA),
				SHARED_STEP,
				makeTask(dir, "run-c2"),
			);
			assert.match(afterClear.knowledgeFragment, /alpha-body-marker/, "post-clear compute still resolves goal A correctly");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
