/**
 * T12 — doctor orphan surface-pane cleanup.
 *
 * Two orphan sources (spec §12.3 + T11 residual):
 *  1. zombie scan: a sub-agent whose crew parent died while carrying
 *     PI_CREW_SURFACE/PI_CREW_SURFACE_PANE — the pane outlived its host.
 *  2. run manifests: a TERMINAL run whose manifest.surface.panes still has
 *     entries (host died before releaseSurfacePane) — those panes hold the
 *     live-pane cap hostage until the end of the run (T11 residual note).
 *
 * Doctor closes both through provider.closeSurface. Providers are injectable;
 * production resolves the singleton and only closes when detect() says the mux
 * is alive — otherwise panes are listed without any close attempt.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { cleanupOrphanSurfacePanes, formatOrphanPaneReport } from "../../../../src/extension/team-tool/doctor.ts";
import type { ZombieScanResult, ZombieSubagent } from "../../../../src/runtime/process/zombie-scanner.ts";
import { LAUNCH_SCRIPT_TTL_MS } from "../../../../src/runtime/surface/launch-script.ts";
import type { SurfaceHandle, SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";

function fakeSurfaceProvider(
	kind: "tmux" | "herdr",
	opts: { detectOk?: boolean } = {},
): {
	provider: SurfaceProvider;
	closed: string[];
	attached: string[];
} {
	const closed: string[] = [];
	const attached: string[] = [];
	const provider: SurfaceProvider = {
		kind,
		detect: () => (opts.detectOk === false ? { ok: false, reason: "mux not available" } : { ok: true, kind }),
		createSurface: async () => {
			throw new Error("doctor cleanup must never create surfaces");
		},
		attach: (id: string): SurfaceHandle | null => {
			attached.push(id);
			return { id, kind, onExit: () => undefined, dispose: () => undefined };
		},
		readScreen: async () => "",
		closeSurface: async (handle: SurfaceHandle) => {
			closed.push(handle.id);
		},
	};
	return { provider, closed, attached };
}

function surfaceZombie(pid: number, paneId: string, surface: "tmux" | "herdr" = "tmux"): ZombieSubagent {
	return {
		pid,
		ppid: 1,
		crewParentPid: pid - 1000,
		parentAlive: false,
		role: "executor",
		surface,
		surfacePaneId: paneId,
		rssKb: 1024,
		elapsedSec: 300,
		cmd: "pi --mode json -p task",
	};
}

function emptyScanWith(zombies: ZombieSubagent[]): ZombieScanResult {
	return { zombies, live: [], errors: [] };
}

/** Minimal project layout with one run dir + manifest.json. */
function writeRunManifest(cwd: string, runId: string, manifest: Record<string, unknown>): string {
	const runDir = path.join(cwd, ".crew", "state", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
	return runDir;
}

function terminalManifest(panes: Record<string, string>, provider: "tmux" | "herdr" = "tmux"): Record<string, unknown> {
	return {
		runId: "run-x",
		status: "completed",
		surface: { provider, panes },
	};
}

test("cleanupOrphanSurfacePanes: closes zombie-scan panes through the matching provider", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const tmux = fakeSurfaceProvider("tmux");
	const herdr = fakeSurfaceProvider("herdr");
	try {
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([surfaceZombie(100, "%12", "tmux"), surfaceZombie(200, "h:7", "herdr")]),
			deps: { providers: { tmux: tmux.provider, herdr: herdr.provider }, runScanLimit: 0 },
		});
		assert.deepEqual(tmux.closed, ["%12"], "tmux zombie pane must be closed via tmux provider");
		assert.deepEqual(herdr.closed, ["h:7"], "herdr zombie pane must be closed via herdr provider");
		assert.equal(out.closed.length, 2);
		assert.equal(out.orphans.length, 2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: terminal-run manifest panes are closed, active-run panes are not", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const tmux = fakeSurfaceProvider("tmux");
	try {
		writeRunManifest(cwd, "run-terminal", terminalManifest({ t1: "%5", t2: "%6" }));
		writeRunManifest(cwd, "run-active", { ...terminalManifest({ t3: "%9" }), status: "running" });
		writeRunManifest(cwd, "run-queued", { ...terminalManifest({ t4: "%10" }), status: "queued" });
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: tmux.provider } },
		});
		assert.deepEqual([...tmux.closed].sort(), ["%5", "%6"], "only TERMINAL run panes may be closed — active runs still own theirs");
		assert.equal(out.orphans.length, 2, "active-run panes must not even be listed as orphans");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: same pane from both sources is deduped to one close", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const tmux = fakeSurfaceProvider("tmux");
	try {
		writeRunManifest(cwd, "run-terminal", terminalManifest({ t1: "%12" }));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([surfaceZombie(100, "%12")]),
			deps: { providers: { tmux: tmux.provider } },
		});
		assert.deepEqual(tmux.closed, ["%12"], "pane reachable from scan AND manifest closes exactly once");
		assert.equal(out.orphans.length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: undetected provider lists panes without closing", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const tmux = fakeSurfaceProvider("tmux", { detectOk: false });
	try {
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([surfaceZombie(100, "%12")]),
			deps: { providers: { tmux: tmux.provider }, runScanLimit: 0 },
		});
		assert.deepEqual(tmux.closed, [], "detect() failure must downgrade to list-only — never close blind");
		assert.equal(out.orphans.length, 1, "orphan is still listed for the human");
		assert.equal(out.failures.length, 0);
		assert.ok(
			out.providerNotes.some((note) => note.includes("tmux")),
			"note explains which provider was unavailable",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: attach() miss counts as gone, not failure", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const closed: string[] = [];
	const provider: SurfaceProvider = {
		kind: "tmux",
		detect: () => ({ ok: true, kind: "tmux" }),
		createSurface: async () => {
			throw new Error("unused");
		},
		attach: () => null, // pane already dead — mux does not know it
		readScreen: async () => "",
		closeSurface: async (handle) => {
			closed.push(handle.id);
		},
	};
	try {
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([surfaceZombie(100, "%12")]),
			deps: { providers: { tmux: provider }, runScanLimit: 0 },
		});
		assert.deepEqual(closed, []);
		assert.deepEqual(out.gone, ["%12"], "pane not found in mux is reported gone, not failed");
		assert.equal(out.failures.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: closeSurface throw is recorded as failure, scan continues", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const provider: SurfaceProvider = {
		kind: "tmux",
		detect: () => ({ ok: true, kind: "tmux" }),
		createSurface: async () => {
			throw new Error("unused");
		},
		attach: (id) => ({ id, kind: "tmux", onExit: () => undefined, dispose: () => undefined }),
		readScreen: async () => "",
		closeSurface: async (handle) => {
			if (handle.id === "%12") throw new Error("mux refused");
		},
	};
	try {
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([surfaceZombie(100, "%12"), surfaceZombie(101, "%13")]),
			deps: { providers: { tmux: provider }, runScanLimit: 0 },
		});
		assert.equal(out.failures.length, 1);
		assert.equal(out.failures[0]?.paneId, "%12");
		assert.deepEqual(out.closed, ["%13"], "a failing close must not abort the remaining panes");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("cleanupOrphanSurfacePanes: orphan launch scripts older than TTL are swept from disk", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-orphan-"));
	const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-launch-"));
	const now = Date.now();
	try {
		const stale = path.join(tempBase, `pi-crew-launch-t1-${process.pid}.sh`);
		const fresh = path.join(tempBase, `pi-crew-launch-t2-${process.pid}.sh`);
		fs.writeFileSync(stale, "#!/bin/bash\n");
		fs.writeFileSync(fresh, "#!/bin/bash\n");
		// Stale: mtime older than the 60s TTL. Fresh: mtime now.
		fs.utimesSync(stale, new Date(now - LAUNCH_SCRIPT_TTL_MS - 5000), new Date(now - LAUNCH_SCRIPT_TTL_MS - 5000));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: {}, tempBase, now: () => now, runScanLimit: 0 },
		});
		assert.equal(out.scriptsSwept, 1, "only the past-TTL script is swept");
		assert.ok(!fs.existsSync(stale), "stale launch script removed from disk");
		assert.ok(fs.existsSync(fresh), "in-flight launch script preserved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(tempBase, { recursive: true, force: true });
	}
});

test("formatOrphanPaneReport: renders pane ids, providers, and close outcomes", () => {
	const text = formatOrphanPaneReport({
		orphans: [
			{ paneId: "%12", kind: "tmux", source: "zombie-scan pid 100" },
			{ paneId: "%5", kind: "tmux", source: "run run-terminal task t1 (terminal)" },
		],
		closed: ["%12"],
		gone: [],
		failures: [{ paneId: "%5", error: "mux refused" }],
		scriptsSwept: 2,
		providerNotes: [],
	});
	assert.match(text, /%12/);
	assert.match(text, /%5/);
	assert.match(text, /zombie-scan pid 100/);
	assert.match(text, /mux refused/);
});
