import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendCrewAgentEvent } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";

/**
 * Round 22 (defensive caps): The `agentEventSeqCache` Map is module-level
 * (singleton) and used to memoize the `.seq` value per event-log filePath.
 * Without a cap, a long-running pi-crew process that spawns 1000s of agents
 * accumulates 1000s of cache entries.
 *
 * The cap is enforced inside a private helper function
 * `setAgentEventSeqCache()` that the public `appendCrewAgentEvent()` goes
 * through on every call. This test exercises the cap by calling
 * `appendCrewAgentEvent` 1001 times with distinct taskIds, which forces the
 * cap to trigger at least once.
 *
 * Note: this test takes ~1-2 seconds because it creates 1001 event files
 * in a temp directory. That's the cost of fully exercising the eviction
 * path through the public API.
 */

function buildManifest(cwd: string) {
	return createRunManifest({
		cwd,
		team: {
			name: "cap-team",
			description: "cap",
			source: "builtin",
			filePath: "",
			roles: [{ name: "explorer", agent: "explorer" }],
		},
		workflow: {
			name: "cap",
			description: "",
			source: "builtin",
			filePath: "",
			steps: [],
		},
		goal: "cap",
	}).manifest;
}

test("agentEventSeqCache evicts oldest entries when it exceeds the cap (Round 22)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-seq-cap-"));
	// createRunManifest uses project state when findRepoRoot() returns a path;
	// we need a git repo in the tmp dir so files go to the project root
	// (and we can clean up easily), not the global user root.
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const manifest = buildManifest(cwd);

	// Insert 1001 distinct taskIds. Each call updates agentEventSeqCache for
	// the corresponding event-log filePath. The cap (1000) means at least
	// one entry must be evicted during the loop.
	const N = 1001;
	for (let i = 0; i < N; i++) {
		appendCrewAgentEvent(manifest, `task-${i}`, { kind: "test", index: i });
	}

	// Verify the writes succeeded (the cap is silent — the writes themselves
	// should still complete). We check the LAST file exists, not the first
	// (since the first is the most likely to be evicted from the cache).
	const lastFile = path.join(cwd, ".crew", "state", "runs", manifest.runId, "agents", "task-" + (N - 1), "events.jsonl");
	assert.ok(fs.existsSync(lastFile), "last task's event file should exist");
	const lines = fs
		.readFileSync(lastFile, "utf-8")
		.split("\n")
		.filter((l) => l.trim());
	assert.equal(lines.length, 1, "last task should have exactly one event line");

	// Parse the last line and verify the seq is 1 (it was a fresh task).
	const parsed = JSON.parse(lines[0]) as {
		seq: number;
		event: { kind: string; index: number };
	};
	assert.equal(parsed.seq, 1, "fresh task should start at seq=1");
	assert.equal(parsed.event.index, N - 1, "event payload should match the task index");

	// Bonus: a re-write to the same task should produce seq=2 (cache hit).
	appendCrewAgentEvent(manifest, `task-${N - 1}`, {
		kind: "test",
		index: N - 1,
	});
	const lines2 = fs
		.readFileSync(lastFile, "utf-8")
		.split("\n")
		.filter((l) => l.trim());
	assert.equal(lines2.length, 2, "second write to the same task should append a second line");
	const parsed2 = JSON.parse(lines2[1]) as { seq: number };
	assert.equal(parsed2.seq, 2, "second write should have seq=2 (cache hit)");

	fs.rmSync(cwd, { recursive: true, force: true });
});
