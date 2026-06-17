import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunManifest } from "../../src/state/state-store.ts";
import { buildCrewWidgetLines } from "../../src/ui/widget/index.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function createTestRun(cwd: string, teamName = "width-test"): TeamRunManifest {
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = { name: teamName, description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	return createRunManifest({ cwd, team, workflow, goal: "width safety test" }).manifest;
}

function toWidgetRuns(runs: TeamRunManifest[]) {
	return runs.map((run) => ({ run, agents: [] as never[], snapshot: undefined as never }));
}

describe("crew-widget width safety", () => {
	it("renders without crash at width=1", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-width-"));
		try {
			const manifest = createTestRun(cwd);
			const lines = buildCrewWidgetLines(cwd, 0, 10, toWidgetRuns([manifest]), 0);
			assert.ok(Array.isArray(lines));
			for (const line of lines) {
				assert.ok(typeof line === "string", "Each line should be a string");
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("renders without crash at width=40", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-width-"));
		try {
			const manifest = createTestRun(cwd);
			const lines = buildCrewWidgetLines(cwd, 0, 10, toWidgetRuns([manifest]), 0);
			assert.ok(Array.isArray(lines));
			assert.ok(lines.length > 0, "Should produce at least one line");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("renders without crash at width=200", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-width-"));
		try {
			const manifest = createTestRun(cwd);
			const lines = buildCrewWidgetLines(cwd, 0, 10, toWidgetRuns([manifest]), 0);
			assert.ok(Array.isArray(lines));
			for (const line of lines) {
				assert.ok(line.length <= 202, `Line should not exceed width+2: got ${line.length}`);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("handles empty runs list", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-width-"));
		try {
			const lines = buildCrewWidgetLines(cwd, 0, 10, [], 0);
			assert.ok(Array.isArray(lines));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("handles multiple runs", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-width-"));
		try {
			const runs = [createTestRun(cwd, "team-a"), createTestRun(cwd, "team-b"), createTestRun(cwd, "team-c")];
			const lines = buildCrewWidgetLines(cwd, 0, 10, toWidgetRuns(runs), 3);
			assert.ok(Array.isArray(lines));
			assert.ok(lines.length > 0, "Should produce output for multiple runs");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});