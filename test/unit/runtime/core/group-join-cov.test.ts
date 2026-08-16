import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { CrewRuntimeConfig } from "../../../../src/config/config.ts";
import { deliverGroupJoin, resolveGroupJoinMode, shouldGroupJoin } from "../../../../src/runtime/group-join.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

// Note: additional coverage for the live exported surface of group-join.ts.
// The dead GroupJoinManager class was removed (Round 6 F3); the tests below
// cover the pure functions plus deliverGroupJoin's status classification.

function makeTask(id: string, status: string): any {
	return { id, status, title: `task ${id}` };
}

function makeManifest(dir: string): TeamRunManifest {
	const stateRoot = path.join(dir, "state");
	const artifactsRoot = path.join(dir, "artifacts");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	return {
		schemaVersion: "1.0" as any,
		runId: "run_gj_cov",
		team: "default",
		goal: "cov group join",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: dir,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	} as unknown as TeamRunManifest;
}

describe("group-join (cov)", () => {
	describe("resolveGroupJoinMode", () => {
		it("returns 'smart' by default", () => {
			assert.equal(resolveGroupJoinMode(undefined), "smart");
		});

		it("returns configured 'off'", () => {
			assert.equal(
				resolveGroupJoinMode({
					groupJoin: "off",
				} as unknown as CrewRuntimeConfig),
				"off",
			);
		});

		it("returns configured 'group'", () => {
			assert.equal(
				resolveGroupJoinMode({
					groupJoin: "group",
				} as unknown as CrewRuntimeConfig),
				"group",
			);
		});
	});

	describe("shouldGroupJoin", () => {
		it("returns false for 'off' mode regardless of batch size", () => {
			assert.equal(shouldGroupJoin("off", [{} as any]), false);
		});

		it("returns true for 'group' mode with any batch", () => {
			assert.equal(shouldGroupJoin("group", [{} as any]), true);
		});

		it("returns false for 'smart' mode with single task", () => {
			assert.equal(shouldGroupJoin("smart", [{} as any]), false);
		});

		it("returns true for 'smart' mode with multiple tasks", () => {
			assert.equal(shouldGroupJoin("smart", [{} as any, {} as any]), true);
		});

		it("returns false for 'group' mode with empty batch", () => {
			assert.equal(shouldGroupJoin("group", []), false);
		});
	});

	describe("deliverGroupJoin", () => {
		it("classifies completed, failed, and skipped tasks in the delivery", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-cov-"));
			try {
				const manifest = makeManifest(dir);
				const batch = [makeTask("01", "completed"), makeTask("02", "failed"), makeTask("03", "skipped")];
				const delivery = deliverGroupJoin({ manifest, mode: "smart", batch, allTasks: batch });

				assert.ok(delivery);
				assert.deepEqual(delivery.completed, ["01"]);
				assert.deepEqual(delivery.failed, ["02"]);
				assert.deepEqual(delivery.skipped, ["03"]);
				assert.equal(delivery.partial, false);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("'group' mode delivers a single-task batch (no smart threshold)", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-cov-"));
			try {
				const manifest = makeManifest(dir);
				const batch = [makeTask("01", "completed")];
				const delivery = deliverGroupJoin({ manifest, mode: "group", batch, allTasks: batch });

				assert.ok(delivery);
				assert.deepEqual(delivery.completed, ["01"]);
				assert.equal(delivery.mode, "group");
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it("'off' mode never delivers", () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-group-join-cov-"));
			try {
				const manifest = makeManifest(dir);
				const batch = [makeTask("01", "completed"), makeTask("02", "completed")];
				const delivery = deliverGroupJoin({ manifest, mode: "off", batch, allTasks: batch });
				assert.equal(delivery, undefined);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
