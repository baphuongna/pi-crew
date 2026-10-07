/**
 * L1 pin (real-test 2026-10-07 ui-instability review): the crew dock renders
 * active runs in EVERY session. `activeWidgetRuns` used to drop runs whose
 * `ownerSessionId` belonged to a different workspace, so bystander terminals
 * saw nothing while a run was live (live evidence: 308 frames / 0 dock).
 * The display filter is removed — this test fails if it is ever restored.
 * The `workspaceId` parameter itself must survive (crash recovery is still
 * session-scoped), which the calls below pin in the signature.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { createRunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import { activeWidgetRuns } from "../../../src/ui/widget/widget-model.ts";

const CURRENT_WORKSPACE = "workspace-current";
const FOREIGN_WORKSPACE = "workspace-foreign";

function tempCwd(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

/** Persist one ACTIVE run (manifest + tasks + a running agent) for a given owner. */
function makeActiveRun(cwd: string, goal: string, ownerSessionId?: string): TeamRunManifest {
	const team = {
		name: "default",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "builtin",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "default",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "builtin",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal, ownerSessionId });
	const manifest: TeamRunManifest = { ...created.manifest, status: "running" };
	saveRunManifest(manifest);
	saveRunTasks(manifest, created.tasks);
	saveCrewAgents(manifest, [
		{
			id: `${manifest.runId}:01`,
			runId: manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "running",
			startedAt: manifest.createdAt,
			progress: { recentTools: [], recentOutput: ["hi"], toolCount: 1, currentTool: "read", tokens: 1 },
		},
	]);
	return manifest;
}

test("bystander sessions: activeWidgetRuns returns foreign-owned and ownerless runs, not just the current workspace's", () => {
	const cwd = tempCwd("pi-bystander-");
	try {
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const owned = makeActiveRun(cwd, "owned-by-current", CURRENT_WORKSPACE);
		const foreign = makeActiveRun(cwd, "owned-by-foreign", FOREIGN_WORKSPACE);
		const unowned = makeActiveRun(cwd, "no-owner");
		for (const manifest of [owned, foreign, unowned]) {
			cache.refresh(manifest.runId);
			assert.ok(cache.get(manifest.runId), `precondition: snapshot cached for ${manifest.runId}`);
		}

		// Same call shape as the widget render path, with the current workspace id.
		const runs = activeWidgetRuns(cwd, undefined, cache, [owned, foreign, unowned], CURRENT_WORKSPACE);

		assert.equal(runs.length, 3, "ALL active runs render — including the foreign-owned one (L1)");
		assert.deepEqual(
			runs.map((item) => item.run.runId).sort(),
			[owned.runId, foreign.runId, unowned.runId].sort(),
			"owned + foreign-owner + ownerless runs are all present",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("bystander sessions: workspaceId still flows into activeWidgetRuns (crash-recovery stays session-scoped)", () => {
	const cwd = tempCwd("pi-bystander-keep-");
	try {
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const foreign = makeActiveRun(cwd, "foreign-only", FOREIGN_WORKSPACE);
		cache.refresh(foreign.runId);
		assert.ok(cache.get(foreign.runId), "precondition: snapshot cached");

		// A session that owns NOTHING still sees the foreign run (this was the
		// exact bystander-terminal scenario), and undefined workspaceId keeps
		// working (the legacy/no-session call shape used by tests + agents-jobs-browser).
		const withId = activeWidgetRuns(cwd, undefined, cache, [foreign], CURRENT_WORKSPACE);
		assert.equal(withId.length, 1, "foreign-owned run renders even when this workspace owns no runs");
		const noId = activeWidgetRuns(cwd, undefined, cache, [foreign], undefined);
		assert.equal(noId.length, 1, "undefined workspaceId (legacy call shape) still renders the run");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
