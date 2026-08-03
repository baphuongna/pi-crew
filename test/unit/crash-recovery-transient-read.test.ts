/**
 * ST-6 regression tests: transient read errors must NOT quarantine a healthy manifest.
 *
 * BEFORE FIX: purgeStaleActiveRunIndex quarantined the manifest (renamed to
 * .corrupt-*) on ALL errors from JSON.parse(readFileSync(...)), including
 * transient I/O errors like EBUSY/EACCES from Windows AV scans. This made
 * valid runs permanently unloadable.
 *
 * AFTER FIX (ST-6):
 *   - SyntaxError (genuinely corrupt JSON) → quarantine (existing behavior preserved)
 *   - ErrnoException with transient code (EBUSY/EACCES/EAGAIN) → retry with
 *     exponential backoff; if still failing after retries, SKIP without quarantining
 *   - Other errors → quarantine (fallback)
 *   - .corrupt-* files older than the configurable TTL are swept and deleted
 *     by sweepStaleCorruptFiles (called from pruneFinishedRuns/pruneUserLevelRuns).
 *
 * Mutation check: revert to the old catch-all quarantine → EBUSY/EACCES tests
 * MUST fail because the manifest gets quarantined (renamed away).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sweepStaleCorruptFiles } from "../../src/extension/run-maintenance.ts";
import {
	_setReadManifestFileSyncForTest,
	purgeStaleActiveRunIndex,
	readManifestWithTransientRetry,
} from "../../src/runtime/recovery/crash-recovery.ts";
import { registerActiveRun } from "../../src/state/active-run-registry.ts";
import { createRunManifest, saveRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "transient",
	description: "transient-read test",
	source: "builtin",
	filePath: "transient.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "transient",
	description: "transient-read test",
	source: "builtin",
	filePath: "transient.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-transient-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

const STALE = 5 * 60 * 1000;

function makeErrnoError(code: string, message: string): NodeJS.ErrnoException {
	const err = new Error(message) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

/**
 * Install a test-seam mock for _readManifestFileSync that throws a given error
 * for a specific target path, delegating all other paths to the real readFileSync.
 * Returns a restore function.
 */
function mockReadForPath(
	targetPath: string,
	errorFn: () => Error,
	maxFails = Infinity,
): { restore: () => void; failCount: number } {
	const state = { failCount: 0, restore: () => _setReadManifestFileSyncForTest(null) };
	const impl = (filePath: string): string => {
		if (filePath === targetPath && state.failCount < maxFails) {
			state.failCount++;
			throw errorFn();
		}
		return fs.readFileSync(filePath, "utf-8");
	};
	_setReadManifestFileSyncForTest(impl);
	return state;
}

// ─── Test 1: EBUSY → manifest NOT quarantined (skipped, retried) ───
test("ST-6: EBUSY on readFileSync → manifest NOT quarantined (skipped, retried)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-ebusy-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "EBUSY transient test" });
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			const manifestPath = created.paths.manifestPath;
			assert.ok(fs.existsSync(manifestPath), "manifest exists before purge");

			// Mock the read seam to always throw EBUSY for this manifest path.
			const mock = mockReadForPath(manifestPath, () => makeErrnoError("EBUSY", "resource busy or locked"));
			try {
				const now = t0 + 20 * 60 * 1000;
				const result = purgeStaleActiveRunIndex(STALE, now);

				// Manifest NOT quarantined — still at original path
				assert.ok(fs.existsSync(manifestPath), "ST-6: manifest must NOT be quarantined on EBUSY");

				// No .corrupt-* file created
				const dir = path.dirname(manifestPath);
				const files = fs.readdirSync(dir);
				const corruptFiles = files.filter((f) => f.includes(".corrupt-"));
				assert.equal(corruptFiles.length, 0, "ST-6: no .corrupt-* files on EBUSY");

				// Entry NOT purged (skipped for retry next cycle)
				assert.ok(!result.purged.includes(created.manifest.runId), "ST-6: run must NOT be purged on transient EBUSY error");
			} finally {
				mock.restore();
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 2: EACCES → manifest NOT quarantined (skipped, retried) ───
test("ST-6: EACCES on readFileSync → manifest NOT quarantined (skipped, retried)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-eacces-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "EACCES transient test" });
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			const manifestPath = created.paths.manifestPath;

			const mock = mockReadForPath(manifestPath, () => makeErrnoError("EACCES", "permission denied"));
			try {
				const now = t0 + 20 * 60 * 1000;
				const result = purgeStaleActiveRunIndex(STALE, now);

				assert.ok(fs.existsSync(manifestPath), "ST-6: manifest must NOT be quarantined on EACCES");

				const dir = path.dirname(manifestPath);
				const files = fs.readdirSync(dir);
				const corruptFiles = files.filter((f) => f.includes(".corrupt-"));
				assert.equal(corruptFiles.length, 0, "ST-6: no .corrupt-* files on EACCES");

				assert.ok(!result.purged.includes(created.manifest.runId), "ST-6: run must NOT be purged on transient EACCES error");
			} finally {
				mock.restore();
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 3: SyntaxError → manifest IS quarantined (existing behavior preserved) ───
test("ST-6: SyntaxError (corrupt JSON) → manifest IS quarantined", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-syntax-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "SyntaxError quarantine test" });
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			const manifestPath = created.paths.manifestPath;

			// Corrupt the manifest with invalid JSON (no mock needed — real corrupt file)
			fs.writeFileSync(manifestPath, "{ invalid json !!!");

			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);

			// Manifest IS quarantined (renamed to .corrupt-*)
			assert.ok(!fs.existsSync(manifestPath), "ST-6: corrupt manifest (SyntaxError) must be quarantined");

			const dir = path.dirname(manifestPath);
			const files = fs.readdirSync(dir);
			const corruptFiles = files.filter((f) => f.includes(".corrupt-"));
			assert.ok(corruptFiles.length >= 1, "ST-6: .corrupt-* file must exist for SyntaxError");

			assert.ok(result.purged.includes(created.manifest.runId), "ST-6: genuinely corrupt manifest should be purged (quarantined)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 4: readManifestWithTransientRetry retries EBUSY then succeeds ───
test("ST-6: readManifestWithTransientRetry retries EBUSY and succeeds when transient clears", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-retry-"));
	const tmpFile = path.join(tmpDir, "manifest.json");
	try {
		fs.writeFileSync(tmpFile, JSON.stringify({ status: "running" }));

		const mock = mockReadForPath(tmpFile, () => makeErrnoError("EBUSY", "transient lock"), 2);
		try {
			const result = readManifestWithTransientRetry(tmpFile, 3, 10);
			assert.deepEqual(result, { status: "running" });
			assert.equal(mock.failCount, 2, "should fail twice (EBUSY) before succeeding on 3rd attempt");
		} finally {
			mock.restore();
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── Test 5: readManifestWithTransientRetry throws SyntaxError immediately ───
test("ST-6: readManifestWithTransientRetry throws SyntaxError immediately (no retry)", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-syntax-direct-"));
	const tmpFile = path.join(tmpDir, "manifest.json");
	try {
		fs.writeFileSync(tmpFile, "{ not valid json");

		let callCount = 0;
		const impl = (filePath: string): string => {
			if (filePath === tmpFile) callCount++;
			return fs.readFileSync(filePath, "utf-8");
		};
		_setReadManifestFileSyncForTest(impl);
		try {
			assert.throws(
				() => readManifestWithTransientRetry(tmpFile, 3, 10),
				(err) => err instanceof SyntaxError,
				"should throw SyntaxError on first attempt without retrying",
			);
			assert.equal(callCount, 1, "SyntaxError must not be retried");
		} finally {
			_setReadManifestFileSyncForTest(null);
		}
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── Test 6: sweepStaleCorruptFiles deletes old files, preserves recent ───
test("ST-6: sweepStaleCorruptFiles deletes old .corrupt-* files, preserves recent", () => {
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-sweep-"));
	try {
		const runDir = path.join(runsDir, "test-run-001");
		fs.mkdirSync(runDir, { recursive: true });

		// Create an OLD .corrupt-* file (8 days ago)
		const oldFile = path.join(runDir, "manifest.json.corrupt-old-1234567890-999");
		fs.writeFileSync(oldFile, "corrupt content");
		const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(oldFile, oldTime, oldTime);

		// Create a RECENT .corrupt-* file (1 day ago)
		const recentFile = path.join(runDir, "manifest.json.corrupt-recent-1234567891-888");
		fs.writeFileSync(recentFile, "corrupt content");
		const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
		fs.utimesSync(recentFile, recentTime, recentTime);

		// Create a regular file (not .corrupt-*) — must NOT be touched
		const regularFile = path.join(runDir, "manifest.json");
		fs.writeFileSync(regularFile, "{}");

		// Sweep with default TTL (7 days)
		const deleted = sweepStaleCorruptFiles(runsDir);

		assert.equal(deleted, 1, "only the old .corrupt-* file should be deleted");
		assert.ok(!fs.existsSync(oldFile), "old .corrupt-* file should be deleted");
		assert.ok(fs.existsSync(recentFile), "recent .corrupt-* file should be preserved");
		assert.ok(fs.existsSync(regularFile), "regular manifest.json should NOT be touched");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ─── Test 7: sweepStaleCorruptFiles respects custom threshold ───
test("ST-6: sweepStaleCorruptFiles respects custom maxAgeMs", () => {
	const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st6-sweep-custom-"));
	try {
		const runDir = path.join(runsDir, "test-run-002");
		fs.mkdirSync(runDir, { recursive: true });

		// Create a moderately old .corrupt-* file (2 hours ago)
		const file = path.join(runDir, "manifest.json.corrupt-mid-1234567892-777");
		fs.writeFileSync(file, "corrupt content");
		const fileTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(file, fileTime, fileTime);

		// With 1-hour threshold → file is stale (2 hours old)
		const deleted1 = sweepStaleCorruptFiles(runsDir, 1 * 60 * 60 * 1000);
		assert.equal(deleted1, 1, "file older than 1h threshold should be deleted");
		assert.ok(!fs.existsSync(file), "moderately old file should be deleted with short threshold");

		// Recreate and test with 3-hour threshold → file survives
		fs.writeFileSync(file, "corrupt content");
		fs.utimesSync(file, fileTime, fileTime);
		const deleted2 = sweepStaleCorruptFiles(runsDir, 3 * 60 * 60 * 1000);
		assert.equal(deleted2, 0, "file younger than 3h threshold should survive");
		assert.ok(fs.existsSync(file), "moderately old file should survive with long threshold");
	} finally {
		fs.rmSync(runsDir, { recursive: true, force: true });
	}
});

// ─── Test 8: sweepStaleCorruptFiles handles non-existent directory ───
test("ST-6: sweepStaleCorruptFiles returns 0 for non-existent directory", () => {
	const deleted = sweepStaleCorruptFiles(path.join(os.tmpdir(), "pi-crew-nonexistent-sweep-dir-xyz"));
	assert.equal(deleted, 0, "non-existent directory should return 0 deletions");
});
