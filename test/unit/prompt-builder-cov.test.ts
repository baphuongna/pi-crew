import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import {
	clearStablePrefixCache,
	computeStablePrefixComponents,
	coordinationBridgeInstructions,
	renderOutputSchemaBlock,
	renderTaskPrompt,
	toolGuidanceBlock,
} from "../../src/runtime/task-runner/prompt-builder.ts";
import type { TaskOutputSchema, TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { WorkflowStep } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

/** Helper to create a partial AgentConfig for toolGuidanceBlock tests. */
function partialAgentConfig(fields: Partial<AgentConfig>): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: { type: "inline" },
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

/** Helper to create a minimal TeamRunManifest. */
function makeManifest(tmpDir: string, overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run_test",
		team: "test-team",
		workflow: "test-wf",
		goal: "Test the prompt builder",
		stateRoot: tmpDir,
		artifactsRoot: tmpDir,
		eventsPath: `${tmpDir}/events.jsonl`,
		tasksPath: `${tmpDir}/tasks.json`,
		cwd: tmpDir,
		workspaceMode: "single",
		status: "running",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		...overrides,
	} as TeamRunManifest;
}

/** Helper to create a minimal TeamTaskState. */
function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "01_test",
		runId: "run_test",
		role: "executor",
		agent: "test-agent",
		title: "Test task",
		status: "running",
		dependsOn: [],
		cwd: ".",
		...overrides,
	} as TeamTaskState;
}

// ── toolGuidanceBlock ───────────────────────────────────────────────────

describe("toolGuidanceBlock", () => {
	it("returns empty string when agent is undefined", () => {
		assert.strictEqual(toolGuidanceBlock(undefined), "");
	});

	it("returns empty string when loadMode is not lean", () => {
		const agent = partialAgentConfig({
			loadMode: "essential",
			defaultTools: ["bash", "read"],
		});
		assert.strictEqual(toolGuidanceBlock(agent), "");
	});

	it("returns empty string when defaultTools is empty", () => {
		const agent = partialAgentConfig({
			loadMode: "lean",
			defaultTools: [],
		});
		assert.strictEqual(toolGuidanceBlock(agent), "");
	});

	it("returns guidance block for lean mode with tools", () => {
		const agent = partialAgentConfig({
			loadMode: "lean",
			defaultTools: ["bash", "read"],
		});
		const result = toolGuidanceBlock(agent);
		assert.ok(result.includes("Tool Guidance"));
		assert.ok(result.includes("bash, read"));
	});
});

// ── coordinationBridgeInstructions ──────────────────────────────────────

describe("coordinationBridgeInstructions", () => {
	it("includes task ID in output", () => {
		const task = makeTask({ id: "01_agent" });
		const result = coordinationBridgeInstructions(task);
		assert.ok(result.includes("01_agent"));
		assert.ok(result.includes("Crew Coordination Channel"));
	});

	it("includes mailbox instructions", () => {
		const task = makeTask({ id: "02_build" });
		const result = coordinationBridgeInstructions(task);
		assert.ok(result.includes("Mailbox target"));
		assert.ok(result.includes("blocked or uncertain"));
	});

	it("includes handoff guidance", () => {
		const task = makeTask({ id: "03_test" });
		const result = coordinationBridgeInstructions(task);
		assert.ok(result.includes("DONE/FAILED"));
	});

	it("includes the never-guess ask guidance (workers must prefer ask over silent assumptions)", () => {
		const task = makeTask({ id: "04_verify" });
		const result = coordinationBridgeInstructions(task);
		assert.ok(result.includes("Never guess implementation details"), "ask guidance line must be present");
		assert.ok(result.includes("`ask` tool"), "must name the ask tool explicitly");
	});
});

// ── renderOutputSchemaBlock ─────────────────────────────────────────────

describe("renderOutputSchemaBlock", () => {
	it("renders basic format description", () => {
		const schema: TaskOutputSchema = { format: "text" };
		const result = renderOutputSchemaBlock(schema);
		assert.ok(result.includes("text"));
		assert.ok(result.includes("Expected Output Format"));
	});

	it("includes description when provided", () => {
		const schema: TaskOutputSchema = {
			format: "text",
			description: "A summary of changes",
		};
		const result = renderOutputSchemaBlock(schema);
		assert.ok(result.includes("A summary of changes"));
	});

	it("includes JSON schema when format is json", () => {
		const schema: TaskOutputSchema = {
			format: "json",
			schema: {
				type: "object",
				properties: { name: { type: "string" } },
			},
		};
		const result = renderOutputSchemaBlock(schema);
		assert.ok(result.includes("```json"));
		assert.ok(result.includes('"type": "object"'));
	});

	it("includes example when provided", () => {
		const schema: TaskOutputSchema = {
			format: "text",
			example: "Hello world output",
		};
		const result = renderOutputSchemaBlock(schema);
		assert.ok(result.includes("Hello world output"));
		assert.ok(result.includes("Example output"));
	});

	it("renders without optional fields", () => {
		const schema: TaskOutputSchema = { format: "markdown" };
		const result = renderOutputSchemaBlock(schema);
		assert.ok(result.includes("markdown"));
		assert.ok(!result.includes("```json"));
		assert.ok(!result.includes("Example output"));
	});
});

// ── renderTaskPrompt ────────────────────────────────────────────────────

describe("renderTaskPrompt", () => {
	it("ARCH-3: siblings sharing a step produce a byte-identical stablePrefix", async () => {
		const tmpDir = createTrackedTempDir("pi-crew-pb-byteid-");
		try {
			const manifest = makeManifest(tmpDir);
			const step: WorkflowStep = {
				id: "01",
				role: "executor",
				task: "Write a test for {goal}",
			};
			const taskA = makeTask({ id: "01_exec-a", cwd: tmpDir });
			const taskB = makeTask({ id: "01_exec-b", cwd: tmpDir });

			const resultA = await renderTaskPrompt(manifest, step, taskA);
			const resultB = await renderTaskPrompt(manifest, step, taskB);

			assert.strictEqual(
				resultA.stablePrefix,
				resultB.stablePrefix,
				"stablePrefix must be byte-identical for siblings sharing run+role (KV-cache hit)",
			);
			// Per-task identity moved to the dynamic suffix
			assert.ok(!resultA.stablePrefix.includes(taskA.id), "stablePrefix must not embed task id");
			assert.ok(resultA.dynamicSuffix.includes(`Task ID: ${taskA.id}`), "dynamicSuffix carries task id");
			assert.ok(resultA.dynamicSuffix.includes(`Mailbox target: ${taskA.id}`), "dynamicSuffix carries mailbox target");
			assert.ok(resultB.dynamicSuffix.includes(`Task ID: ${taskB.id}`), "sibling dynamicSuffix carries its own task id");
			assert.notStrictEqual(resultA.dynamicSuffix, resultB.dynamicSuffix, "dynamicSuffix differs per task");
		} finally {
			removeTrackedTempDir(tmpDir);
		}
	});

	it("renders with minimal manifest and task", async () => {
		const tmpDir = createTrackedTempDir("pi-crew-pb-");

		const manifest = makeManifest(tmpDir);
		const task = makeTask({ cwd: tmpDir });
		const step: WorkflowStep = {
			id: "01",
			role: "executor",
			task: "Write a test for {goal}",
		};

		const result = await renderTaskPrompt(manifest, step, task);

		assert.ok(result.full.includes("run_test"), "full prompt includes run ID");
		assert.ok(result.full.includes("Test the prompt builder"), "full prompt includes goal");
		assert.ok(result.full.includes("executor"), "full prompt includes role");
		assert.ok(result.stablePrefix.includes("pi-crew Worker Runtime Context"), "stable prefix includes header");
		assert.ok(result.dynamicSuffix.includes("Write a test for"), "dynamic suffix includes task");
		assert.ok(result.dynamicSuffix.includes("Test the prompt builder"), "dynamic suffix includes goal substitution");

		removeTrackedTempDir(tmpDir);
	});

	it("includes read-only role instructions for read-only roles", async () => {
		const tmpDir = createTrackedTempDir("pi-crew-pb-");

		const manifest = makeManifest(tmpDir, {
			runId: "run_ro",
			goal: "Explore codebase",
		});
		const task = makeTask({
			id: "02_explore",
			role: "explorer",
			cwd: tmpDir,
		});
		const step: WorkflowStep = {
			id: "02",
			role: "explorer",
			task: "Explore the codebase",
		};

		const result = await renderTaskPrompt(manifest, step, task);
		assert.ok(result.stablePrefix.includes("READ-ONLY ROLE CONTRACT"), "includes read-only instructions for explorer");

		removeTrackedTempDir(tmpDir);
	});

	it("includes workspace mode in prompt", async () => {
		const tmpDir = createTrackedTempDir("pi-crew-pb-");

		const manifest = makeManifest(tmpDir, {
			runId: "run_ws",
			goal: "Test workspace mode",
			workspaceMode: "worktree",
		});
		const task = makeTask({ id: "03_ws", cwd: tmpDir });
		const step: WorkflowStep = {
			id: "03",
			role: "executor",
			task: "Do the work",
		};

		const result = await renderTaskPrompt(manifest, step, task);
		assert.ok(result.stablePrefix.includes("worktree"), "includes workspace mode");

		removeTrackedTempDir(tmpDir);
	});
});

// P9 (perf): cross-run stable prefix cache. Verify that sequential computes
// with the same (cwd, step.task) but DIFFERENT runId share the I/O-heavy
// sub-results when within STABLE_IO_TTL_MS, and that clearStablePrefixCache
// drops both layers of the cache.
describe("computeStablePrefixComponents — P9 cross-run cache", () => {
	beforeEach(() => clearStablePrefixCache());
	afterEach(() => clearStablePrefixCache());

	it("populates the per-run cache and short-circuits within the run", async () => {
		const cwd = process.cwd();
		const step = { id: "step-A", task: "explore the codebase", role: "explorer" } as Parameters<
			typeof computeStablePrefixComponents
		>[1];
		const manifest = {
			runId: "run-A",
			goal: "find the bug",
		} as unknown as Parameters<typeof computeStablePrefixComponents>[0];
		const task = { cwd } as unknown as Parameters<typeof computeStablePrefixComponents>[2];

		const a = await computeStablePrefixComponents(manifest, step, task);
		const b = await computeStablePrefixComponents(manifest, step, task);
		assert.deepEqual(b, a, "second call within run returns identical components");
	});

	it("clearStablePrefixCache invalidates the per-run cache (forces re-compute)", async () => {
		const cwd = process.cwd();
		const step = { id: "step-B", task: "unique-task-per-test-1", role: "explorer" } as Parameters<
			typeof computeStablePrefixComponents
		>[1];
		const manifest = {
			runId: "run-B",
			goal: "find the bug",
		} as unknown as Parameters<typeof computeStablePrefixComponents>[0];
		const task = { cwd } as unknown as Parameters<typeof computeStablePrefixComponents>[2];

		await computeStablePrefixComponents(manifest, step, task);
		clearStablePrefixCache();
		// After clear, the cache lookup misses and the cross-run cache is also dropped;
		// we cannot intercept the FS calls easily but we can verify the function still
		// returns components of the same shape. (R2 adaptive-04: treeBlock left the
		// stable components — the tree is per-task now; see prompt-tree-scope.test.ts.)
		const after = await computeStablePrefixComponents(manifest, step, task);
		assert.ok(typeof after.suggestedFilesBlock === "string");
		assert.ok(typeof after.knowledgeFragment === "string");
		// R2.2: the cache-miss recompute must also (re)build the paths array.
		assert.ok(Array.isArray(after.suggestedFiles), "post-clear recompute re-derives suggestedFiles");
	});
});

// R2.2 (adaptive-03): retrieval file paths ride the StableComponents/
// CachedStableIO plumbing so the task-tree scoping can reuse them without a
// second retrieval pass. A cache-hit reconstruction that drops the paths
// would silently de-scope every cached read back to the whole workspace —
// these pin BOTH cache sites (per-run fast path + cross-run io path).
describe("computeStablePrefixComponents — R2.2 retrieval paths through caches", () => {
	beforeEach(() => clearStablePrefixCache());
	afterEach(() => clearStablePrefixCache());

	it("fresh compute exposes the retrieval paths (relative to cwd) alongside the rendered block", async () => {
		// Goal-keyword fixture (prompt-builder-cache-goal.test.ts pattern): the
		// only path matching the goal keywords is the alpha handler file.
		const dir = createTrackedTempDir("pi-crew-r22-fresh-");
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".crew", "knowledge.md"), "## Code Style\n- Use TABS.\n", "utf8");
		fs.writeFileSync(path.join(dir, "alpha-widget-handler.ts"), "// alpha\n", "utf8");
		try {
			const manifest = makeManifest(dir, { runId: "run-r22-fresh", goal: "alpha widget repro" });
			const step: WorkflowStep = { id: "01", role: "executor", task: "Investigate the reported defect and report the findings back" };
			const task = makeTask({ cwd: dir });

			const a = await computeStablePrefixComponents(manifest, step, task);
			assert.ok(Array.isArray(a.suggestedFiles), "suggestedFiles is an array");
			assert.ok(
				a.suggestedFiles.includes("alpha-widget-handler.ts"),
				`retrieval paths must include the goal-matched file (got ${JSON.stringify(a.suggestedFiles)})`,
			);
			assert.ok(
				a.suggestedFiles.every((p) => !path.isAbsolute(p)),
				"paths are relative to the task cwd",
			);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("cross-run cache-hit reconstruction (second call within TTL) returns the paths too", async () => {
		const dir = createTrackedTempDir("pi-crew-r22-cache-");
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".crew", "knowledge.md"), "## Alpha widget subsystem\nalpha-body-marker\n", "utf8");
		fs.writeFileSync(path.join(dir, "alpha-widget-handler.ts"), "// alpha\n", "utf8");
		try {
			const step: WorkflowStep = { id: "01", role: "executor", task: "Investigate the reported defect and report the findings back" };
			const first = await computeStablePrefixComponents(
				makeManifest(dir, { runId: "run-r22-a", goal: "alpha widget repro" }),
				step,
				makeTask({ cwd: dir, runId: "run-r22-a" }),
			);
			assert.ok(first.suggestedFiles.includes("alpha-widget-handler.ts"), "sanity: fresh compute captured the paths");

			// Rewrite knowledge.md with a marker only a FRESH compute would see —
			// used below to prove the second call really was a cache hit.
			await new Promise((r) => setTimeout(r, 5));
			fs.writeFileSync(path.join(dir, ".crew", "knowledge.md"), "## Alpha widget subsystem\nalpha-body-marker-REWRITTEN\n", "utf8");

			// Different runId ⇒ per-run fast path misses ⇒ the cross-run (io)
			// cache is the only hit path. Same cwd/step/goal ⇒ same io key.
			const second = await computeStablePrefixComponents(
				makeManifest(dir, { runId: "run-r22-b", goal: "alpha widget repro" }),
				step,
				makeTask({ cwd: dir, runId: "run-r22-b" }),
			);
			assert.ok(
				!second.knowledgeFragment.includes("REWRITTEN"),
				"sanity: the second call really hit the cross-run cache (pre-rewrite fragment returned)",
			);
			assert.ok(
				Array.isArray(second.suggestedFiles) && second.suggestedFiles.includes("alpha-widget-handler.ts"),
				"cache-hit reconstruction must carry the retrieval paths (R2.2)",
			);
			assert.deepEqual(second.suggestedFiles, first.suggestedFiles, "cached paths are identical to the fresh compute's");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
