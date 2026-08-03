/**
 * R-01 regression tests: corrupt/missing manifests must NOT cause total data loss.
 *
 * BEFORE FIX: `purgeStaleActiveRunIndex` called `tryRemoveRunDirectories(entry)`
 * (fs.rmSync(stateRoot, {recursive, force})) whenever:
 *   - JSON.parse(manifest) threw (single corrupt byte), OR
 *   - the manifest file was missing, OR
 *   - the cwd directory was missing.
 * This deleted the ENTIRE run state — events.jsonl, task data, artifacts —
 * making manual recovery impossible.
 *
 * AFTER FIX (R-01):
 *   - Corrupt manifests are quarantined (renamed to `.corrupt-<timestamp>`)
 *     and the stateRoot is PRESERVED.
 *   - Missing-manifest / missing-CWD entries require corroboration (stateRoot
 *     already gone) before any deletion; otherwise stateRoot is preserved.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { purgeStaleActiveRunIndex } from "../../src/runtime/recovery/crash-recovery.ts";
import { registerActiveRun } from "../../src/state/stores/active-run-registry.ts";
import { createRunManifest, saveRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "quarantine",
	description: "quarantine",
	source: "builtin",
	filePath: "quarantine.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "quarantine",
	description: "quarantine",
	source: "builtin",
	filePath: "quarantine.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

const STALE = 5 * 60 * 1000; // 5 min, matching purgeStaleActiveRunIndex default

// ─── Test 1: Corrupt manifest byte → quarantine, NOT delete ───
test("R-01: corrupt manifest is quarantined and stateRoot is preserved (no data loss)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-corrupt-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			// 1. Create a valid run with events.jsonl on disk.
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "corrupt-manifest test" });
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			const stateRoot = created.paths.stateRoot;
			const manifestPath = created.paths.manifestPath;
			const eventsPath = created.manifest.eventsPath;

			// Write an events.jsonl so we can assert it survives.
			fs.writeFileSync(eventsPath, '{"type":"crew.run.started"}\n');

			assert.ok(fs.existsSync(manifestPath), "manifest.json exists before purge");
			assert.ok(fs.existsSync(eventsPath), "events.jsonl exists before purge");

			// 2. Corrupt the manifest with a single bad byte (insert \x00 at position 5).
			const original = fs.readFileSync(manifestPath);
			const corrupt = Buffer.concat([original.subarray(0, 5), Buffer.from([0x00]), original.subarray(5)]);
			fs.writeFileSync(manifestPath, corrupt);

			// 3. Purge with `now` far enough in the future to be considered stale.
			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(created.manifest.runId), "corrupt-manifest run should leave the active index");

			// (a) events.jsonl still EXISTS
			assert.ok(fs.existsSync(eventsPath), "R-01: events.jsonl must NOT be deleted when manifest is corrupt");

			// (b) a .corrupt-<timestamp> file exists
			const dir = path.dirname(manifestPath);
			const files = fs.readdirSync(dir);
			const corruptFiles = files.filter((f) => f.includes(".corrupt-"));
			assert.ok(corruptFiles.length >= 1, "R-01: corrupt manifest must be quarantined to a .corrupt-<timestamp> file");

			// (c) stateRoot dir still EXISTS
			assert.ok(fs.existsSync(stateRoot), "R-01: stateRoot must be preserved for manual recovery");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 2: Valid terminal manifest → unregister, NOT delete ───
test("R-01: terminal-status manifest unregisters without deleting stateRoot", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-terminal-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "terminal manifest test" });
			// Register as running first (the registry rejects terminal-status entries).
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			// Now flip the on-disk manifest to terminal status (without re-registering).
			const terminal = { ...running, status: "completed" as const };
			saveRunManifest(terminal);

			const stateRoot = created.paths.stateRoot;

			assert.ok(fs.existsSync(stateRoot), "stateRoot exists before purge");

			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(created.manifest.runId), "terminal run should be unregistered");
			assert.ok(fs.existsSync(stateRoot), "R-01: terminal run stateRoot must NOT be deleted (just unregistered)");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 3: Missing manifest file → unregister but preserve stateRoot ───
test("R-01: missing manifest file unregisters but preserves stateRoot (dual-signal guard)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-missing-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "missing-manifest test" });
			const running = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date(t0).toISOString(),
			};
			saveRunManifest(running);
			registerActiveRun(running);

			const stateRoot = created.paths.stateRoot;
			const manifestPath = created.paths.manifestPath;
			const eventsPath = created.manifest.eventsPath;

			// Write events.jsonl so we can verify it survives.
			fs.writeFileSync(eventsPath, '{"type":"crew.run.started"}\n');

			// Delete ONLY the manifest file — stateRoot and events.jsonl remain.
			fs.rmSync(manifestPath);

			assert.ok(!fs.existsSync(manifestPath), "manifest.json removed for test");
			assert.ok(fs.existsSync(stateRoot), "stateRoot exists before purge");
			assert.ok(fs.existsSync(eventsPath), "events.jsonl exists before purge");

			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(created.manifest.runId), "missing-manifest run should be unregistered");
			// R-01: stateRoot must be preserved — a single missing-file signal is insufficient.
			assert.ok(fs.existsSync(stateRoot), "R-01: stateRoot must be preserved when only manifest is missing");
			assert.ok(fs.existsSync(eventsPath), "R-01: events.jsonl must survive missing-manifest purge");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 4: Missing CWD → unregister but preserve stateRoot (step-2 guard) ───
test("R-01: missing CWD unregisters but preserves stateRoot (dual-signal guard, step 2)", async () => {
	await withIsolatedHomeAsync(async () => {
		// stateRoot must OUTLIVE cwd for this test. The registry validates
		// basename(stateRoot) === runId and manifestPath === stateRoot/manifest.json,
		// so we create a persistent stateRoot named after runId OUTSIDE cwd, then
		// delete only cwd. This exercises purge step 2 (cwd gone) while step 1
		// (manifest gone) does NOT fire (manifest survives at persistent path).
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-cwd-"));
		const stateParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-quarantine-stateparent-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "missing-cwd test" });
			const runId = created.manifest.runId;
			const persistentStateRoot = path.join(stateParent, runId);
			fs.mkdirSync(persistentStateRoot, { recursive: true });
			const eventsPath = path.join(persistentStateRoot, "events.jsonl");
			fs.writeFileSync(eventsPath, '{"type":"crew.run.started"}\n');
			const running = {
				...created.manifest,
				status: "running" as const,
				stateRoot: persistentStateRoot,
				eventsPath,
				updatedAt: new Date(t0).toISOString(),
			} as typeof created.manifest;
			saveRunManifest(running);
			registerActiveRun(running);

			// Sanity: manifest exists at the persistent path; cwd still present.
			assert.ok(fs.existsSync(path.join(persistentStateRoot, "manifest.json")), "manifest at persistent stateRoot");
			assert.ok(fs.existsSync(cwd), "cwd exists before deletion");

			// Delete ONLY cwd — persistent stateRoot (outside cwd) survives.
			fs.rmSync(cwd, { recursive: true, force: true });
			assert.ok(!fs.existsSync(cwd), "cwd removed for test");
			assert.ok(fs.existsSync(persistentStateRoot), "stateRoot survived cwd deletion");

			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(runId), "missing-cwd run should be unregistered");
			// R-01 step-2 dual-signal: cwd gone but stateRoot exists → preserve.
			assert.ok(fs.existsSync(persistentStateRoot), "R-01: stateRoot must be preserved when cwd missing but stateRoot exists");
			assert.ok(fs.existsSync(eventsPath), "R-01: events.jsonl must survive missing-cwd purge");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
			fs.rmSync(stateParent, { recursive: true, force: true });
		}
	});
});
