/**
 * RT-F3 regression test: manifestCache.listActive(limit) must return every
 * running manifest, capped only by `limit`, NOT by the top-N createdAt cutoff
 * that `list(limit)` uses. Previously, orphaned "running" runs that had been
 * pushed past the top-50 by newer successful runs were silently hidden from
 * crash-recovery scans.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import { createRunManifest, updateRunStatus } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "act",
	description: "act",
	source: "builtin",
	filePath: "act.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "act",
	description: "act",
	source: "builtin",
	filePath: "act.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

test("listActive returns every running run regardless of createdAt ordering", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		// Create 60 runs: 30 "completed" + 30 "running". The running ones were
		// created FIRST so they have the OLDEST createdAt timestamps, putting
		// them at the BOTTOM of any top-N list(limit) sort.
		const runningIds: string[] = [];
		for (let i = 0; i < 30; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `running ${i}` });
			updateRunStatus(manifest, "running", "test");
			runningIds.push(manifest.runId);
		}
		for (let i = 0; i < 30; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `completed ${i}` });
			const running = updateRunStatus(manifest, "running", "test");
			updateRunStatus(running, "completed", "test");
		}

		const cache = createManifestCache(cwd);

		// Sanity: list(50) hides the 10 OLDEST running runs because they fell
		// past the top-50 cutoff (30 completed created last + 20 newest running
		// = 50; the other 10 running are pushed off the end).
		const listed = cache.list(50);
		assert.equal(listed.length, 50);
		const listedRunning = listed.filter((m) => m.status === "running");
		assert.equal(listedRunning.length, 20, "list(50) hides the 10 oldest running runs");
		const listedRunningIds = new Set(listedRunning.map((m) => m.runId));
		const missingRunning = runningIds.filter((id) => !listedRunningIds.has(id));
		assert.equal(missingRunning.length, 10, "exactly 10 running runs are hidden by list(50)");

		// listActive(50) MUST return every running run we created in this cwd,
		// regardless of age. (We check subset, not exact length, because the
		// global active-run-registry may carry ghost entries from prior test
		// runs in other tempdirs that surface as additional "running" entries
		// to listActive — that's an orthogonal issue from the RT-F3 fix.)
		const active = cache.listActive(50);
		const activeIds = new Set(active.map((m) => m.runId));
		for (const id of runningIds) {
			assert.ok(activeIds.has(id), `listActive must include running run ${id} from this cwd`);
		}
		for (const m of active) {
			assert.equal(m.status, "running");
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listActive caps at the limit (not the underlying list cap)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-cap-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `run ${i}` });
			updateRunStatus(manifest, "running", "test");
			created.push(manifest.runId);
		}
		const cache = createManifestCache(cwd);
		const limited = cache.listActive(3);
		assert.equal(limited.length, 3);
		for (const m of limited) {
			assert.equal(m.status, "running");
			assert.ok(created.includes(m.runId));
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
