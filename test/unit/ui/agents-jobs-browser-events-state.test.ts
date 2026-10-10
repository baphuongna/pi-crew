/**
 * U7 (upgrade spec 2026-10-09, §TIER 2): agents-jobs-browser default data
 * path over committed-state caches.
 *
 * Contract:
 * - DEFAULT path (no agentsProvider — the interactive [b] browser): the
 *  400ms refresh tick reads COMMITTED snapshots (manifest cache + snapshot
 *  cache with the events-state layer) — the per-tick listRecentRuns +
 *  readCrewAgents disk re-parse is gone. External state changes (events
 *  append, agents.json status flip) surface in entriesView via the
 *  events-state tail-follow frames → coalesced refresh, WITHOUT any
 *  runEventBus emit or fs.watch from this process.
 * - PARITY with the legacy disk path: same run/task/status projection.
 * - dispose() tears down ONLY the caches the browser created; injected
 *   caches stay alive for the host.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { createManifestCache } from "../../../src/runtime/manifest-cache.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { AgentsJobsBrowser } from "../../../src/ui/agents-jobs-browser.ts";
import { createRunSnapshotCache, type RunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import { activeWidgetRuns } from "../../../src/ui/widget/widget-model.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function tempCwd(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeActiveRun(cwd: string, goal: string): { manifest: TeamRunManifest; taskId: string } {
	const team = {
		name: "fast-fix",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "fast-fix",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal });
	saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
	saveRunTasks(created.manifest, created.tasks);
	const taskId = created.tasks[0]?.id ?? "explore";
	const agentRecord = (id: string, agent: string, status: CrewAgentRecord["status"]): CrewAgentRecord => ({
		id: `${created.manifest.runId}:${id}`,
		runId: created.manifest.runId,
		taskId,
		agent,
		role: agent,
		runtime: "child-process",
		status,
		startedAt: created.manifest.createdAt,
		progress: { recentTools: [], recentOutput: ["hi"], toolCount: 1, currentTool: "read", tokens: 1 },
	});
	saveCrewAgents(created.manifest, [agentRecord("01", "explorer", "running"), agentRecord("02", "writer", "running")]);
	return { manifest: created.manifest, taskId };
}

function appendEvent(manifest: TeamRunManifest, type: string, data?: Record<string, unknown>): void {
	let max = 0;
	try {
		max = Number.parseInt(fs.readFileSync(`${manifest.eventsPath}.seq`, "utf-8").trim(), 10) || 0;
	} catch {
		max = 0;
	}
	const seq = max + 1;
	fs.appendFileSync(
		manifest.eventsPath,
		`${JSON.stringify({ time: new Date().toISOString(), type, runId: manifest.runId, data, metadata: { seq } })}\n`,
		"utf-8",
	);
	fs.writeFileSync(`${manifest.eventsPath}.seq`, String(seq), "utf-8");
}

async function waitFor(ready: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

function makeBrowser(cwd: string, manifestCache?: ReturnType<typeof createManifestCache>, snapshotCache?: RunSnapshotCache) {
	return new AgentsJobsBrowser({
		cwd,
		refreshTtlMs: 0,
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		surfaceReachable: false,
		manifestCache,
		snapshotCache,
	});
}

// ── tests ─────────────────────────────────────────────────────────────────

test("default path renders agents from committed snapshots and tracks external changes", async () => {
	const cwd = tempCwd("pi-crew-u7-browser-");
	const browser = makeBrowser(cwd);
	try {
		const { manifest, taskId } = makeActiveRun(cwd, "u7-browser");
		await waitFor(() => browser.entriesView.some((entry) => entry.kind === "agent" && entry.runId === manifest.runId));
		const agentEntries = browser.entriesView.filter((entry) => entry.kind === "agent" && entry.runId === manifest.runId);
		assert.equal(agentEntries.length, 2, "explorer + writer listed from committed snapshots");
		assert.ok(agentEntries.every((entry) => entry.kind === "agent" && entry.taskId === taskId));

		// EXTERNAL mutation: the writer worker (another process) completes —
		// no runEventBus emit, no fs.watch; only the events-state tail-follow
		// + snapshot refresh can surface it. The explorer stays RUNNING so the
		// run itself remains display-active (isDisplayActiveRun drops runs
		// with no active-agent evidence — a display filter, not this pipeline).
		appendEvent(manifest, "task.completed", { taskId });
		const agentRecord = (id: string, agent: string, status: CrewAgentRecord["status"]): CrewAgentRecord => ({
			id: `${manifest.runId}:${id}`,
			runId: manifest.runId,
			taskId,
			agent,
			role: agent,
			runtime: "child-process",
			status,
			startedAt: manifest.createdAt,
			...(status === "completed" ? { completedAt: new Date().toISOString() } : {}),
			progress: { recentTools: [], recentOutput: ["done"], toolCount: 2, currentTool: "edit", tokens: 3 },
		});
		saveCrewAgents(manifest, [agentRecord("01", "explorer", "running"), agentRecord("02", "writer", "completed")]);
		await waitFor(() => {
			browser.refreshData(true);
			const writer = browser.entriesView.find((entry) => entry.kind === "agent" && entry.agentName === "writer");
			return writer !== undefined && writer.kind === "agent" && writer.status === "completed";
		});
		const explorer = browser.entriesView.find((entry) => entry.kind === "agent" && entry.agentName === "explorer");
		assert.ok(explorer && explorer.kind === "agent" && explorer.status === "running", "the other agent is untouched");
	} finally {
		browser.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("default path parity: entries match the legacy disk projection", async () => {
	const cwd = tempCwd("pi-crew-u7-browser-parity-");
	const browser = makeBrowser(cwd);
	try {
		const { manifest, taskId } = makeActiveRun(cwd, "u7-parity");
		await waitFor(() => browser.entriesView.some((entry) => entry.kind === "agent" && entry.runId === manifest.runId));
		// Scope to the FIXTURE run: scopedRunRoots merges the user crew root,
		// whose live runs (this very test session) are environment noise.
		const fromBrowser = browser.entriesView
			.filter((entry) => entry.kind === "agent" && entry.runId === manifest.runId)
			.map((entry) => (entry.kind === "agent" ? [entry.taskId, entry.status, entry.agentName] : null));
		const fromDisk = activeWidgetRuns(cwd, undefined, undefined, undefined, undefined)
			.filter(({ run }) => run.runId === manifest.runId)
			.flatMap(({ agents }) => agents.map((agent) => [agent.taskId, agent.status, agent.agent] as const));
		assert.deepEqual(fromBrowser, fromDisk, "committed-state path ≡ legacy disk path projection");
		assert.equal(fromBrowser.length, 2, "precondition: both fixture agents listed");
		assert.equal(fromBrowser[0]?.[0], taskId);
	} finally {
		browser.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("dispose leaves injected caches alive (host ownership contract)", async () => {
	const cwd = tempCwd("pi-crew-u7-browser-inject-");
	const manifestCache = createManifestCache(cwd);
	const snapshotCache = createRunSnapshotCache(cwd, { eventsState: { pollMs: 20 } });
	const browser = makeBrowser(cwd, manifestCache, snapshotCache);
	try {
		const { manifest } = makeActiveRun(cwd, "u7-inject");
		await waitFor(() => browser.entriesView.some((entry) => entry.kind === "agent"));
		browser.dispose();
		assert.equal(snapshotCache.isDisposed(), false, "injected snapshot cache survives browser dispose");
		const snapshot = snapshotCache.refresh?.(manifest.runId);
		assert.ok(snapshot, "injected cache still serves");
	} finally {
		browser.dispose();
		snapshotCache.dispose?.();
		manifestCache.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
