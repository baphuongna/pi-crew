/**
 * run-state-layout-parity.test.ts — RR-020 Fix 3 regression (both layouts).
 *
 * `.pi/teams` is a SUPPORTED crew-root layout (projectCrewRoot picks it when a
 * project has `.pi/` but no `.crew/`). Every /tmp debris scanner used to probe
 * ONLY `<dir>/.crew`, so a temp workspace holding live `.pi/teams/state/runs`
 * state was invisible to the reconciler/zombie scanners AND deleted as debris by
 * cleanupLegacyOrphanTempDirs after the 24h age threshold.
 *
 * The three scanners must agree on the layout predicate:
 *   - cleanupLegacyOrphanTempDirs  (src/runtime/model/pi-args.ts)
 *   - reconcileOrphanedTempWorkspaces (src/runtime/stale-reconciler.ts)
 *   - scanZombieTempWorkspaces / collectTempWorkspaceRuns
 *                                     (src/extension/team-tool/health-monitor.ts)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { scanZombieTempWorkspaces } from "../../src/extension/team-tool/health-monitor.ts";
import { cleanupLegacyOrphanTempDirs } from "../../src/runtime/model/pi-args.ts";
import { findRunStateDir, hasRunStateLayout } from "../../src/utils/paths.ts";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function touchDir(dir: string, ageMs: number): void {
	fs.mkdirSync(dir, { recursive: true });
	const when = new Date(Date.now() - ageMs);
	fs.utimesSync(dir, when, when);
}

/** Create `<dir>/<layout>/state/runs/<runId>/manifest.json`. */
function seedRun(dir: string, layout: string, runId: string, status = "running"): void {
	const runDir = path.join(dir, layout, "state", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ runId, status }), "utf-8");
}

const HOUR = 60 * 60 * 1000;

// ── predicate ─────────────────────────────────────────────────────────────

test("hasRunStateLayout: true for BOTH `.crew` and `.pi/teams`; false for neither", () => {
	const base = mkdtemp("pi-crew-layout-pred-");
	try {
		const crewOnly = path.join(base, "crew-only");
		fs.mkdirSync(path.join(crewOnly, ".crew"), { recursive: true });
		const piOnly = path.join(base, "pi-only");
		fs.mkdirSync(path.join(piOnly, ".pi", "teams"), { recursive: true });
		const neither = path.join(base, "neither");
		fs.mkdirSync(neither, { recursive: true });

		assert.equal(hasRunStateLayout(crewOnly), true, "`.crew` layout recognised");
		assert.equal(hasRunStateLayout(piOnly), true, "`.pi/teams` layout recognised");
		assert.equal(hasRunStateLayout(neither), false, "no layout ⇒ false");
	} finally {
		rmrf(base);
	}
});

test("hasRunStateLayout: a SYMLINKED layout dir does not count (planted-symlink guard)", () => {
	const base = mkdtemp("pi-crew-layout-symlink-");
	try {
		const dir = path.join(base, "planted");
		fs.mkdirSync(dir, { recursive: true });
		fs.symlinkSync(path.join(base, "elsewhere"), path.join(dir, ".crew"));
		assert.equal(hasRunStateLayout(dir), false, "symlinked .crew must NOT protect the dir");
	} finally {
		rmrf(base);
	}
});

test("findRunStateDir: resolves the layout that actually holds state/runs", () => {
	const base = mkdtemp("pi-crew-layout-resolve-");
	try {
		const crewDir = path.join(base, "c");
		seedRun(crewDir, ".crew", "run_c");
		const piDir = path.join(base, "p");
		seedRun(piDir, path.join(".pi", "teams"), "run_p");
		const empty = path.join(base, "e");
		fs.mkdirSync(empty, { recursive: true });

		assert.equal(findRunStateDir(crewDir), path.join(crewDir, ".crew", "state", "runs"));
		assert.equal(findRunStateDir(piDir), path.join(piDir, ".pi", "teams", "state", "runs"));
		assert.equal(findRunStateDir(empty), undefined);
	} finally {
		rmrf(base);
	}
});

// ── cleanupLegacyOrphanTempDirs ───────────────────────────────────────────

test("cleanupLegacyOrphanTempDirs: preserves BOTH layouts, cleans only the bare old dir", () => {
	const base = mkdtemp("pi-crew-layout-legacy-");
	const now = Date.now();
	try {
		const bare = path.join(base, "pi-crew-111-bare");
		touchDir(bare, 25 * HOUR);

		const withCrew = path.join(base, "pi-crew-222-crew");
		seedRun(withCrew, ".crew", "run_a");
		touchDir(withCrew, 25 * HOUR);

		const withPiTeams = path.join(base, "pi-crew-333-piteams");
		seedRun(withPiTeams, path.join(".pi", "teams"), "run_b");
		touchDir(withPiTeams, 25 * HOUR);

		const result = cleanupLegacyOrphanTempDirs(now, base);
		assert.equal(result.scanned, 3);
		assert.equal(result.cleaned, 1, "only the bare old dir is debris");
		assert.ok(!fs.existsSync(bare), "bare old dir removed");
		assert.ok(fs.existsSync(withCrew), "`.crew` workspace preserved");
		assert.ok(fs.existsSync(withPiTeams), "`.pi/teams` workspace preserved (RR-020 Fix 3)");
	} finally {
		rmrf(base);
	}
});

// ── scanZombieTempWorkspaces ──────────────────────────────────────────────

test("scanZombieTempWorkspaces: sees `.pi/teams` run state as a zombie (was invisible)", () => {
	const base = mkdtemp("pi-crew-layout-zombie-");
	const now = Date.now();
	try {
		seedRun(path.join(base, "pi-crew-aaa-crew"), ".crew", "run_a");
		seedRun(path.join(base, "pi-crew-bbb-piteams"), path.join(".pi", "teams"), "run_b");
		fs.mkdirSync(path.join(base, "pi-crew-ccc-empty"), { recursive: true });

		const zombies = scanZombieTempWorkspaces(base, now);
		const names = zombies.map((z) => path.basename(z.dir)).sort();
		assert.deepEqual(names, ["pi-crew-aaa-crew", "pi-crew-bbb-piteams"]);
		assert.equal(zombies.find((z) => path.basename(z.dir) === "pi-crew-bbb-piteams")?.runCount, 1);
	} finally {
		rmrf(base);
	}
});

// ── RR-020 cold-verify correction: findRunStateDir must reject symlinks ────
// The first version used existsSync (FOLLOWS symlinks) — a planted `.crew` or
// `.pi/teams` symlink let stale-reconciler / health-monitor read (and the
// reconciler even MUTATE) run manifests OUTSIDE the scanned tree. Both the
// layout dir and the runs dir must be symlink-free, matching hasRunStateLayout.

test("findRunStateDir: a planted layout-dir SYMLINK is rejected (no out-of-tree reads)", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym1-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-state");
		fs.mkdirSync(ws, { recursive: true });
		fs.mkdirSync(path.join(outside, "state", "runs", "run_x"), { recursive: true });
		fs.symlinkSync(outside, path.join(ws, ".crew"));

		assert.equal(hasRunStateLayout(ws), false, "hasRunStateLayout rejects the symlinked layout");
		assert.equal(findRunStateDir(ws), undefined, "findRunStateDir must not resolve through the symlink");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("findRunStateDir: a symlinked `state/runs` dir is rejected even under a real layout dir", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym2-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-runs");
		fs.mkdirSync(path.join(ws, ".crew", "state"), { recursive: true });
		fs.mkdirSync(path.join(outside, "run_y"), { recursive: true });
		fs.symlinkSync(outside, path.join(ws, ".crew", "state", "runs"));

		assert.equal(hasRunStateLayout(ws), true, "layout dir itself is real ⇒ protected from debris sweep");
		assert.equal(findRunStateDir(ws), undefined, "but manifest reads must not follow the runs symlink");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("findRunStateDir: real `.pi/teams` layout still resolves after the symlink hardening", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym3-"));
	try {
		const ws = path.join(parent, "ws");
		fs.mkdirSync(path.join(ws, ".pi", "teams", "state", "runs"), { recursive: true });
		assert.equal(findRunStateDir(ws), path.join(ws, ".pi", "teams", "state", "runs"));
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── Cold-verify F-A: MIDDLE-component symlink (`.crew/state`) bypass ────────
// existsNoSymlink lstats only the FINAL path component, so a symlink at the
// middle `state` component was traversed transparently — scanners read AND
// wrote run manifests outside the scanned tree until every intermediate
// component was checked too.

test("findRunStateDir: a MIDDLE `.crew/state` symlink is rejected (no out-of-tree read/write)", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym4-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-state");
		fs.mkdirSync(path.join(ws, ".crew"), { recursive: true }); // layout dir is REAL
		fs.mkdirSync(path.join(outside, "runs", "run_x"), { recursive: true });
		fs.symlinkSync(outside, path.join(ws, ".crew", "state")); // middle component

		assert.equal(findRunStateDir(ws), undefined, "must not resolve through the middle symlink");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

test("findRunStateDir: a MIDDLE `.pi/teams/state` symlink is rejected too", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym5-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-state2");
		fs.mkdirSync(path.join(ws, ".pi", "teams"), { recursive: true });
		fs.mkdirSync(path.join(outside, "runs", "run_y"), { recursive: true });
		fs.symlinkSync(outside, path.join(ws, ".pi", "teams", "state"));

		assert.equal(findRunStateDir(ws), undefined);
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── Cold-verify F-1: `.pi` layout COMPONENT symlink (intermediate in every
// lstat of the earlier fix — lstat only sees the final path component) ──────
test("findRunStateDir: a `.pi` component symlink is rejected (F-1, .pi/teams layout)", () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym6-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-pi");
		fs.mkdirSync(ws, { recursive: true });
		// outside tree looks like a complete .pi/teams layout
		fs.mkdirSync(path.join(outside, "teams", "state", "runs", "run_z"), { recursive: true });
		fs.symlinkSync(outside, path.join(ws, ".pi")); // `.pi` itself is the symlink

		assert.equal(hasRunStateLayout(ws), false, "hasRunStateLayout must reject the .pi component symlink");
		assert.equal(findRunStateDir(ws), undefined, "findRunStateDir must not resolve through it");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── Cold-verify F-2: grandchild `state/runs/<runId>` symlink is followed by
// the scanner loops (only `runs` itself was lstat'ed) ───────────────────────
test("scanner run loops: a symlinked `<runId>` entry is skipped (F-2)", async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-sym7-"));
	try {
		const ws = path.join(parent, "ws");
		const outside = path.join(parent, "outside-run");
		fs.mkdirSync(path.join(ws, ".crew", "state", "runs"), { recursive: true });
		// a REAL run dir and a symlinked one pointing outside
		for (const d of ["run_real"]) {
			fs.mkdirSync(path.join(ws, ".crew", "state", "runs", d), { recursive: true });
			fs.writeFileSync(path.join(ws, ".crew", "state", "runs", d, "manifest.json"), JSON.stringify({ runId: d }));
		}
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ runId: "run_symlinked" }));
		fs.symlinkSync(outside, path.join(ws, ".crew", "state", "runs", "run_symlinked"));

		const stateRunsDir = findRunStateDir(ws);
		assert.ok(stateRunsDir, "layout itself is real and resolves");
		const fsMod = await import("node:fs");
		const entries = fsMod.readdirSync(stateRunsDir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
		assert.deepEqual(dirs, ["run_real"], "Dirent.isDirectory() must exclude the symlinked run dir");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── Cold-verify F-2 (scanner level): the REAL reconciler must not WRITE
// through a symlinked `runs/<runId>` entry. Drives the production function
// with an injected tmpDir; asserts the OUTSIDE manifest is untouched.
test("reconcileOrphanedTempWorkspaces: symlinked runId entry ⇒ NO out-of-tree write (F-2, real scanner)", async () => {
	const { reconcileOrphanedTempWorkspaces } = await import("../../src/runtime/stale-reconciler.ts");
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-f2-"));
	try {
		const tmpScanRoot = path.join(parent, "scanroot");
		const ws = path.join(tmpScanRoot, "pi-crew-ws");
		const outside = path.join(parent, "outside-run");
		fs.mkdirSync(path.join(ws, ".crew", "state", "runs"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		fs.writeFileSync(
			path.join(outside, "manifest.json"),
			JSON.stringify({ runId: "run_symlinked", status: "running", updatedAt: twoHoursAgo, cwd: outside, tasks: [] }),
		);
		// One RUNNING task with a STALE heartbeat (>5min, no PID on the manifest)
		// is what actually triggers the no-pid allStale repair path — without it
		// reconcileStaleRun returns "not stale enough" and the test cannot tell a
		// following reconciler from a skipping one.
		fs.writeFileSync(
			path.join(outside, "tasks.json"),
			JSON.stringify([
				{
					id: "01_explore",
					runId: "run_symlinked",
					role: "explorer",
					agent: "explorer",
					title: "01_explore",
					status: "running",
					dependsOn: [],
					cwd: outside,
					heartbeat: { lastSeenAt: twoHoursAgo },
				},
			]),
		);
		// symlinked run dir points OUTSIDE the scanned tree
		fs.symlinkSync(outside, path.join(ws, ".crew", "state", "runs", "run_symlinked"));
		const before = fs.readFileSync(path.join(outside, "manifest.json"), "utf-8");
		const mtimeBefore = fs.statSync(path.join(outside, "manifest.json")).mtimeMs;

		const result = reconcileOrphanedTempWorkspaces(Date.now(), { tmpDir: tmpScanRoot, cleanupOrphanedTempDirs: false });

		assert.equal(result.repaired, 0, "symlinked run must not be reconciled");
		assert.equal(fs.readFileSync(path.join(outside, "manifest.json"), "utf-8"), before, "outside manifest content must be untouched");
		assert.equal(fs.statSync(path.join(outside, "manifest.json")).mtimeMs, mtimeBefore, "outside manifest mtime must be untouched");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

// ── Cold-verify round 5 (E1): quarantine-rename wrote OUTSIDE the tree ─────
// The pre-deletion gates used string readdir, so a symlinked `<runId>` entry
// was followed; loadManifestWithRecovery on the CORRUPT outside manifest then
// ran quarantineCorruptFile = renameSync — which resolves through the
// symlinked dir and renamed the outside file (manifest.json → .corrupt-*).
// Fired by the production tempReconcileTimer; reproduced even with
// cleanupOrphanedTempDirs:false. The gates now use Dirent.isDirectory().
test("reconcile gates: corrupt manifest behind a symlinked runId ⇒ NO out-of-tree rename (E1)", async () => {
	const { reconcileOrphanedTempWorkspaces } = await import("../../src/runtime/stale-reconciler.ts");
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rsl-e1-"));
	try {
		const scanRoot = path.join(parent, "scanroot");
		const ws = path.join(scanRoot, "pi-crew-ws");
		const outside = path.join(parent, "outside-run");
		fs.mkdirSync(path.join(ws, ".crew", "state", "runs"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "manifest.json"), "{ this is NOT valid json"); // corrupt
		fs.writeFileSync(path.join(outside, "precious.dat"), "do not touch");
		fs.symlinkSync(outside, path.join(ws, ".crew", "state", "runs", "run_x"));

		// cleanup=true forces BOTH gates (:720 and :746) to run; age the
		// workspace past ORPHAN_TEMP_DIR_AGE_THRESHOLD_MS so deletion is eligible.
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(ws, old, old);

		const result = reconcileOrphanedTempWorkspaces(Date.now(), { tmpDir: scanRoot, cleanupOrphanedTempDirs: true });

		const entries = fs.readdirSync(outside);
		assert.ok(entries.includes("manifest.json"), `outside manifest.json must keep its name (got: ${entries.join(",")})`);
		assert.equal(
			entries.some((e) => e.startsWith("manifest.json.corrupt-")),
			false,
			"no out-of-tree quarantine rename",
		);
		assert.equal(entries.includes("precious.dat"), true, "outside data intact");
		// workspace deletion itself is fine (rmSync unlinks the symlink):
		// whether it was deleted depends on gate outcome, not asserted here.
		assert.equal(typeof result.cleanedDirs, "number");
	} finally {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});
