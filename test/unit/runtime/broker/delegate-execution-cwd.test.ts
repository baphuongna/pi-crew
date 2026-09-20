/**
 * delegate-execution-cwd.test.ts — RR-012 F03 regression (RED-first).
 *
 * F03 (VERIFIED, docs/archive/2026-09-17-pi-crew-review-verification.md §4):
 * the broker wrote the shadow task with the PARENT TASK's cwd but spawned
 * the grandchild with the BROKER's cwd (crew-broker.ts:1394 → :1587-1588 →
 * delegate-spawn.ts:114-115), so in worktree mode a delegated executor could
 * run OUTSIDE the admitted worktree, and the grandchild's artifacts root was
 * derived from the broker cwd too (delegate-spawn.ts:99 — wrong side).
 *
 * Production wiring makes the two legitimately diverge:
 *   broker cwd = process.cwd()         (lifecycle-handlers.ts:1125)
 *   task.cwd   = workspace.cwd          (pre-execution.ts:146 — worktree path
 *                                        in worktree mode, worktree-manager.ts:1043)
 *
 * The pre-existing delegate-broker.test.ts fixture sets broker cwd ≡ task cwd
 * BY CONSTRUCTION (same s.cwd for both), which is exactly why F03 was
 * invisible to it. This fixture separates the two paths:
 *   brokerCwd = <tmp>/leader
 *   task.cwd  = <tmp>/leader/.worktrees/<taskId>
 *
 * AC map (docs/stories/RR-012/overview.md §5):
 *   AC-1  spawner receives task.cwd (admitted worktree), not brokerCwd
 *   AC-2  grandchild artifacts root derives from the task cwd
 *         (grandchildArtifactsRoot) — never the broker cwd
 *   AC-3  overlap check compares the path the grandchild will ACTUALLY run in
 *   AC-4  single-workspace (broker cwd == task cwd) behavior unchanged
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../../../src/runtime/delegate-spawn.ts";
import { grandchildArtifactsRoot, spawnDelegateGrandchild } from "../../../../src/runtime/delegate-spawn.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	return path.join(os.tmpdir(), `dlgcwd-${tok}-${suffix}.sock`);
}

interface RawClient {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	closed: boolean;
	waitForFrame: (predicate: (frame: unknown) => boolean, timeoutMs?: number) => Promise<unknown>;
	close: () => void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		const client: RawClient = {
			socket: sock,
			decoder: new NdjsonDecoder(),
			closed: false,
			waitForFrame: () => Promise.reject(new Error("not initialized")),
			close: () => {
				try {
					sock.destroy();
				} catch {
					/* ignore */
				}
			},
		};
		const pending: Array<{ resolve: (v: unknown) => void; predicate: (f: unknown) => boolean }> = [];
		client.waitForFrame = (predicate, timeoutMs = 2000) =>
			new Promise((res, rej) => {
				pending.push({ resolve: res, predicate });
				setTimeout(() => rej(new Error("waitForFrame: timeout")), timeoutMs).unref();
			});
		sock.on("data", (chunk: Buffer) => {
			let frames: unknown[];
			try {
				frames = client.decoder.push(chunk);
			} catch {
				return;
			}
			for (const f of frames) {
				const idx = pending.findIndex((p) => p.predicate(f));
				if (idx !== -1) pending.splice(idx, 1)[0].resolve(f);
			}
		});
		sock.on("error", () => {
			/* noop — close handler decides */
		});
		sock.on("close", () => {
			client.closed = true;
			for (const p of pending) p.resolve(undefined);
		});
		sock.once("connect", () => resolve(client));
		sock.once("error", (err) => reject(err));
	});
}

interface ScaffoldRun {
	cwd: string;
	runId: string;
	taskId: string;
	eventsPath: string;
	worktreeCwd: string;
}

/**
 * Scaffold like delegate-broker.test.ts BUT with the parent task's cwd moved
 * to a worktree-style path under the broker cwd — broker cwd ≢ task.cwd.
 */
async function scaffoldRunningTaskInWorktree(prefix: string, role = "executor"): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dlgcwd-${prefix}-`));
	// .git marker so findRepoRoot resolves project-scoped state inside the temp
	// tree (bug-029 lesson).
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `delegate-cwd-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const task = loaded.tasks.find((t) => t.role === role) ?? loaded.tasks[0];
	// Worktree-style sibling path (what pre-execution.ts:146 records in
	// worktree mode via worktree-manager.ts:1043).
	const worktreeCwd = path.join(cwd, ".worktrees", task.id);
	fs.mkdirSync(worktreeCwd, { recursive: true });
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) =>
		t.id === task.id ? { ...t, status: "running" as const, startedAt: now, depth: 1, cwd: worktreeCwd } : t,
	);
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now });
	return { cwd, runId, taskId: task.id, eventsPath: loaded.manifest.eventsPath, worktreeCwd };
}

/** Scaffold with broker cwd ≡ task cwd (the pre-existing fixture shape). */
async function scaffoldRunningTaskSingle(prefix: string, role = "executor"): Promise<Omit<ScaffoldRun, "worktreeCwd">> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dlgcwd1-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `delegate-single-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const task = loaded.tasks.find((t) => t.role === role) ?? loaded.tasks[0];
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" as const, startedAt: now, depth: 1 } : t));
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now });
	return { cwd, runId, taskId: task.id, eventsPath: loaded.manifest.eventsPath };
}

/** Append an extra in-flight executor-class task at the given cwd (overlap probe). */
function addRunningExecutorAt(s: { cwd: string; runId: string }, taskId: string, atCwd: string): void {
	const loaded = loadRunManifestById(s.cwd, s.runId)!;
	const extra: TeamTaskState = {
		id: taskId,
		runId: s.runId,
		role: "executor",
		agent: "executor",
		title: "other executor",
		status: "running",
		cwd: atCwd,
		dependsOn: [],
		depth: 1,
		startedAt: new Date().toISOString(),
	};
	saveRunTasks(loaded.manifest, [...loaded.tasks, extra]);
}

async function startBroker(opts: {
	cwd: string;
	nestingEnabled?: boolean;
	spawner?: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
}): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("dlgcwd");
	const broker = new CrewBroker({
		sessionId: "session-delegate-cwd-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		nestingEnabled: opts.nestingEnabled === true,
		nestingTrustedEscalation: opts.nestingEnabled === true,
		...(opts.spawner ? { grandchildSpawner: opts.spawner } : {}),
	});
	await broker.start();
	return { broker, socketPath };
}

async function hello(client: RawClient, runId: string, taskId: string, token: string): Promise<void> {
	client.socket.write(encodeBrokerFrame({ id: `hello-${taskId}`, method: "hello", params: { protocol: 1, runId, taskId, token } }));
	const ack = (await client.waitForFrame((f) => (f as { result?: { ok?: boolean } })?.result?.ok === true)) as unknown;
	assert.ok(ack, "hello must succeed");
}

function parseEvents(eventsPath: string): TeamEvent[] {
	return fs
		.readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as TeamEvent);
}

async function readEventsUntil(eventsPath: string, until: (events: TeamEvent[]) => boolean): Promise<TeamEvent[]> {
	const deadline = Date.now() + 2500;
	for (;;) {
		const events = parseEvents(eventsPath);
		if (until(events)) return events;
		if (Date.now() > deadline) return events;
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function sendDelegate(
	client: RawClient,
	params: Record<string, unknown>,
	id = "dlg-1",
): Promise<{ result?: Record<string, unknown>; error?: { code: string; message: string } }> {
	client.socket.write(encodeBrokerFrame({ id, method: "delegate.request", params }));
	const frame = (await client.waitForFrame((f) => (f as { id?: string })?.id === id)) as {
		result?: Record<string, unknown>;
		error?: { code: string; message: string };
	};
	assert.ok(frame, "delegate.request must answer");
	return frame;
}

// ----------------------------------------------------------------------------

test("F03/AC-1: spawner receives the PARENT TASK cwd (admitted worktree), never the broker cwd", async () => {
	const s = await scaffoldRunningTaskInWorktree("cwd1");
	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "grandchild ran in the worktree", usageTokens: 10 };
	};
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: fakeSpawner });
	try {
		assert.notEqual(s.worktreeCwd, s.cwd, "fixture must separate broker cwd from task cwd (the gap that hid F03)");
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "work in the worktree" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			assert.match(res.result!.grandchildTaskRef as string, /^gc-/);
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.ok(
				events.some((e) => e.type === "delegate.admitted"),
				"delegate.admitted still emitted",
			);

			// AC-1 core (RED pre-fix: spawns[0].cwd === s.cwd — the BROKER cwd).
			assert.equal(spawns[0]?.cwd, s.worktreeCwd, "spawner must receive the parent TASK cwd (admitted worktree)");
			assert.notEqual(spawns[0]?.cwd, s.cwd, "spawner must NOT receive the broker cwd");

			// Shadow record still written with the task cwd (single source).
			const fresh = loadRunManifestById(s.cwd, s.runId)!;
			const gc = fresh.tasks.find((t) => t.id === (res.result!.grandchildTaskRef as string))!;
			assert.equal(gc.cwd, s.worktreeCwd, "shadow record cwd is the task cwd");
			assert.equal(gc.status, "completed", "terminal flip still runs (delivery not regressed)");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F03/AC-2: grandchild artifacts root derives from the task cwd (grandchildArtifactsRoot), not the broker cwd", async () => {
	const brokerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dlgcwd-art-"));
	const worktreeCwd = path.join(brokerCwd, ".worktrees", "wt-art");
	fs.mkdirSync(worktreeCwd, { recursive: true });
	fs.mkdirSync(path.join(brokerCwd, ".git"));
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	try {
		const runId = "run-art";
		const parentTaskId = "t-art";
		const subId = "gc-art";
		const result = await spawnDelegateGrandchild({
			cwd: worktreeCwd,
			runId,
			parentTaskId,
			subId,
			prompt: "make artifacts in the right root",
			role: "explorer",
			timeoutSec: 30,
			depthOverride: 2,
		});
		assert.equal(result.ok, true, `mock grandchild must succeed: ${result.resultText}`);
		// AC-2: the namespaced root exists under the TASK cwd.
		const expectedRoot = grandchildArtifactsRoot(worktreeCwd, runId, parentTaskId, subId);
		assert.ok(fs.existsSync(expectedRoot), `artifacts root must be created under the task cwd: ${expectedRoot}`);
		// And NOT under the broker cwd (RED pre-fix: delegate-spawn.ts:99 used
		// input.cwd — which the broker used to fill with the BROKER cwd).
		assert.ok(
			!fs.existsSync(path.join(brokerCwd, ".crew", "artifacts", runId)),
			"no artifacts may land under the broker cwd when task cwd differs",
		);
	} finally {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllow;
		fs.rmSync(brokerCwd, { recursive: true, force: true });
	}
});

test("F03/AC-3a: overlap check compares the cwd the grandchild will actually run in — executor at task.cwd ⇒ workspace-conflict", async () => {
	const s = await scaffoldRunningTaskInWorktree("ov1");
	addRunningExecutorAt(s, "other-exec", s.worktreeCwd);
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: async () => ({ ok: true, resultText: "x" }),
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "write stuff", role: "executor" });
			assert.ok(res.error, "write-capable grandchild overlapping an in-flight executor at the execution cwd must be rejected");
			assert.equal(res.error!.code, "policy-denied");
			assert.match(res.error!.message, /overlaps 1 in-flight executor/);
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.rejected"));
			const rej = events.find((e) => e.type === "delegate.rejected");
			assert.equal(rej!.data?.reason, "workspace-conflict");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F03/AC-3b: executor running at the BROKER cwd (≠ execution cwd) ⇒ admitted; grandchild still spawned in the worktree", async () => {
	const s = await scaffoldRunningTaskInWorktree("ov2");
	// The other executor sits at the BROKER cwd — NOT the path the grandchild
	// will run in post-fix. Pre-fix the grandchild would ACTUALLY run at the
	// broker cwd (invisible collision); post-fix it runs in the worktree.
	addRunningExecutorAt(s, "other-exec-broker", s.cwd);
	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "no overlap" };
	};
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: fakeSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "write stuff in the worktree", role: "executor" });
			assert.ok(res.result, `no true overlap ⇒ admitted: ${JSON.stringify(res)}`);
			await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.equal(spawns[0]?.cwd, s.worktreeCwd, "grandchild runs in the admitted worktree, away from the broker-cwd executor");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F03/AC-4: single-workspace (broker cwd == task cwd) — spawner still receives that cwd (no behavior change)", async () => {
	const s = await scaffoldRunningTaskSingle("single");
	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "same cwd as ever" };
	};
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: fakeSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "default mode" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.equal(spawns[0]?.cwd, s.cwd, "workspaceMode single: spawner receives the shared cwd exactly as before");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});
