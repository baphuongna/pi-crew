import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { LIMIT_CEILINGS } from "../../../../src/config/config-validation.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { cleanupStateRoot } from "../../../helpers/rm-retry.ts";

/**
 * Fix-wave C (2026-10-28): pre-dispatch admission gate for limits.maxTasksPerRun.
 * evaluateCrewPolicy only ran at finalize, so a manifest with more tasks than the
 * cap was fully dispatched and blocked only at the end of the run. The gate now
 * lives in createRunManifest — the single funnel every normal run entry (team-tool
 * run/parallel, goal-loop turns) passes through BEFORE dispatch.
 */

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

function workflowWithSteps(stepCount: number): WorkflowConfig {
	return {
		name: "sized",
		description: "sized workflow fixture",
		source: "builtin",
		filePath: "sized.workflow.md",
		steps: Array.from({ length: stepCount }, (_, index) => ({
			id: `step-${index + 1}`,
			role: "planner",
			task: `Do step ${index + 1}`,
		})),
	};
}

/** Temp cwd with a `.git` marker (project state scoping) like the sibling state-store tests. */
function makeAdmissionCwd(prefix: string, config?: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	if (config) {
		fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".crew", "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	}
	return dir;
}

test("admission refuses a manifest with more tasks than limits.maxTasksPerRun (project config cap)", async () => {
	const cwd = makeAdmissionCwd("pi-crew-admit-over-", { limits: { maxTasksPerRun: 3 } });
	try {
		assert.throws(
			() =>
				createRunManifest({
					cwd,
					team,
					workflow: workflowWithSteps(4),
					goal: "over cap",
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error, "admission refusal must be an Error");
				const message = error.message;
				// Message must name the config key, the cap value and the actual count.
				assert.match(message, /limits\.maxTasksPerRun=3/);
				assert.match(message, /4 tasks/);
				assert.match(message, /exceeding limits\.maxTasksPerRun/);
				return true;
			},
		);
		// Admission refusal must happen BEFORE any state is written: no run dirs,
		// no events, no manifest — nothing to clean up or resume later.
		assert.equal(fs.existsSync(path.join(cwd, ".crew", "state")), false, "no state dir may be created on refusal");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("admission passes a manifest exactly at limits.maxTasksPerRun", async () => {
	const cwd = makeAdmissionCwd("pi-crew-admit-equal-", { limits: { maxTasksPerRun: 3 } });
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow: workflowWithSteps(3),
			goal: "exactly at cap",
		});
		assert.equal(created.tasks.length, 3);
		assert.ok(fs.existsSync(created.paths.manifestPath));
		assert.ok(fs.existsSync(created.paths.tasksPath));
		assert.equal(created.manifest.status, "queued");
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("admission leaves small manifests untouched when no limits config exists", async () => {
	const cwd = makeAdmissionCwd("pi-crew-admit-small-");
	try {
		const created = createRunManifest({
			cwd,
			team,
			workflow: workflowWithSteps(2),
			goal: "small manifest regression check",
		});
		assert.equal(created.tasks.length, 2);
		assert.equal(created.manifest.status, "queued");
		assert.ok(fs.existsSync(created.paths.manifestPath));
	} finally {
		await cleanupStateRoot(cwd);
	}
});

test("admission falls back to the hard ceiling: >LIMIT_CEILINGS.maxTasksPerRun tasks refused with no config", async () => {
	const cwd = makeAdmissionCwd("pi-crew-admit-ceiling-");
	try {
		assert.throws(
			() =>
				createRunManifest({
					cwd,
					team,
					workflow: workflowWithSteps(LIMIT_CEILINGS.maxTasksPerRun + 1),
					goal: "beyond the hard ceiling",
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error, "admission refusal must be an Error");
				assert.match(error.message, new RegExp(`limits\\.maxTasksPerRun=${LIMIT_CEILINGS.maxTasksPerRun}`));
				assert.match(error.message, new RegExp(`${LIMIT_CEILINGS.maxTasksPerRun + 1} tasks`));
				return true;
			},
		);
		assert.equal(fs.existsSync(path.join(cwd, ".crew", "state")), false, "no state dir may be created on refusal");
	} finally {
		await cleanupStateRoot(cwd);
	}
});
