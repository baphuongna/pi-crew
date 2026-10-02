/**
 * G20 fail-closed partial delimiter-hit — behavioral battery.
 *
 * Bug (upgrade-plan §2 G20): in splitCoalescedOutput, a PARTIAL delimiter
 * hit (0 < delimiterHits.size < taskIds.length — the worker delimited some
 * but not all of the group's known taskIds) skipped Strategy-2 section
 * parsing entirely and fell through to Strategy-3 broadcast, handing the
 * FULL raw output — including other tasks' delimited bodies — to EVERY task
 * in the group (cross-task content leak). The `entry?.text ?? rawOutput`
 * fallback in the per-task mapping loop was a second leak path for tasks
 * without a split entry.
 *
 * Fix: the splitter returns strategy "deadletter" with empty text for the
 * whole group; run-coalesced-task-group records ONE deadletter entry for
 * the group's FIRST task (the deliberate US-003 granularity — the group
 * shares one worker, the message names all taskIds), fails every group
 * task with a content-free marker, and never lets a task see another
 * task's content.
 *
 * Tests (public runCoalescedTaskGroup API, no internal mocking):
 *   1. PARTIAL hit via a fake pi CLI (PI_TEAMS_PI_BIN, json-success stdout
 *      protocol): 3-task group, only task #1 delimited → all tasks
 *      "failed" with markers; no artifact/result text contains the
 *      delimited secret body, the undelimited prose, or any delimiter
 *      marker; deadletter run-local file AND project-level index each hold
 *      exactly one entry against the first task naming all 3 taskIds;
 *      task.coalesced_dispatch_end carries strategy "deadletter" +
 *      deadlettered true.
 *   2. FULL hit regression (fake pi CLI delimits all 3): every task
 *      "completed" and receives ONLY its own body (no cross-task leak on
 *      the happy path either).
 *   3. ZERO hit regression (PI_TEAMS_MOCK_CHILD_PI=raw-final-text-only):
 *      broadcast fallback intact — all tasks "completed" with the shared
 *      raw text.
 *
 * Env notes: mirrors run-coalesced-error-field.test.ts — fake pi via
 * PI_TEAMS_PI_BIN (allowed prefix via npm_config_prefix), PI_CREW_DEPTH /
 * PI_TEAMS_DEPTH scrubbed (this suite also runs inside pi-crew worker
 * shells where those are set).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import { runCoalescedTaskGroup } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "coalesced-deadletter",
	description: "G20 deadletter split test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

// 3 same-role steps → createRunManifest yields 3 tasks → one coalesced group.
const workflow: WorkflowConfig = {
	name: "wf-g20",
	description: "G20 test",
	steps: [
		{ id: "s-one", role: "worker", task: "Do one {goal}" },
		{ id: "s-two", role: "worker", task: "Do two {goal}" },
		{ id: "s-three", role: "worker", task: "Do three {goal}" },
	],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "G20 worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-g20-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of keys) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(snap)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

const FAKE_PI_ENV_KEYS = [
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	"PI_CREW_DEPTH",
	"PI_TEAMS_DEPTH",
	"npm_config_prefix",
];

/**
 * Write a fake pi CLI that emits ONE assistant message carrying `finalText`
 * (json-success stdout protocol) then a message_end, and exits 0. The fake
 * runs under `node <script> --mode json -p <prompt>…` (see
 * pi-spawn.ts isRunnableNodeScript) and ignores its argv.
 */
function writeFakePi(scriptDir: string, finalText: string): string {
	const scriptPath = path.join(scriptDir, "fake-pi-g20.js");
	fs.writeFileSync(
		scriptPath,
		[
			"// Fake pi CLI for the G20 deadletter-split battery.",
			`const text = ${JSON.stringify(finalText)};`,
			'process.stdout.write(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\\n");',
			'process.stdout.write(JSON.stringify({ type: "message_end", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } }) + "\\n");',
		].join("\n"),
	);
	return scriptPath;
}

function armFakePi(scriptDir: string, scriptPath: string): void {
	process.env.npm_config_prefix = scriptDir; // allowed-prefix validation for PI_TEAMS_PI_BIN
	process.env.PI_TEAMS_PI_BIN = scriptPath;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
	// Worker-shell gotcha: PI_CREW_DEPTH/PI_TEAMS_DEPTH are set when this
	// suite runs inside a pi-crew worker — scrub so the depth guard doesn't
	// refuse the spawn.
	delete process.env.PI_CREW_DEPTH;
	delete process.env.PI_TEAMS_DEPTH;
}

function readDeadletterJsonl(filePath: string): unknown[] {
	if (!fs.existsSync(filePath)) return [];
	return fs
		.readFileSync(filePath, "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

/** Final per-task state as persisted on disk (tasksPath is a JSON array). */
function readSavedTasks(tasksPath: string): Array<Record<string, unknown>> {
	return JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as Array<Record<string, unknown>>;
}

test("G20: partial delimiter hit → deadletter, zero cross-task content, no broadcast", async () => {
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-g20-fakepi-"));
	const envSnap = snapshotEnv(FAKE_PI_ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "G20 partial hit" });
		const taskIds = tasks.map((t) => t.id);
		assert.equal(taskIds.length, 3, "3 same-role steps must yield a 3-task group");
		const [id1, id2, id3] = taskIds as [string, string, string];

		// Only task #1 follows the delimiter contract. The other two tasks'
		// findings sit in undelimited prose. Both bodies are secrets that must
		// NOT reach any task's result once the output is unpartitionable.
		const finalText = [
			"Group preamble for all three tasks.",
			"",
			`<<<TASK_RESULT:${id1}>>>`,
			"SECRET-DELIMITED-BODY-ONE.",
			"<<<END_TASK_RESULT>>>",
			"",
			"SECRET-UNDELIMITED-PROSE: merged findings for the two tasks that skipped the delimiters.",
		].join("\n");
		const scriptPath = writeFakePi(scriptDir, finalText);
		armFakePi(scriptDir, scriptPath);

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-g20-partial",
			reliability: { autoRetry: false },
		});

		// ── Every group task fails closed with a content-free marker ──
		for (const taskId of taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "failed", `task ${taskId} must be failed (got '${task.status}')`);
		}

		// Marker text: names the task, carries NO cross-task content.
		const saved = readSavedTasks(manifest.tasksPath);
		for (const taskId of taskIds) {
			const savedTask = saved.find((t) => t.id === taskId)!;
			assert.equal(savedTask.status, "failed");
			const res = savedTask.result as { text: string; strategy: string } | undefined;
			assert.ok(res, `task ${taskId} must carry a result record`);
			assert.equal(res!.strategy, "deadletter");
			assert.match(res!.text, /unpartitionable/);
			assert.match(res!.text, new RegExp(taskId));
			assert.ok(!res!.text.includes("SECRET-DELIMITED-BODY-ONE"), "marker must not carry the delimited body");
			assert.ok(!res!.text.includes("SECRET-UNDELIMITED-PROSE"), "marker must not carry the undelimited prose");
			assert.ok(!res!.text.includes("<<<TASK_RESULT"), "marker must not carry raw delimiters");
			assert.notEqual(res!.text, finalText, "marker must not be the full raw output");
		}

		// Result artifacts (what aggregateTaskOutputs reads) carry the same marker.
		for (const taskId of taskIds) {
			const artifactPath = path.join(manifest.artifactsRoot, "results", `${taskId}.txt`);
			assert.ok(fs.existsSync(artifactPath), `result artifact for ${taskId} must exist`);
			const content = fs.readFileSync(artifactPath, "utf-8");
			assert.match(content, /unpartitionable/);
			assert.ok(!content.includes("SECRET-DELIMITED-BODY-ONE"), `artifact ${taskId} must not leak the delimited body`);
			assert.ok(!content.includes("SECRET-UNDELIMITED-PROSE"), `artifact ${taskId} must not leak the prose`);
		}

		// ── Deadletter: ONE entry against the FIRST task, naming the group ──
		const runLocal = readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl"));
		assert.equal(runLocal.length, 1, "exactly one deadletter entry for the group");
		const entry = runLocal[0] as { taskId: string; reason: string; lastError?: string };
		assert.equal(entry.taskId, id1, "deadletter entry is deliberately recorded against the first task (US-003 pattern)");
		assert.equal(entry.reason, "manual");
		for (const id of [id1, id2, id3]) {
			assert.ok(entry.lastError?.includes(id), `deadletter lastError must name group member ${id}`);
		}
		assert.match(entry.lastError ?? "", /partial delimiter hit/);
		// Project-level index (survives run pruning) mirrors the entry.
		const indexEntries = readDeadletterJsonl(path.join(cwd, ".crew", "state", "deadletter", `${manifest.runId}.jsonl`));
		assert.equal(indexEntries.length, 1);
		assert.equal((indexEntries[0] as { taskId: string }).taskId, id1);

		// ── Dispatch-end event reports the deadletter split ──
		const events = fs
			.readFileSync(manifest.eventsPath, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { type: string; data?: Record<string, unknown> });
		const end = events.filter((e) => e.type === "task.coalesced_dispatch_end").at(-1)!;
		assert.equal(end.data?.deadlettered, true);
		assert.equal(end.data?.strategy, "deadletter");
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});

test("G20 regression: full delimiter hit → per-task partition, no cross-task leak", async () => {
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-g20-fakepi-"));
	const envSnap = snapshotEnv(FAKE_PI_ENV_KEYS);
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "G20 full hit" });
		const taskIds = tasks.map((t) => t.id);
		const finalText = taskIds.map((id, i) => `<<<TASK_RESULT:${id}>>>\nSECRET-BODY-${i}-ONLY.\n<<<END_TASK_RESULT>>>`).join("\n\n");
		const scriptPath = writeFakePi(scriptDir, finalText);
		armFakePi(scriptDir, scriptPath);

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-g20-full",
			reliability: { autoRetry: false },
		});

		assert.equal(result.success, true, "full-hit dispatch must succeed");
		const saved = readSavedTasks(manifest.tasksPath);
		taskIds.forEach((taskId, i) => {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "completed", `task ${taskId} must be completed`);
			const savedTask = saved.find((t) => t.id === taskId)!;
			const res = savedTask.result as { text: string; strategy: string };
			assert.equal(res.strategy, "delimiter");
			assert.match(res.text, new RegExp(`SECRET-BODY-${i}-ONLY`));
			for (let j = 0; j < taskIds.length; j += 1) {
				if (j !== i) assert.ok(!res.text.includes(`SECRET-BODY-${j}-ONLY`), `task ${taskId} must not carry task #${j}'s body`);
			}
		});

		// No deadletter entry on the happy path.
		assert.equal(readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl")).length, 0);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});

test("G20 regression: zero-hit output still broadcasts (shared context, no delimited bodies)", async () => {
	const envSnap = snapshotEnv(FAKE_PI_ENV_KEYS);
	const cwd = makeTmpCwd();
	try {
		// raw-final-text-only: exitCode 0, rawFinalText fixed, no delimiters,
		// no section headings → the 0-hit broadcast fallback must stay intact.
		process.env.PI_TEAMS_MOCK_CHILD_PI = "raw-final-text-only";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		delete process.env.PI_TEAMS_PI_BIN;
		delete process.env.PI_CREW_DEPTH;
		delete process.env.PI_TEAMS_DEPTH;

		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "G20 zero hit" });
		const taskIds = tasks.map((t) => t.id);
		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step: workflow.steps![0]!,
			agent,
			executeWorkers: true,
			workspaceId: "ws-g20-zero",
			reliability: { autoRetry: false },
		});

		assert.equal(result.success, true);
		const saved = readSavedTasks(manifest.tasksPath);
		for (const taskId of taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "completed", `zero-hit task ${taskId} must stay completed`);
			const res = saved.find((t) => t.id === taskId)!.result as { text: string; strategy: string };
			assert.equal(res.strategy, "broadcast");
			assert.match(res.text, /RR-013 boundary probe result/);
		}
		assert.equal(readDeadletterJsonl(path.join(manifest.stateRoot, "deadletter.jsonl")).length, 0);
	} finally {
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
