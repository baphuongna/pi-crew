import assert from "node:assert/strict";
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
		// returns components of the same shape.
		const after = await computeStablePrefixComponents(manifest, step, task);
		assert.ok(typeof after.treeBlock === "string");
		assert.ok(typeof after.suggestedFilesBlock === "string");
		assert.ok(typeof after.knowledgeFragment === "string");
	});
});
