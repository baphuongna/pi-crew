/**
 * U13 ACCEPTANCE (upgrade spec 2026-10-09 §U13): "một run verification với
 * gate xanh không spawn LLM verifier" — a verifier-role task whose
 * deterministic gate (typecheck / test:critical from the repo's package.json
 * scripts) is GREEN completes WITHOUT spawning the LLM verifier worker; a
 * RED gate still spawns the verifier WITH the gate results in its prompt.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "verifier", agent: "a" }],
} as const;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "verifier", task: "verify the build" }],
} as const;
const agent = {
	name: "a",
	description: "",
	source: "test",
	filePath: "a",
	systemPrompt: "test",
} as const;

function makeRepoDir(label: string, scripts: Record<string, string>): string {
	let cwd = createTrackedTempDir(label);
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "gate-repo", scripts }), "utf8");
	return cwd;
}

test("U13 acceptance: green gate → verifier task completes WITHOUT spawning the LLM verifier", async () => {
	const cwd = makeRepoDir("pi-crew-u13-green-", { typecheck: "node -e 0", "test:critical": "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-green" });
	const task = created.tasks[0]!;
	assert.equal(task.role, "verifier");
	const result = await runTeamTask({
		manifest: created.manifest,
		tasks: created.tasks,
		task,
		step: workflow.steps[0] as never,
		agent: agent as never,
		executeWorkers: true,
		workspaceId: "test-workspace",
	});
	const finished = result.tasks.find((t) => t.id === task.id)!;
	// NO LLM verifier spawned: zero model attempts, no worker artifacts.
	assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
	assert.ok(!finished.modelAttempts || finished.modelAttempts.length === 0, "no model attempts — verifier never spawned");
	assert.equal(finished.transcriptArtifact, undefined);
	assert.equal(finished.logArtifact, undefined);
	// The gate summary IS the task result (downstream consumers read it).
	assert.ok(finished.resultArtifact?.path, "result artifact exists");
	const resultText = fs.readFileSync(finished.resultArtifact.path, "utf8");
	assert.match(resultText, /verify_gate: PASS/);
	assert.match(resultText, /typecheck: exit=0 PASS/);
	assert.match(resultText, /test-critical: exit=0 PASS/);
	// Provenance recorded on the task state (U6B mount note: evaluator marker).
	assert.equal((finished.diagnostics as Record<string, { verdict: string }> | undefined)?.verifyGate?.verdict, "PASS");
	// Diagnostic event says the spawn was skipped.
	const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
	assert.match(events, /task\.verifier_pre_gate/);
	assert.match(events, /SKIPPED/);
	assert.match(events, /deterministic_pass/);
	// task.completed emitted (finalizer ran — events/hooks/persistence intact).
	assert.match(events, /task\.completed/);
	// No transcripts directory under the run's artifacts (nothing spawned —
	// the child-process branch would create artifactsRoot/transcripts/).
	const transcripts = path.join(created.manifest.artifactsRoot, "transcripts");
	assert.ok(!fs.existsSync(transcripts), "no transcripts dir — no worker was spawned");
});

test("U13: red gate → verifier still spawns, WITH the gate results in its prompt", async () => {
	const cwd = makeRepoDir("pi-crew-u13-red-", { typecheck: "node -e 'process.exit(5)'" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-red" });
	const task = created.tasks[0]!;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task,
			step: workflow.steps[0] as never,
			agent: agent as never,
			executeWorkers: true,
			workspaceId: "test-workspace",
		});
		const finished = result.tasks.find((t) => t.id === task.id)!;
		// The LLM verifier DID spawn (mock child-pi ran) — gate failures escalate.
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned on red gate");
		assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
		// The gate context was attached to the verifier's prompt artifact.
		const promptArtifact = path.join(created.manifest.artifactsRoot, "prompts", `${task.id}.md`);
		assert.ok(fs.existsSync(promptArtifact), "prompt artifact exists");
		const promptText = fs.readFileSync(promptArtifact, "utf8");
		assert.match(promptText, /## Deterministic verify_gate results/);
		assert.match(promptText, /Gate verdict: FAILED/);
		assert.match(promptText, /typecheck: exit=5 FAIL/);
		// Diagnostic event: spawn happened with gate context.
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /deterministic_failed/);
	} finally {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
	}
});

test("U13: PI_CREW_VERIFY_GATE=0 restores the pre-U13 behavior (gate never runs)", async () => {
	const cwd = makeRepoDir("pi-crew-u13-disabled-", { typecheck: "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-off" });
	const task = created.tasks[0]!;
	const prevGate = process.env.PI_CREW_VERIFY_GATE;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_VERIFY_GATE = "0";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task,
			step: workflow.steps[0] as never,
			agent: agent as never,
			executeWorkers: true,
			workspaceId: "test-workspace",
		});
		const finished = result.tasks.find((t) => t.id === task.id)!;
		// Verifier spawned exactly as pre-U13 (no gate short-circuit).
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned with gate disabled");
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.ok(!events.includes("task.verifier_pre_gate"), "no gate event when disabled");
	} finally {
		if (prevGate === undefined) delete process.env.PI_CREW_VERIFY_GATE;
		else process.env.PI_CREW_VERIFY_GATE = prevGate;
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
	}
});
