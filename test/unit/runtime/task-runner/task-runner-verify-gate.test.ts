/**
 * U13 ACCEPTANCE (upgrade spec 2026-10-09 §U13): "một run verification với
 * gate xanh không spawn LLM verifier" — a verifier-role task whose
 * deterministic gate (typecheck / test:critical from the repo's package.json
 * scripts) is GREEN completes WITHOUT spawning the LLM verifier worker; a
 * RED gate still spawns the verifier WITH the gate results in its prompt.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mock, test } from "node:test";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { resolveHostVerifyGateSpec } from "../../../../src/runtime/verification/verify-gate.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
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
	// M1-7 (R47-1): dispatch pins the host-owned verify spec on the manifest —
	// the gate runs the spec's checks and never reads the task-cwd package.json.
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
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
	// R47-V7: the synthesized skip result is provenance-tagged so the
	// effectiveness guard excludes it from observable work.
	assert.equal((finished.diagnostics as Record<string, unknown> | undefined)?.synthetic, true);
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
	const cwd = makeRepoDir("pi-crew-u13-red-", { typecheck: 'node -e "process.exit(5)"' }); // DOUBLE quotes: cmd.exe keeps single-quoted -e args as inert string literals → exit 0 → gate turns GREEN on Windows (live-caught CI 2026-10-12)
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-red" });
	// M1-7 (R47-1): host-owned spec pinned at dispatch (spec checks = the red script).
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
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

test("U13-ADJ gap 1: skip-path writeArtifact failure degrades — task completes (never fail a task)", async () => {
	const cwd = makeRepoDir("pi-crew-u13adj-artifact-", { typecheck: "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13adj-artifact" });
	const task = created.tasks[0]!;
	// Inject an FS failure scoped to the skip-path write ONLY: `results` exists
	// as a regular FILE → writeArtifact's mkdirSync(artifactsRoot/results)
	// throws (ENOTDIR/EEXIST) — the same class as ENOSPC/EACCES, hermetic and
	// cross-platform. pre-execution writes prompts/ (unaffected); only the
	// gate's result write targets results/.
	fs.mkdirSync(created.manifest.artifactsRoot, { recursive: true });
	fs.writeFileSync(path.join(created.manifest.artifactsRoot, "results"), "not-a-directory");
	// M1-7 (R47-1): host-owned spec pinned at dispatch.
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
	const errMock = mock.method(console, "error", () => undefined);
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
		// The task COMPLETED despite the artifact-write failure (degrade, not fail).
		assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
		assert.equal(finished.resultArtifact, undefined, "degraded: no result artifact");
		assert.ok(!finished.modelAttempts || finished.modelAttempts.length === 0, "still no LLM verifier spawn");
		// The degrade is LOUD (console.error) — operators can see why the artifact is missing.
		const logged = errMock.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
		assert.match(logged, /verify-gate skip-path writeArtifact failed — degrading/);
		// Gate decision itself is intact: spawn skipped, provenance recorded.
		assert.equal((finished.diagnostics as Record<string, { verdict: string }> | undefined)?.verifyGate?.verdict, "PASS");
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /SKIPPED/);
		assert.match(events, /task\.completed/);
	} finally {
		errMock.mock.restore();
	}
});

// ─── Review fix: the skip-path finalizer must NOT live inside the belt try ───

test("review fix: skip-path finalizer error propagates out of runTeamTask — no verifier spawn after the skip", async () => {
	// Belt regression: when `return await finalizeTaskResult(...)` lived inside
	// the pre-gate try, a finalizer throw was swallowed by the belt catch and
	// execution FELL THROUGH to the verifier spawn — AFTER the skip event was
	// emitted and task diagnostics mutated (double-finalize / divergent state).
	// Injection (hermetic, no module mocks): the gate's typecheck script turns
	// the events file into a DIRECTORY and exits 0, so the gate is GREEN (skip
	// path taken) but the finalizer's awaited event append then fails (EISDIR).
	// A finalizer failure must propagate (pre-belt semantics), never spawn.
	const cwd = makeRepoDir("pi-crew-u13-finale-", { typecheck: "node sabotage.js" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-finale" });
	const task = created.tasks[0]!;
	fs.writeFileSync(
		path.join(cwd, "sabotage.js"),
		`const fs = require("node:fs");\n` +
			`fs.rmSync(${JSON.stringify(created.manifest.eventsPath)}, { force: true });\n` +
			`fs.mkdirSync(${JSON.stringify(created.manifest.eventsPath)});\n`,
		"utf8",
	);
	// M1-7 (R47-1): host-owned spec pinned at dispatch (before sabotage.js exists —
	// it is not a manifest file, so the P1a snapshot is unaffected).
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	// Safety net only: a PRE-fix fall-through would spawn the MOCK child pi
	// (never a real one); post-fix nothing spawns at all.
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		await assert.rejects(
			runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0] as never,
				agent: agent as never,
				executeWorkers: true,
				workspaceId: "test-workspace",
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error, `unexpected rejection shape: ${String(error)}`);
				return true;
			},
		);
		// NO verifier spawn may follow the skip: the child-process branch would
		// create artifactsRoot/transcripts/ for the worker transcript.
		const transcripts = path.join(created.manifest.artifactsRoot, "transcripts");
		assert.ok(!fs.existsSync(transcripts), "a skip-path finalizer failure must not fall through to the verifier spawn");
		// The sabotage held for the whole run (the events path stayed a directory
		// — nothing ever appended past it) and no task.completed could land.
		assert.ok(fs.statSync(created.manifest.eventsPath).isDirectory(), "sabotage held: events path is still a directory");
	} finally {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
	}
});

// ─── M1-7 (R47-1): host-owned ground truth — tamper + absence pins ──────────

function withMockChildPi(fn: () => Promise<void>): Promise<void> {
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	return fn().finally(() => {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
	});
}

test("M1-7 P2 replay: tampered package.json vs pinned host spec ⇒ gate FAILED, verifier SPAWNS (no skip)", async () => {
	const cwd = makeRepoDir("pi-crew-u13-tamper-", { typecheck: "node -e 0", "test:critical": "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-tamper" });
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
	// Worker tampering AFTER dispatch: green scripts swapped for an always-green
	// no-op — the exact R47-1 self-grading exploit. The gate must catch the
	// manifest drift (P1a snapshot pinned at dispatch) and FAIL closed.
	fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "gate-repo", scripts: { typecheck: "exit 0" } }), "utf8");
	const task = created.tasks[0]!;
	await withMockChildPi(async () => {
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
		// The tampered scripts were NEVER run: drift ⇒ FAILED ⇒ the LLM verifier
		// spawns (mock child-pi ran) instead of a synthetic gate-skip completion.
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned on manifest drift");
		assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
		// No gate-skip provenance: this completion came from a real spawn.
		assert.equal((finished.diagnostics as Record<string, unknown> | undefined)?.verifyGate, undefined);
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /manifest-integrity/);
		assert.match(events, /deterministic_failed/);
		// The verifier's prompt carries the tamper evidence (UNTRUSTED trailer).
		const promptText = fs.readFileSync(path.join(created.manifest.artifactsRoot, "prompts", `${task.id}.md`), "utf8");
		assert.match(promptText, /Manifest integrity check FAILED/);
		assert.match(promptText, /manifest-integrity: package\.json changed since dispatch/);
	});
});

test("M1-7 fail-closed: manifest WITHOUT a pinned spec ⇒ no gate skip even with green scripts", async () => {
	const cwd = makeRepoDir("pi-crew-u13-nospec-", { typecheck: "node -e 0", "test:critical": "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "u13-nospec" });
	// NO verifyGateSpec pinned (old manifests / goal-loop turns). The gate must
	// NOT fall back to reading the worker-mutable package.json: zero resolved
	// checks ⇒ INCONCLUSIVE ⇒ the LLM verifier spawns.
	const task = created.tasks[0]!;
	await withMockChildPi(async () => {
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
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned — absence never yields a skip");
		assert.equal((finished.diagnostics as Record<string, unknown> | undefined)?.verifyGate, undefined);
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /INCONCLUSIVE/);
	});
});

// ─── W2 (worktree-verifier-gate-excludes-work): the sink pin ──────────

test("W2: green gate + dirty dependency worktree ⇒ verifier SPAWNS with the guard note (no synthetic skip)", async () => {
	const cwd = makeRepoDir("pi-crew-w2-guard-", { typecheck: "node -e 0", "test:critical": "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "w2-guard" });
	// M1-7 (R47-1): host-owned spec pinned at dispatch. The leader cwd is NOT a
	// git repo, so the W2 tree binding is simply absent (binding-optional).
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
	// Fixture: a REAL git repo + a linked worktree carrying uncommitted executor
	// work (tracked-unstaged edit + untracked new file) — the work the verifier
	// must certify, which the gate's own (pristine) tree structurally excludes.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w2-guard-repo-"));
	fs.writeFileSync(path.join(base, "app.ts"), "export const a = 1;\n");
	execFileSync("git", ["init", "-q"], { cwd: base });
	execFileSync("git", ["add", "-A"], { cwd: base });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: base });
	const wt = `${base}-wt`;
	execFileSync("git", ["worktree", "add", "-q", "-b", "wt-dep", wt], { cwd: base });
	fs.writeFileSync(path.join(wt, "app.ts"), "export const a = 2; // EXECUTOR_EDIT_MARKER\n");
	fs.writeFileSync(path.join(wt, "feature.ts"), "export const b = 3;\n");
	// Dependency task state: a completed executor task whose work lives in its
	// own worktree — never propagated into the verifier's tree.
	created.tasks.push({
		id: "dep-1",
		runId: created.manifest.runId,
		role: "executor",
		agent: "a",
		title: "implement",
		status: "completed",
		dependsOn: [],
		cwd: wt,
		worktree: { path: wt, branch: "wt-dep", reused: false },
	} as never);
	const task = created.tasks[0]!;
	(task as { dependsOn: string[] }).dependsOn = ["dep-1"];
	// BUG-028 contract: sibling tasks are DISK-authoritative (the runner's
	// persistSingleTaskUpdate re-reads tasks.json on every checkpoint), so the
	// synthetic dep must be persisted exactly like createRunTasksFromWorkflow
	// would — otherwise it vanishes from ctx.tasks before the pre-gate runs.
	saveRunTasks(created.manifest, created.tasks);
	await withMockChildPi(async () => {
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
		// The LLM verifier DID spawn despite the green gate: a PASS that never
		// saw the dependency work carries no skip authority (pre-W2 this was a
		// synthetic completed-with-exit-0 with zero checks against the work).
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned — skip refused");
		assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
		assert.equal(
			(finished.diagnostics as Record<string, unknown> | undefined)?.verifyGate,
			undefined,
			"no synthetic gate-skip provenance — this completion came from a real spawn",
		);
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /unverified_worktree_work/);
		assert.match(events, /worktree-guard/);
		// The verifier's prompt carries the gate results AND the guard evidence.
		const promptText = fs.readFileSync(path.join(created.manifest.artifactsRoot, "prompts", `${task.id}.md`), "utf8");
		assert.match(promptText, /Gate verdict: PASS/);
		assert.match(promptText, /worktree-guard/);
		assert.match(promptText, /dep-1/);
	});
});

// ─── S-1 (shared-cwd-untracked-harness, HIGH, 2026-10-31): the wiring pin ──

test("S-1: shared-cwd + completed executor dep ⇒ green gate still SPAWNS the verifier (untracked harness)", async () => {
	// The verified residual: shared-cwd mode runs the gate's `npm run …`
	// checks in the SAME cwd a WRITE-role executor just wrote to, and every
	// dispatch-pinned binding (manifest hashes, tracked treeOid, memo tree key)
	// covers TRACKED content only — a tampered gitignored harness (node_modules
	// shims) would grade its own gate and skip the LLM verifier. The host's
	// task records must refuse the skip (reason "shared-cwd-untracked-harness")
	// even though the gate itself is GREEN.
	const cwd = makeRepoDir("pi-crew-s1-shared-", { typecheck: "node -e 0", "test:critical": "node -e 0" });
	const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "s1-shared" });
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(cwd);
	const task = created.tasks[0]!;
	// Shared-cwd dependency: completed executor working in the SAME cwd as the
	// verifier's gate (no worktree of its own).
	created.tasks.push({
		id: "dep-exec",
		runId: created.manifest.runId,
		role: "executor",
		agent: "a",
		title: "implement",
		status: "completed",
		dependsOn: [],
		cwd: task.cwd,
	} as never);
	(task as { dependsOn: string[] }).dependsOn = ["dep-exec"];
	// BUG-028 contract: sibling tasks are DISK-authoritative — persist the
	// synthetic dep exactly like the W2 guard test above.
	saveRunTasks(created.manifest, created.tasks);
	await withMockChildPi(async () => {
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
		// The LLM verifier DID spawn despite the green gate: a PASS in a cwd a
		// write-role task executed in cannot certify the (untracked) harness it
		// ran. No synthetic gate-skip provenance.
		assert.ok(finished.modelAttempts && finished.modelAttempts.length > 0, "verifier spawned — skip refused");
		assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
		assert.equal((finished.diagnostics as Record<string, unknown> | undefined)?.verifyGate, undefined);
		const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
		assert.match(events, /task\.verifier_pre_gate/);
		assert.match(events, /shared-cwd-untracked-harness/);
		assert.match(events, /shared-cwd-harness/);
		// The verifier's prompt carries the gate results AND the guard evidence.
		const promptText = fs.readFileSync(path.join(created.manifest.artifactsRoot, "prompts", `${task.id}.md`), "utf8");
		assert.match(promptText, /Gate verdict: PASS/);
		assert.match(promptText, /shared-cwd-harness/);
		assert.match(promptText, /dep-exec/);
	});
});

test("S-1 control: worktree-mode dep in a CLEAN worktree ⇒ green gate still SKIPS (behavior unchanged)", async () => {
	// Worktree-mode skip behavior must be UNCHANGED by S-1: a dependency that
	// ran in its own worktree is the W2 probe path's job (dirty worktree ⇒
	// spawn); a CLEAN worktree carries no uncommitted work and the deterministic
	// skip keeps its authority.
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-s1-wt-repo-"));
	fs.writeFileSync(path.join(base, ".gitignore"), ".crew/\n");
	fs.writeFileSync(
		path.join(base, "package.json"),
		JSON.stringify({ name: "gate-repo", scripts: { typecheck: "node -e 0", "test:critical": "node -e 0" } }),
	);
	execFileSync("git", ["init", "-q"], { cwd: base });
	execFileSync("git", ["add", "-A"], { cwd: base });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: base });
	const wt = `${base}-wt`;
	execFileSync("git", ["worktree", "add", "-q", "-b", "s1-dep", wt], { cwd: base });
	const created = createRunManifest({ cwd: base, team: team as never, workflow: workflow as never, goal: "s1-wt" });
	created.manifest.verifyGateSpec = await resolveHostVerifyGateSpec(base);
	const task = created.tasks[0]!;
	created.tasks.push({
		id: "dep-wt",
		runId: created.manifest.runId,
		role: "executor",
		agent: "a",
		title: "implement",
		status: "completed",
		dependsOn: [],
		cwd: wt,
		worktree: { path: wt, branch: "s1-dep", reused: false },
	} as never);
	(task as { dependsOn: string[] }).dependsOn = ["dep-wt"];
	saveRunTasks(created.manifest, created.tasks);
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
	// No LLM verifier spawned: clean dep worktree + green gate ⇒ deterministic
	// skip stands (pre-S-1 worktree-mode behavior preserved bit-for-bit).
	assert.ok(!finished.modelAttempts || finished.modelAttempts.length === 0, "no model attempts — skip retained");
	assert.equal(finished.status, "completed", `status=${finished.status} error=${finished.error ?? ""}`);
	assert.ok(finished.resultArtifact?.path, "result artifact exists");
	const resultText = fs.readFileSync(finished.resultArtifact.path, "utf8");
	assert.match(resultText, /verify_gate: PASS/);
	assert.match(resultText, /deterministic_pass/);
	const events = fs.readFileSync(created.manifest.eventsPath, "utf8");
	assert.match(events, /task\.verifier_pre_gate/);
	assert.match(events, /SKIPPED/);
	assert.ok(!events.includes("shared-cwd-untracked-harness"), "S-1 guard silent in worktree mode");
});
