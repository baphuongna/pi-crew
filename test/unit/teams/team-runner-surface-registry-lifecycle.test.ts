/**
 * S2-T11 wiring regression: team-runner đăng ký per-run surface-degrade
 * controller cho ĐÚNG runId và PHẢI gỡ sạch khi run kết thúc — controller sót
 * lại sẽ làm run sau kế thừa lockout/pane count của run cũ (registry keyed by
 * runId nên lẽ ra vô hại, nhưng leak là leak).
 *
 * Harness: PI_TEAMS_MOCK_CHILD_PI (mock trả về trước nhánh surface) — đủ để
 * chạy trọn vòng đời executeTeamRun mà không cần mux thật.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	clearSurfaceRuntimeController,
	getSurfaceRuntimeController,
	registerSurfaceRuntimeController,
	type SurfaceRuntimeController,
} from "../../../src/runtime/surface/degrade.ts";
import { executeTeamRun } from "../../../src/runtime/team-runner.ts";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";

function saveMockEnv(): Record<string, string | undefined> {
	return { mock: process.env.PI_TEAMS_MOCK_CHILD_PI, allow: process.env.PI_CREW_ALLOW_MOCK };
}

test("executeTeamRun registers the surface degrade controller for its run and clears it on exit", async () => {
	const prev = saveMockEnv();
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-surface-registry-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const team = {
			name: "surface-registry",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "builtin",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "surface-registry",
			description: "",
			steps: [{ id: "a", role: "worker", task: "A", source: "builtin" }],
			source: "builtin",
			filePath: "builtin",
		} as never;

		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "verify registry lifecycle",
		} as never);
		clearSurfaceRuntimeController(created.manifest.runId);

		// Sentinel: pre-register cho cùng runId. executeTeamRun phải ĐÈ entry này
		// (controller của nó) rồi XÓA khi run kết thúc.
		clearSurfaceRuntimeController(created.manifest.runId);
		const sentinel: SurfaceRuntimeController = {
			runId: created.manifest.runId,
			livePaneCount: () => 0,
			shouldAttemptSurface: () => false,
			notifySpawned() {
				/* sentinel — run của team-runner sẽ đè entry này */
			},
			notifySpawnFailed() {
				/* sentinel */
			},
			notifyWorkerStarted() {
				/* sentinel */
			},
			notifyPaneExited() {
				/* sentinel */
			},
			takeDegraded: () => [],
			consecutiveSpawnFails: () => 0,
			snapshot: () => ({ provider: null, panes: {}, workerPids: {}, sessionPaths: {} }),
		};
		registerSurfaceRuntimeController(sentinel);
		assert.ok(getSurfaceRuntimeController(created.manifest.runId), "sentinel phải thấy được trước run");

		const result = await executeTeamRun({
			manifest: created.manifest,
			tasks: created.tasks as TeamTaskState[],
			team,
			workflow,
			agents: [],
			executeWorkers: true,
			workspaceId: cwd,
		} as never);

		assert.equal(getSurfaceRuntimeController(result.manifest.runId), undefined, "run xong phải hủy đăng ký — không leak sang run sau");
	} finally {
		if (prev.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prev.mock;
		if (prev.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prev.allow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
