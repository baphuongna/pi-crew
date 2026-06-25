import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

/**
 * FIX 4 E2E — exercise the full model-fallback chain end to end.
 *
 * Setup:
 *   - Use a direct-agent run (single task) so the global mock counter
 *     maps 1:1 to attempts on that task.
 *   - Inject a model registry with 2 models so buildConfiguredModelRouting
 *     produces exactly 2 candidates (the registry fallback chain — agent
 *     frontmatter has no explicit `model`/`fallbackModels`).
 *   - Force `model: "x"` (non-existent in any registry) — gets filtered
 *     out by isAvailableModel, leaving the registry candidates.
 *   - Mock = `retryable-failure-then-success`: invocation #1 returns a
 *     silent retryable failure (exit 0, message_end with errorMessage
 *     matching `/provider[_ ]?error/i`, no real text); invocation #2+
 *     returns the standard json-success transcript.
 *
 * Expected outcome:
 *   - attempt #1 fails with retryable-pattern error → task-runner pushes
 *     failed ModelAttemptState and routes to candidate #2.
 *   - attempt #2 succeeds → task completes.
 *   - modelAttempts.length === 2 with [0].success === false, [1].success
 *     === true.
 */
test("model-fallback chain routes retryable failure to next candidate and succeeds", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fallback-chain-e2e-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const previousCrewRole = process.env.PI_CREW_ROLE;
	const previousTeamsRole = process.env.PI_TEAMS_ROLE;
	// Clean up any stale counter file from a previous interrupted run so
	// the assertion below is deterministic.
	const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
	try { fs.unlinkSync(counterFile); } catch { /* fine if missing */ }
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "retryable-failure-then-success";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	try {
		// 2-model registry → buildConfiguredModelRouting produces 2 candidates
		// once the bogus "x" model is filtered out by isAvailableModel.
		const modelRegistry = {
			getAvailable: () => [
				{ provider: "openai-codex", id: "gpt-5.5" },
				{ provider: "openai-codex", id: "gpt-5-mini" },
			],
		};
		const run = await handleTeamTool(
			{
				action: "run",
				agent: "explorer",
				role: "executor",
				goal: "Fallback chain E2E",
				model: "x",
			},
			{ cwd, modelRegistry } as never,
		);
		assert.equal(run.isError, false, `run returned error: ${typeof run.content?.[0] === "object" && run.content?.[0] && "text" in run.content[0] ? (run.content[0] as { text?: string }).text ?? "<no text>" : "<no text>"}`);
		const runId = run.details.runId;
		assert.ok(runId, "run must have a runId");
		const loaded = loadRunManifestById(cwd, runId!);
		assert.ok(loaded, "manifest must be loadable after run");
		// The single task should be completed (not failed/blocked) — the
		// fallback chain succeeded on attempt #2.
		assert.equal(loaded?.manifest.status, "completed", `manifest status: ${loaded?.manifest.status} summary=${loaded?.manifest.summary}`);
		assert.equal(loaded?.tasks.length, 1);
		const task = loaded!.tasks[0]!;
		assert.equal(task.status, "completed", `task status: ${task.status} error=${task.error}`);
		// Core invariant: exactly 2 attempts recorded (fail then succeed).
		assert.ok(task.modelAttempts, "task must have modelAttempts");
		assert.equal(task.modelAttempts!.length, 2, `expected 2 attempts, got ${task.modelAttempts!.length}: ${JSON.stringify(task.modelAttempts)}`);
		const [first, second] = task.modelAttempts!;
		assert.equal(first.success, false, "first attempt must be a failure");
		assert.match(first.error ?? "", /provider[_ ]?error/i, `first attempt error must match retryable pattern: ${first.error}`);
		assert.equal(second.success, true, "second attempt must be a success");
		assert.ok(!second.error, `second attempt should have no error: ${second.error}`);
		// Sanity: the two attempts used DIFFERENT models (the fallback chain
		// actually rotated, not retried the same model).
		assert.notEqual(first.model, second.model, `fallback chain should rotate models, got same: ${first.model}`);
	} finally {
		try { fs.unlinkSync(counterFile); } catch { /* fine if already gone */ }
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		if (previousCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = previousCrewRole;
		if (previousTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = previousTeamsRole;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
