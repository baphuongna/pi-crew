import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import {
	compactTokens,
	registerPiCrewPowerbarSegments,
	resetPowerbarDedupState,
	updatePiCrewPowerbar,
} from "../../../src/ui/powerbar-publisher.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

test("powerbar publisher registers and updates active crew segments", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		registerPiCrewPowerbarSegments(bus);
		assert.ok(events.some((item) => item.event === "powerbar:register-segment"));
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
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
			},
		]);
		updatePiCrewPowerbar(bus, cwd);
		assert.ok(events.some((item) => item.event === "powerbar:update" && JSON.stringify(item.data).includes("pi-crew-active")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

function payloadRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}

test("powerbar progress uses task totals and respects model/token visibility", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-tasks-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-tasks-"));
	try {
		resetPowerbarDedupState();
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		const team = {
			name: "powerbar-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "powerbar-workflow",
			description: "",
			steps: [
				{ id: "one", role: "worker" },
				{ id: "two", role: "worker" },
				{ id: "three", role: "worker" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		const tasks = created.tasks.map(
			(task, index): TeamTaskState => ({
				...task,
				status: index === 0 ? "completed" : index === 1 ? "running" : "queued",
				usage: index === 0 ? { input: 1000, output: 500 } : undefined,
			}),
		);
		saveRunTasks(created.manifest, tasks);
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: tasks[1]?.id ?? "two",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				model: "provider/visible-model",
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);

		updatePiCrewPowerbar(bus, cwd, { showModel: false, showTokens: false });
		const hiddenActive = [...events]
			.reverse()
			.find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-active");
		const hiddenProgress = [...events]
			.reverse()
			.find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-progress");
		assert.equal(payloadRecord(hiddenActive?.data).suffix, undefined);
		assert.equal(payloadRecord(hiddenProgress?.data).suffix, "1/3");
		assert.equal(payloadRecord(hiddenProgress?.data).bar, 33);

		events.length = 0;
		updatePiCrewPowerbar(bus, cwd, { showModel: true, showTokens: true });
		const visibleActive = [...events]
			.reverse()
			.find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-active");
		const visibleProgress = [...events]
			.reverse()
			.find((item) => item.event === "powerbar:update" && payloadRecord(item.data).id === "pi-crew-progress");
		assert.equal(payloadRecord(visibleActive?.data).suffix, "visible-model · 2k");
		assert.equal(payloadRecord(visibleProgress?.data).suffix, "1/3 · 2k");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar mirrors status when no powerbar consumer is registered", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-fallback-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-fallback-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
			listenerCount: () => 0,
		};
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			},
		};
		const team = {
			name: "fallback-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "fallback-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar fallback",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, ctx);
		assert.ok(events.some((item) => item.event === "powerbar:update"));
		// setStatusFallback is intentionally NOT called - crew-widget manages "pi-crew" status
		assert.equal(statuses.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar skips status fallback when a powerbar consumer is registered", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-consumer-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-consumer-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const bus = {
			emit: () => undefined,
			listenerCount: (event: string) => (event === "powerbar:update" ? 1 : 0),
		};
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			},
		};
		const team = {
			name: "consumer-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "consumer-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar consumer",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, ctx);
		assert.equal(statuses.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar active segment includes notification badge", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-badge-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-badge-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		// Reset dedup state so this test always emits fresh payload
		resetPowerbarDedupState();
		const team = {
			name: "badge-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "badge-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar badge",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);
		updatePiCrewPowerbar(bus, cwd, {}, undefined, undefined, undefined, 3);
		const active = events
			.map((item) => payloadRecord(item.data))
			.find((item) => item.id === "pi-crew-active" && typeof item.text === "string");
		assert.match(String(active?.text ?? ""), /3/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("compactTokens keeps short values and compacts thousands", () => {
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(1500), "2k");
});

/**
 * Build a RunUiSnapshot for a run with N running agents and no tasks/usage.
 * The only countable signal in the emitted active segment is then the running
 * agent total, which lets the owner-sessionId filter be asserted unambiguously
 * (distinct per-run agent counts make the filtered vs. unfiltered totals unique).
 */
function makeActiveSnapshot(run: TeamRunManifest, runningAgents: number): RunUiSnapshot {
	const agents = Array.from({ length: runningAgents }, (_, index) => ({
		id: `${run.runId}:0${index}`,
		runId: run.runId,
		taskId: "01",
		agent: "worker",
		role: "worker",
		runtime: "child-process" as const,
		status: "running" as const,
		startedAt: run.createdAt,
	}));
	return {
		runId: run.runId,
		cwd: run.cwd,
		fetchedAt: Date.now(),
		signature: `${run.runId}-${runningAgents}`,
		manifest: run,
		tasks: [],
		agents,
		progress: { total: 0, completed: 0, running: runningAgents, failed: 0, queued: 0 },
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
}

/**
 * Extract the most recent "pi-crew-active" emitted payload (with a string text)
 * from the captured event log.
 */
function findActivePayload(events: Array<{ event: string; data: unknown }>): Record<string, unknown> | undefined {
	return [...events]
		.reverse()
		.map((item) => (item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>) : undefined))
		.find((item) => item?.id === "pi-crew-active" && typeof item.text === "string");
}

test("powerbar self-derives workspaceId from ctx.sessionManager and filters runs by ownerSessionId (#10)", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-session-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-session-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		resetPowerbarDedupState();
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		const team = {
			name: "session-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "session-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// Three runs in the shared project tree: owned by session A, owned by
		// session B, and ownerless. Each gets a DISTINCT number of running agents
		// (A=3, B=2, ownerless=1) so the surviving running total uniquely
		// identifies which runs passed the filter.
		const now = new Date().toISOString();
		const manifestA = {
			...createRunManifest({ cwd, team, workflow, goal: "owned-A", ownerSessionId: "A" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const manifestB = {
			...createRunManifest({ cwd, team, workflow, goal: "owned-B", ownerSessionId: "B" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const manifestO = {
			...createRunManifest({ cwd, team, workflow, goal: "ownerless" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const snapshots = new Map<string, RunUiSnapshot>([
			[manifestA.runId, makeActiveSnapshot(manifestA, 3)],
			[manifestB.runId, makeActiveSnapshot(manifestB, 2)],
			[manifestO.runId, makeActiveSnapshot(manifestO, 1)],
		]);
		const snapshotCache = { get: (id: string) => snapshots.get(id) };
		// ctx belongs to session B → effectiveWorkspaceId self-derives to "B"
		// via extractSessionId(ctx) (P3 #10). Run A must be filtered out.
		const ctx = { hasUI: false, sessionManager: { getSessionId: () => "B" } };
		updatePiCrewPowerbar(bus, cwd, {}, undefined, snapshotCache as never, ctx, 0, [manifestA, manifestB, manifestO]);
		const active = findActivePayload(events);
		// Only B (2) + ownerless (1) survive the owner filter → 3 running agents.
		assert.match(String(active?.text ?? ""), /^⚙ 3 running/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar processes all runs when ctx has no sessionManager (back-compat, #10)", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-nosession-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-nosession-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		resetPowerbarDedupState();
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		const team = {
			name: "nosession-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "nosession-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const now = new Date().toISOString();
		const manifestA = {
			...createRunManifest({ cwd, team, workflow, goal: "owned-A2", ownerSessionId: "A" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const manifestB = {
			...createRunManifest({ cwd, team, workflow, goal: "owned-B2", ownerSessionId: "B" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const manifestO = {
			...createRunManifest({ cwd, team, workflow, goal: "ownerless2" }).manifest,
			status: "running" as const,
			updatedAt: now,
		};
		const snapshots = new Map<string, RunUiSnapshot>([
			[manifestA.runId, makeActiveSnapshot(manifestA, 3)],
			[manifestB.runId, makeActiveSnapshot(manifestB, 2)],
			[manifestO.runId, makeActiveSnapshot(manifestO, 1)],
		]);
		const snapshotCache = { get: (id: string) => snapshots.get(id) };
		// No sessionManager, no workspaceId arg → extractSessionId returns
		// undefined → no filtering; pre-fix behavior preserved (all runs shown).
		updatePiCrewPowerbar(bus, cwd, {}, undefined, snapshotCache as never, undefined, 0, [manifestA, manifestB, manifestO]);
		const active = findActivePayload(events);
		// All three runs processed → 3 + 2 + 1 = 6 running agents.
		assert.match(String(active?.text ?? ""), /^⚙ 6 running/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar dedups per-segment when payload unchanged across renders (1.8)", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-dedup-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-dedup-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		const team = {
			name: "dedup-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "dedup-workflow",
			description: "",
			steps: [
				{ id: "one", role: "worker" },
				{ id: "two", role: "worker" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar dedup",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		const tasks = created.tasks.map(
			(t, idx): TeamTaskState => ({
				...t,
				status: idx === 0 ? "completed" : "running",
			}),
		);
		saveRunTasks(created.manifest, tasks);
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: tasks[1]?.id ?? "two",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);

		// Reset internal dedup state in case prior tests left it populated.
		const before = events.length;
		updatePiCrewPowerbar(bus, cwd);
		const firstUpdates = events.slice(before).filter((e) => e.event === "powerbar:update");
		// First call must emit both segments at least once.
		assert.ok(firstUpdates.some((e) => payloadRecord(e.data).id === "pi-crew-active"));
		assert.ok(firstUpdates.some((e) => payloadRecord(e.data).id === "pi-crew-progress"));

		const afterFirst = events.length;
		updatePiCrewPowerbar(bus, cwd);
		updatePiCrewPowerbar(bus, cwd);
		updatePiCrewPowerbar(bus, cwd);
		// No new updates should be emitted because nothing changed.
		const repeatedUpdates = events.slice(afterFirst).filter((e) => e.event === "powerbar:update");
		assert.equal(repeatedUpdates.length, 0, `expected no re-emit, got ${repeatedUpdates.length}`);

		// Now flip a task to completed → progress bar must change → progress segment must re-emit, active should also re-emit (running count drops).
		const afterRepeat = events.length;
		saveRunTasks(
			created.manifest,
			tasks.map((t, idx) => ({
				...t,
				status: idx === 0 ? "completed" : "completed",
			})),
		);
		saveCrewAgents(created.manifest, []);
		updatePiCrewPowerbar(bus, cwd);
		const reactedUpdates = events.slice(afterRepeat).filter((e) => e.event === "powerbar:update");
		// Run is no longer active (no running agents); publisher emits clear payloads ({id} only).
		assert.ok(reactedUpdates.some((e) => payloadRecord(e.data).id === "pi-crew-active" && payloadRecord(e.data).text === undefined));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("powerbar plan segment shows plan:pending only while approval is pending (WP-3)", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-plan-home-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	process.env.PI_TEAMS_HOME = home;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-powerbar-plan-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const events: Array<{ event: string; data: unknown }> = [];
		const bus = {
			emit: (event: string, data: unknown) => events.push({ event, data }),
		};
		registerPiCrewPowerbarSegments(bus);
		assert.ok(
			events.some((item) => item.event === "powerbar:register-segment" && payloadRecord(item.data).id === "pi-crew-plan"),
			"pi-crew-plan segment must be registered alongside the other segments",
		);
		const team = {
			name: "plan-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "plan-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "powerbar plan",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					activityState: "active",
				},
			},
		]);

		const findPlanPayload = (): Record<string, unknown> | undefined =>
			[...events]
				.reverse()
				.map((item) => (item.event === "powerbar:update" ? payloadRecord(item.data) : undefined))
				.find((item) => item?.id === "pi-crew-plan");

		// 1) No planApproval → segment present but NO plan:pending text.
		events.length = 0;
		resetPowerbarDedupState();
		updatePiCrewPowerbar(bus, cwd);
		assert.equal(
			events.filter(
				(item) =>
					item.event === "powerbar:update" &&
					payloadRecord(item.data).id === "pi-crew-plan" &&
					payloadRecord(item.data).text === "plan:pending",
			).length,
			0,
			"no plan:pending payload without a pending approval",
		);

		// 2) Pending → plan:pending payload emitted.
		events.length = 0;
		saveRunManifest({
			...created.manifest,
			status: "running",
			planApproval: {
				required: true,
				status: "pending",
				requestedAt: created.manifest.createdAt,
				updatedAt: created.manifest.createdAt,
			},
		});
		resetPowerbarDedupState();
		updatePiCrewPowerbar(bus, cwd);
		const pending = findPlanPayload();
		assert.ok(pending, "plan payload must be emitted while approval is pending");
		assert.equal(pending?.text, "plan:pending");
		assert.equal(pending?.color, "warning");

		// 3) Approved → clear payload (text gone) re-emitted.
		events.length = 0;
		saveRunManifest({
			...created.manifest,
			status: "running",
			planApproval: {
				required: true,
				status: "approved",
				requestedAt: created.manifest.createdAt,
				updatedAt: created.manifest.createdAt,
				approvedAt: created.manifest.createdAt,
			},
		});
		resetPowerbarDedupState();
		updatePiCrewPowerbar(bus, cwd);
		const cleared = findPlanPayload();
		assert.ok(cleared, "plan clear payload must be emitted after approval");
		assert.equal(cleared?.text, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});
