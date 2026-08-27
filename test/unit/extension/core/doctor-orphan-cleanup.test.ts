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

/** Terminal manifest với surface.tabs (tab-layout Task 5 shape) — panes rỗng để tách tín hiệu. */
function tabbedTerminalManifest(tabs: Record<string, string[]>, provider: "tmux" | "herdr" = "tmux"): Record<string, unknown> {
	return { runId: "run-x", status: "completed", surface: { provider, panes: {}, tabs } };
}

function readBackTabs(cwd: string, runId: string): Record<string, string[]> {
	const manifest = JSON.parse(fs.readFileSync(path.join(cwd, ".crew", "state", "runs", runId, "manifest.json"), "utf-8")) as {
		surface?: { tabs?: Record<string, string[]> };
	};
	return manifest.surface?.tabs ?? {};
}

/**
 * Provider có closeTabById (Task 6): doctor chạy ở process KHÁC host đã spawn
 * nên KHÔNG được dùng closeTab(tabKey) (map nội bộ trống ở doctor process) —
 * test spy đường close-by-ID. Outcome per tabId: "closed" | "gone" | Error.
 */
function fakeTabCleanupProvider(
	kind: "tmux" | "herdr",
	outcomes: Record<string, "closed" | "gone" | Error>,
): {
	provider: SurfaceProvider;
	closeByIdCalls: string[];
} {
	const closeByIdCalls: string[] = [];
	const provider: SurfaceProvider = {
		kind,
		detect: () => ({ ok: true, kind }),
		createSurface: async () => {
			throw new Error("doctor cleanup must never create surfaces");
		},
		attach: () => null,
		readScreen: async () => "",
		closeSurface: async () => {
			// no-op — panes rỗng trong các fixture tab; không có gì để đóng.
		},
		closeTabById: async (tabId: string) => {
			closeByIdCalls.push(tabId);
			const outcome = outcomes[tabId] ?? "closed";
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	};
	return { provider, closeByIdCalls };
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

// ── Task 6 (tab-layout): orphan RUN TAB cleanup trên terminal runs ──────────
//
// Doctor chạy ở TIẾN TRÌNH KHÁC host đã spawn tab: map nội bộ tabKey của
// provider (closeTab) sống ở process host nên luôn trống ở doctor → doctor
// phải đóng theo tabId TRỰC TIẾP lấy từ manifest.surface.tabs. Manifest trên
// đĩa GIỮ tabIds sau run end (evidence, by-design Task 5) nên "tabs non-empty"
// KHÔNG tự đồng nghĩa orphan — liveness lấy từ chính mux qua close-by-ID
// idempotent ("closed" | "gone"), chỉ clear entry khi mux đã xác nhận.

test("Task 6: run terminal có surface.tabs → closeTabById từng tabId (KHÔNG closeTab theo tabKey) + clear entry trên đĩa", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const tab = fakeTabCleanupProvider("tmux", {});
	try {
		writeRunManifest(cwd, "run-terminal", tabbedTerminalManifest({ team_A: ["w1", "w2"] }));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: tab.provider } },
		});
		assert.deepEqual(tab.closeByIdCalls, ["w1", "w2"], "doctor đóng theo tabId trực tiếp từ manifest");
		assert.deepEqual(out.tabsClosed, ["w1", "w2"]);
		assert.deepEqual(readBackTabs(cwd, "run-terminal").team_A, [], "entry cleared (giữ key rỗng) — cùng shape closeTabForRun");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task 6: tab đã chết từ trước (mux trả gone) → reported gone, không failure, entry vẫn cleared", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const tab = fakeTabCleanupProvider("herdr", { "w2:t1": "gone" });
	try {
		writeRunManifest(cwd, "run-terminal", tabbedTerminalManifest({ team_A: ["w2:t1"] }, "herdr"));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { herdr: tab.provider } },
		});
		assert.deepEqual(out.tabsGone, ["w2:t1"]);
		assert.deepEqual(out.tabsClosed, []);
		assert.equal(out.tabFailures.length, 0, "tab mux không còn biết là 'gone', không phải failure");
		assert.deepEqual(readBackTabs(cwd, "run-terminal").team_A, []);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task 6: run KHÔNG terminal (running) giữ nguyên tabs — không close, manifest không đụng", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const tab = fakeTabCleanupProvider("tmux", {});
	try {
		writeRunManifest(cwd, "run-active", { ...tabbedTerminalManifest({ team_A: ["w1"] }), status: "running" });
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: tab.provider } },
		});
		assert.deepEqual(tab.closeByIdCalls, [], "run đang sống còn sở hữu tab của nó");
		assert.equal(out.orphanTabs.length, 0);
		assert.deepEqual(readBackTabs(cwd, "run-active").team_A, ["w1"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task 6: closeTabById throw → tabFailures, entry manifest KHÔNG clear (thử lại lần doctor sau)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const tab = fakeTabCleanupProvider("tmux", { w1: new Error("mux refused") });
	try {
		writeRunManifest(cwd, "run-terminal", tabbedTerminalManifest({ team_A: ["w1", "w2"] }));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: tab.provider } },
		});
		assert.deepEqual(tab.closeByIdCalls, ["w1", "w2"], "lỗi một tab không abort các tab còn lại");
		assert.equal(out.tabFailures.length, 1);
		assert.equal(out.tabFailures[0]?.tabId, "w1");
		assert.match(out.tabFailures[0]?.error ?? "", /mux refused/);
		assert.deepEqual(readBackTabs(cwd, "run-terminal").team_A, ["w1", "w2"], "entry giữ nguyên làm evidence khi chưa dọn xong");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task 6: provider thiếu closeTabById → tab listed với note, không clear manifest, không crash", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const legacy = fakeSurfaceProvider("tmux"); // không có closeTabById — provider cũ
	try {
		writeRunManifest(cwd, "run-terminal", tabbedTerminalManifest({ team_A: ["w1"] }));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: legacy.provider } },
		});
		assert.equal(out.orphanTabs.length, 1, "orphan tab vẫn được liệt kê cho human");
		assert.ok(
			out.providerNotes.some((note) => note.includes("closeTabById")),
			"note giải thích tại sao tab chỉ được liệt kê",
		);
		assert.deepEqual(readBackTabs(cwd, "run-terminal").team_A, ["w1"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("Task 6: entry tabs rỗng (host đã closeTabForRun) không phải orphan — không gọi closeTabById", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-tab-"));
	const tab = fakeTabCleanupProvider("tmux", {});
	try {
		writeRunManifest(cwd, "run-terminal", tabbedTerminalManifest({ team_A: [] }));
		const out = await cleanupOrphanSurfacePanes({
			cwd,
			scan: emptyScanWith([]),
			deps: { providers: { tmux: tab.provider } },
		});
		assert.deepEqual(tab.closeByIdCalls, []);
		assert.equal(out.orphanTabs.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
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
		orphanTabs: [{ runId: "run-terminal", tabKey: "team_A", tabIds: ["w1"], kind: "tmux", manifestPath: "/tmp/m.json" }],
		tabsClosed: ["w1"],
		tabsGone: [],
		tabFailures: [],
		scriptsSwept: 2,
		providerNotes: [],
	});
	assert.match(text, /%12/);
	assert.match(text, /%5/);
	assert.match(text, /zombie-scan pid 100/);
	assert.match(text, /mux refused/);
	assert.match(text, /run run-terminal tabKey team_A/);
	assert.match(text, /Tabs closed by id: w1/);
});
