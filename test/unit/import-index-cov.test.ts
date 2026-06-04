import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listImportedRuns } from "../../src/extension/import-index.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";
import { projectCrewRoot } from "../../src/utils/paths.ts";
import { DEFAULT_PATHS } from "../../src/config/defaults.ts";
import * as fs from "node:fs";
import * as path from "node:path";

function getImportsRoot(cwd: string): string {
	return path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.importsSubdir);
}

function writeImportBundle(importsRoot: string, runId: string, manifestOverrides?: Record<string, unknown>) {
	const dir = path.join(importsRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	const bundle = {
		schemaVersion: 1,
		exportedAt: "2026-01-01T00:00:00Z",
		importedAt: "2026-01-02T00:00:00Z",
		manifest: {
			schemaVersion: 1,
			runId,
			team: "test-team",
			workflow: "default",
			goal: "test goal",
			status: "completed",
			...manifestOverrides,
		},
		tasks: [],
		events: [],
		artifactPaths: [],
	};
	fs.writeFileSync(path.join(dir, "run-export.json"), JSON.stringify(bundle));
}

describe("listImportedRuns", () => {
	it("returns empty array when no imports directory exists", () => {
		const tmp = createTrackedTempDir("pi-crew-import-");
		const result = listImportedRuns(tmp);
		assert.deepEqual(result, []);
		removeTrackedTempDir(tmp);
	});

	it("returns entries for valid imported runs", () => {
		const tmp = createTrackedTempDir("pi-crew-import-");
		const importsRoot = getImportsRoot(tmp);
		fs.mkdirSync(importsRoot, { recursive: true });
		writeImportBundle(importsRoot, "imported-run-1");

		const result = listImportedRuns(tmp);
		assert.equal(result.length, 1);
		assert.equal(result[0].runId, "imported-run-1");
		assert.equal(result[0].status, "completed");
		removeTrackedTempDir(tmp);
	});

	it("skips directories without run-export.json", () => {
		const tmp = createTrackedTempDir("pi-crew-import-");
		const importsRoot = getImportsRoot(tmp);
		fs.mkdirSync(path.join(importsRoot, "empty-dir"), { recursive: true });

		const result = listImportedRuns(tmp);
		assert.equal(result.length, 0);
		removeTrackedTempDir(tmp);
	});

	it("extracts metadata from bundle manifest", () => {
		const tmp = createTrackedTempDir("pi-crew-import-");
		const importsRoot = getImportsRoot(tmp);
		fs.mkdirSync(importsRoot, { recursive: true });
		writeImportBundle(importsRoot, "meta-run", {
			team: "custom-team",
			workflow: "custom-wf",
			goal: "custom goal",
			status: "failed",
		});

		const result = listImportedRuns(tmp);
		assert.equal(result.length, 1);
		assert.equal(result[0].team, "custom-team");
		assert.equal(result[0].workflow, "custom-wf");
		assert.equal(result[0].goal, "custom goal");
		assert.equal(result[0].status, "failed");
		removeTrackedTempDir(tmp);
	});

	it("handles corrupt JSON gracefully", () => {
		const tmp = createTrackedTempDir("pi-crew-import-");
		const importsRoot = getImportsRoot(tmp);
		const dir = path.join(importsRoot, "corrupt-run");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "run-export.json"), "NOT JSON");

		const result = listImportedRuns(tmp);
		assert.equal(result.length, 1);
		assert.equal(result[0].runId, "corrupt-run");
		assert.equal(result[0].status, undefined);
		removeTrackedTempDir(tmp);
	});
});
