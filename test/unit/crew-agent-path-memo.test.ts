/**
 * P1-5 regression guard: per-task agent path memoization.
 *
 * Before the fix, `appendCrewAgentEvent` called `ensureAgentStateDir` then
 * `agentStateFile` (which called `ensureAgentStateDir` AGAIN), each doing
 * mkdir×2 + lstat×2 + resolveRealContainedPath (≈30 syscalls, incl. a full
 * ancestor walk) — repeated on EVERY event/output line. The fix memoizes the
 * validated dir + file paths per task so the validation runs ONCE.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import {
	__test_agentPathCacheStats,
	__test_clearAgentPathCache,
	agentEventsPath,
	appendCrewAgentEvent,
	appendCrewAgentOutput,
} from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";

const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

function buildManifest(cwd: string) {
	return createRunManifest({
		cwd,
		team: {
			name: "memo-team",
			description: "memo",
			source: "builtin",
			filePath: "",
			roles: [{ name: "explorer", agent: "explorer" }],
		},
		workflow: { name: "memo", description: "", source: "builtin", filePath: "", steps: [] },
		goal: "memo",
	}).manifest;
}

test("agent paths are memoized once per task across many events", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-path-memo-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	__test_clearAgentPathCache();

	// Append 50 events for ONE task. Before the fix each event re-validated the
	// dir + file path (≈60 syscalls). After: validation runs once, then cached.
	for (let i = 0; i < 50; i++) {
		appendCrewAgentEvent(manifest, "task-1", { type: "test.event", n: i });
	}

	const stats = __test_agentPathCacheStats();
	assert.equal(stats.dirs, 1, "agent state dir ensured exactly once for the task");
	assert.equal(stats.files, 1, "events.jsonl path resolved exactly once");

	// Correctness: all 50 events persisted.
	const lines = fs.readFileSync(agentEventsPath(manifest, "task-1"), "utf-8").trim().split("\n");
	assert.equal(lines.length, 50, "all 50 events written");
	assert.equal(JSON.parse(lines[49]!).event.n, 49, "events in order");
});

test("distinct files (events.jsonl vs output.log) cache independently", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-path-memo2-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	__test_clearAgentPathCache();

	for (let i = 0; i < 10; i++) appendCrewAgentEvent(manifest, "task-X", { type: "e" });
	for (let i = 0; i < 5; i++) appendCrewAgentOutput(manifest, "task-X", `line ${i}\n`);

	const stats = __test_agentPathCacheStats();
	assert.equal(stats.dirs, 1, "one dir for one task");
	assert.equal(stats.files, 2, "events.jsonl + output.log resolved once each");
});

test("distinct tasks cache independently (no cross-task path reuse)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-path-memo3-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	__test_clearAgentPathCache();

	appendCrewAgentEvent(manifest, "task-A", { type: "e" });
	appendCrewAgentEvent(manifest, "task-B", { type: "e" });

	const stats = __test_agentPathCacheStats();
	assert.equal(stats.dirs, 2, "two tasks → two dirs");
	assert.equal(stats.files, 2, "two events.jsonl paths");
});
