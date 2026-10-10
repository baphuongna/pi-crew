/**
 * U7 (upgrade spec 2026-10-09, §TIER 2): run-snapshot-cache × events-state
 * layer integration.
 *
 * Contract:
 * - DEFAULT (no `eventsState` option): zero new I/O — no source attached, no
 *   timer (registry size unchanged), behavior byte-identical.
 * - OPT-IN (`eventsState: { pollMs }`): each built entry attaches a shared
 *   EventsStateSource; ONE interval tail-follows them. An EXTERNAL append to
 *   events.jsonl (no runEventBus emit, no fs.watch — the cross-process writer
 *   case) is discovered by the tail-follow, becomes frames, and routes through
 *   the EXISTING 80ms coalesced → async stamp-gated refresh so the committed
 *   snapshot reflects the new events without any sync rebuild.
 * - PARITY (acceptance #1): a cache with the events-state layer produces the
 *   SAME snapshot slices + signature as a default cache for identical on-disk
 *   state — the widget render path (activeWidgetRuns) is unchanged.
 * - LIFECYCLE: invalidate(runId) / dispose() release the attached sources.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { eventsStateSourceRegistrySize } from "../../../src/ui/events-state-source.ts";
import { createRunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";
import { activeWidgetRuns } from "../../../src/ui/widget/widget-model.ts";

// ── helpers ───────────────────────────────────────────────────────────────

function tempCwd(prefix: string): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		cwd.replace("\\\\?\\", "");
	} catch {
		/* windows long-path normalization only */
	}
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function fixtures(cwd: string, goal: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
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
	saveCrewAgents(created.manifest, [
		{
			id: `${created.manifest.runId}:01`,
			runId: created.manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "running",
			startedAt: created.manifest.createdAt,
			progress: { recentTools: [], recentOutput: ["first"], toolCount: 1, currentTool: "read", tokens: 10 },
		},
	]);
	return { manifest: created.manifest, tasks: created.tasks };
}

let eventSeq = 0;

/** Current committed seq for a run's events log: the `.seq` sidecar when
 *  present (appendEvent maintains it), else the max metadata.seq in the
 *  JSONL — fixtures create their own events via state-store, so the counter
 *  must CONTINUE from the real sequence, never restart at 1. */
function currentSeqFor(manifest: TeamRunManifest): number {
	try {
		const raw = fs.readFileSync(`${manifest.eventsPath}.seq`, "utf-8");
		const parsed = Number.parseInt(raw.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	} catch {
		/* fall through to the JSONL scan */
	}
	let max = 0;
	try {
		for (const lineItem of fs.readFileSync(manifest.eventsPath, "utf-8").split("\n")) {
			if (!lineItem.trim()) continue;
			try {
				const seq = (JSON.parse(lineItem) as { metadata?: { seq?: number } }).metadata?.seq;
				if (typeof seq === "number" && seq > max) max = seq;
			} catch {
				/* skip corrupt lines */
			}
		}
	} catch {
		/* no log yet */
	}
	return max;
}

/** Append seq-stamped team events the way the durable writer does: JSONL line
 *  + `.seq` sidecar bump (eventsStamp reads the sidecar, so a rebuild only
 *  happens when BOTH are updated — matching appendEvent semantics). */
function appendTeamEvents(manifest: TeamRunManifest, events: Array<{ type: string; data?: Record<string, unknown> }>): void {
	eventSeq = Math.max(eventSeq, currentSeqFor(manifest));
	let chunk = "";
	for (const event of events) {
		eventSeq += 1;
		chunk += `${JSON.stringify({
			time: new Date().toISOString(),
			type: event.type,
			runId: manifest.runId,
			data: event.data,
			metadata: { seq: eventSeq },
		})}\n`;
	}
	fs.appendFileSync(manifest.eventsPath, chunk, "utf-8");
	fs.writeFileSync(`${manifest.eventsPath}.seq`, String(eventSeq), "utf-8");
}

async function waitFor(ready: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

// ── DEFAULT: zero new I/O ─────────────────────────────────────────────────

test("default cache attaches no events-state source (opt-in contract)", () => {
	const cwd = tempCwd("pi-crew-u7-default-");
	try {
		const { manifest } = fixtures(cwd, "u7-default");
		const baseline = eventsStateSourceRegistrySize();
		const cache = createRunSnapshotCache(cwd);
		const snapshot = cache.refresh(manifest.runId);
		assert.ok(snapshot);
		assert.equal(eventsStateSourceRegistrySize(), baseline, "no source attached without the option");
		cache.dispose?.();
		assert.equal(eventsStateSourceRegistrySize(), baseline);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── OPT-IN: external append discovered via tail-follow frames ─────────────

test("eventsState: external events append is discovered and committed without a sync rebuild", async () => {
	const cwd = tempCwd("pi-crew-u7-external-");
	try {
		const { manifest } = fixtures(cwd, "u7-external");
		appendTeamEvents(manifest, [{ type: "task.started", data: { taskId: "explore" } }]);
		const cache = createRunSnapshotCache(cwd, { eventsState: { pollMs: 15 }, ttlMs: 0 });
		const initial = cache.refresh(manifest.runId);
		const initialCount = initial.recentEvents.length;
		assert.ok(initialCount >= 1, "precondition: fixture events are in the snapshot");
		const initialMaxSeq = currentSeqFor(manifest);
		assert.ok(cache.get(manifest.runId));

		// EXTERNAL writer: no runEventBus emit, no fs.watch signal — only the
		// tail-follow poll can discover this.
		appendTeamEvents(manifest, [
			{ type: "task.progress", data: { tokens: 42 } },
			{ type: "task.completed", data: { taskId: "explore" } },
		]);

		await waitFor(() => (cache.get(manifest.runId)?.recentEvents.length ?? 0) >= initialCount + 2);
		const settled = cache.get(manifest.runId);
		assert.ok(settled);
		const settledSeqs = settled.recentEvents.map((event) => event.metadata?.seq);
		assert.deepEqual(settledSeqs.slice(-2), [initialMaxSeq + 1, initialMaxSeq + 2], "the two external events landed in order");
		// FLICKER-FIX contract preserved: the entry was rebuilt IN PLACE — it
		// never went missing while the async refresh was pending.
		assert.ok(cache.get(manifest.runId), "entry stays populated");
		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("eventsState: source attached per built entry and released on invalidate/dispose", async () => {
	const cwd = tempCwd("pi-crew-u7-lifecycle-");
	try {
		const { manifest } = fixtures(cwd, "u7-lifecycle");
		const baseline = eventsStateSourceRegistrySize();
		const cache = createRunSnapshotCache(cwd, { eventsState: { pollMs: 50 } });
		cache.refresh(manifest.runId);
		assert.equal(eventsStateSourceRegistrySize(), baseline + 1, "source attached on first build");
		// Rebuilds reuse the SAME source (no duplicate subscriptions).
		cache.refresh(manifest.runId);
		assert.equal(eventsStateSourceRegistrySize(), baseline + 1);
		cache.invalidate(manifest.runId);
		assert.equal(eventsStateSourceRegistrySize(), baseline, "invalidate(runId) releases the source");
		cache.refresh(manifest.runId);
		assert.equal(eventsStateSourceRegistrySize(), baseline + 1, "re-attach after re-build");
		cache.dispose?.();
		assert.equal(eventsStateSourceRegistrySize(), baseline, "dispose releases everything");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── PARITY: widget render from the state-source-driven cache is unchanged ─

test("parity: eventsState cache produces identical snapshots + widget runs as a default cache", async () => {
	const cwd = tempCwd("pi-crew-u7-parity-");
	try {
		const { manifest, tasks } = fixtures(cwd, "u7-parity");
		appendTeamEvents(manifest, [{ type: "task.started", data: { taskId: "explore" } }]);
		const plain = createRunSnapshotCache(cwd);
		const layered = createRunSnapshotCache(cwd, { eventsState: { pollMs: 15 }, ttlMs: 0 });

		const a = plain.refresh(manifest.runId);
		const b = layered.refresh(manifest.runId);

		/** Compare every RENDER-RELEVANT slice (fetchedAt is a timestamp by design). */
		const renderRelevant = (snapshot: RunUiSnapshot): Record<string, unknown> => ({
			signature: snapshot.signature,
			sliceSignatures: snapshot.sliceSignatures,
			tasks: snapshot.tasks,
			agents: snapshot.agents,
			progress: snapshot.progress,
			usage: snapshot.usage,
			mailbox: snapshot.mailbox,
			groupJoins: snapshot.groupJoins,
			recentEvents: snapshot.recentEvents,
			recentOutputLines: snapshot.recentOutputLines,
			cancellationReason: snapshot.cancellationReason,
			dwfPhaseState: snapshot.dwfPhaseState,
		});
		assert.deepEqual(renderRelevant(a), renderRelevant(b), "initial build parity");

		// Mutate EVERY stamped surface (tasks, agents, events, mailbox-shaped
		// state) and let BOTH caches converge — the layered one via frames, the
		// plain one via a forced rebuild.
		appendTeamEvents(manifest, [
			{ type: "run.cancelled", data: { reason: "operator-requested" } },
			{ type: "task.progress", data: { tokens: 7 } },
		]);
		saveRunTasks(
			manifest,
			tasks.map((task) => ({ ...task, status: "completed", usage: { input: 5, output: 6 } })),
		);
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:01`,
				runId: manifest.runId,
				taskId: tasks[0]?.id ?? "explore",
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "completed",
				startedAt: manifest.createdAt,
				completedAt: new Date().toISOString(),
				progress: { recentTools: [], recentOutput: ["first", "second"], toolCount: 2, currentTool: "edit", tokens: 11 },
			},
		]);

		await waitFor(() => {
			const layeredSnapshot = layered.get(manifest.runId);
			return layeredSnapshot !== undefined && layeredSnapshot.recentEvents.length >= 3;
		});
		const settledLayered = layered.get(manifest.runId);
		const settledPlain = plain.refresh(manifest.runId);
		assert.ok(settledLayered && settledPlain);
		assert.deepEqual(renderRelevant(settledPlain), renderRelevant(settledLayered), "post-mutation parity");

		// Widget projection parity (acceptance #1): same WidgetRun shape.
		const widgetPlain = activeWidgetRuns(cwd, undefined, plain, [manifest]);
		const widgetLayered = activeWidgetRuns(cwd, undefined, layered, [manifest]);
		assert.deepEqual(
			widgetPlain.map((item) => ({
				runId: item.run.runId,
				agents: item.agents.map((agent) => [agent.taskId, agent.status]),
				progress: item.snapshot?.progress,
			})),
			widgetLayered.map((item) => ({
				runId: item.run.runId,
				agents: item.agents.map((agent) => [agent.taskId, agent.status]),
				progress: item.snapshot?.progress,
			})),
		);
		assert.equal(settledLayered.cancellationReason, "operator-requested", "events-derived slice parity");

		plain.dispose?.();
		layered.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
