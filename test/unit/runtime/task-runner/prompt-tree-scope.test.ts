/**
 * R2 + R3 (adaptive-04, 2026-11-04): worker prompt context-injection diet.
 *
 * R2 — the workspace tree used to be an IDENTICAL whole-workspace walk inside
 * every sibling worker's stablePrefix (measured 26% of the 01_discover
 * artifact, ~0.9K est-tok/worker). It is now a subtree scoped around the
 * task's working files (step.reads), rendered at the END of the dynamic
 * suffix so the byte-stable shared prefix (ARCH-3) survives.
 *
 * R3 — the task body was embedded twice (packet JSON `objective` + the
 * `Task:` narrative tail); the JSON now carries a pointer and the narrative
 * is the single canonical body.
 *
 * Mutation guards: reverting R2 (tree back into stablePrefix / key renamed
 * back to "stable.workspaceTree") or R3 (objective re-embedded) turns these
 * RED.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { buildTaskPacket, renderTaskPacket } from "../../../../src/runtime/task-packet.ts";
import { clearStablePrefixCache, renderTaskPrompt } from "../../../../src/runtime/task-runner/prompt-builder.ts";
import type { TaskPacket, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

const PINNED = new Date("2026-11-04T12:00:00.000Z");

interface Fixture {
	manifest: TeamRunManifest;
	task: TeamTaskState;
	workspace: string;
}

/** Workspace: focused src/runtime subtree + far-away siblings to prove scoping. */
function makeFixture(reads?: string[] | false): Fixture {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "r2r3-prompt-"));
	fs.mkdirSync(path.join(workspace, "src", "runtime"), { recursive: true });
	fs.mkdirSync(path.join(workspace, "unrelated"), { recursive: true });
	fs.writeFileSync(path.join(workspace, "src", "runtime", "focus-file.ts"), "// focus\n", "utf8");
	fs.writeFileSync(path.join(workspace, "unrelated", "far-away.ts"), "// far\n", "utf8");
	fs.writeFileSync(path.join(workspace, "root-file.md"), "# root\n", "utf8");

	const stateRoot = path.join(workspace, ".crew", "state", "runs", "team_r2r3");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "", "utf8");

	const manifest = {
		runId: "team_r2r3",
		schemaVersion: 1,
		status: "running",
		stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifactsRoot: path.join(workspace, ".crew", "artifacts", "team_r2r3"),
		team: "test",
		workflow: "test",
		goal: "ship the prompt diet",
		cwd: workspace,
		workspaceMode: "single",
		createdAt: PINNED.toISOString(),
	} as unknown as TeamRunManifest;

	const task = {
		id: "01_exec",
		runId: manifest.runId,
		stepId: "01",
		role: "executor",
		agent: "executor",
		title: "Edit the focused file",
		status: "running",
		dependsOn: [],
		cwd: workspace,
	} as unknown as TeamTaskState;
	void reads; // reads live on the STEP (per-step signal), not the task
	return { manifest, task, workspace };
}

function makeStep(reads?: string[] | false): WorkflowStep {
	return {
		id: "01",
		role: "executor",
		task: "Edit the file for {goal} and report UniqueObjectiveMarkerXyz findings",
		...(reads ? { reads } : {}),
	};
}

test.beforeEach(() => clearStablePrefixCache());
test.afterEach(() => clearStablePrefixCache());

test("R2: task-scoped tree rides the END of dynamicSuffix, never the stablePrefix (ARCH-3)", async () => {
	const { manifest, task, workspace } = makeFixture();
	const step = makeStep(["src/runtime/focus-file.ts"]);
	try {
		const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);

		// Stable prefix must stay byte-stable across siblings: no tree inside.
		assert.ok(!rendered.stablePrefix.includes("# Workspace Structure"), "tree must not ride the stable prefix");

		// Tree is in the user message, pinned LAST (most task-variable block).
		assert.ok(rendered.dynamicSuffix.includes("# Workspace Structure"), "tree rides the dynamic suffix");
		const treeIndex = rendered.dynamicSuffix.lastIndexOf("# Workspace Structure");
		const handoffIndex = rendered.dynamicSuffix.indexOf("## Handoff");
		assert.ok(treeIndex > handoffIndex, "tree block must come after the handoff narrative (pinned last)");

		// Scoped header names the subtree so the worker keeps its orientation.
		assert.ok(rendered.dynamicSuffix.includes(`(subtree: src${path.sep}runtime)`), "header must name the subtree");
		// And the walk actually focused on the task's files.
		assert.ok(rendered.dynamicSuffix.includes("focus-file.ts"), "focused file is rendered");
		assert.ok(!rendered.dynamicSuffix.includes("far-away.ts"), "out-of-scope files are elided");
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("R2: step without reads keeps the legacy whole-workspace tree (no scope header)", async () => {
	const { manifest, task, workspace } = makeFixture();
	const step = makeStep();
	try {
		const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
		const treeLine = rendered.dynamicSuffix.split("\n").find((l) => l.startsWith("# Workspace Structure"));
		assert.ok(treeLine, "tree block present");
		assert.ok(!treeLine.includes("subtree"), "unscoped tree carries no subtree header");
		assert.ok(rendered.dynamicSuffix.includes("far-away.ts"), "unscoped walk covers the whole workspace");
		assert.ok(!rendered.stablePrefix.includes("# Workspace Structure"), "even the unscoped tree stays out of the shared prefix");
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("R2: breakdown key mapping stable.workspaceTree → dynamic.workspaceTree", async () => {
	const previous = process.env.PI_CREW_PROMPT_BREAKDOWN;
	process.env.PI_CREW_PROMPT_BREAKDOWN = "1";
	const { manifest, task, workspace } = makeFixture();
	const step = makeStep(["src/runtime/focus-file.ts"]);
	try {
		const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
		assert.ok(rendered.sections, "sections present when breakdown enabled");
		assert.ok((rendered.sections!["dynamic.workspaceTree"] ?? 0) > 0, "new dynamic.workspaceTree key is populated");
		assert.equal(rendered.sections!["stable.workspaceTree"], undefined, "pre-R2 key must be gone");
		assert.equal(rendered.sections!["total.userPrompt"], rendered.dynamicSuffix.length, "tree counts toward the user message now");
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_PROMPT_BREAKDOWN;
		else process.env.PI_CREW_PROMPT_BREAKDOWN = previous;
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("R3: single canonical task body — packet JSON points at the narrative instead of re-embedding it", async () => {
	const { manifest, task, workspace } = makeFixture();
	const step = makeStep(["src/runtime/focus-file.ts"]);
	task.taskPacket = buildTaskPacket({ manifest, step, taskId: task.id, cwd: workspace });
	try {
		const rendered = await renderTaskPrompt(manifest, step, task, undefined, "", undefined, []);
		assert.ok(rendered.full.includes("```json"), "packet JSON block still present (contract fields stay)");

		// The JSON no longer re-embeds the body…
		const jsonStr = rendered.full.split("```json")[1]!.split("```")[0];
		const parsed = JSON.parse(jsonStr) as TaskPacket;
		assert.ok(parsed.objective.includes("'Task:'"), "objective is a pointer to the narrative");
		assert.ok(!parsed.objective.includes("UniqueObjectiveMarkerXyz"), "JSON must not re-embed the task body");

		// …so the body text appears exactly ONCE in the whole prompt (the narrative).
		const occurrences = rendered.full.split("UniqueObjectiveMarkerXyz").length - 1;
		assert.equal(occurrences, 1, `task body must be canonical (rendered once), got ${occurrences}`);
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("R3: renderTaskPacket default still embeds the objective (non-prompt contract unchanged)", () => {
	const packet = buildTaskPacket({
		manifest: {
			runId: "run-x",
			goal: "keep the contract",
			cwd: "/ws/repo",
		} as unknown as TeamRunManifest,
		step: { id: "s1", role: "executor", task: "Do the thing" },
		taskId: "t1",
		cwd: "/ws/repo",
	});
	const rendered = renderTaskPacket(packet);
	const parsed = JSON.parse(rendered.split("```json")[1]!.split("```")[0]) as TaskPacket;
	assert.equal(parsed.objective, "Do the thing", "default render keeps the real objective");
});
