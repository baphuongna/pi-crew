/**
 * delegate-shadow-lifecycle.test.ts — RR-012 F16 regression (RED-first).
 *
 * F16 (VERIFIED, docs/archive/2026-09-17-pi-crew-review-verification.md §4):
 * admission requires the parent record `status === "running"`
 * (crew-broker.ts:1444-1450) but the grandchild SHADOW record was created
 * `queued` (:1553) and NO promoter existed anywhere — the next transition was
 * the terminal flip (:1658-1669). So a depth-2 grandchild delegating to
 * depth 3 was rejected `parent-not-running` (bad-params) even when maxDepth
 * allowed it, and `team status` showed `gc-*` as queued for the ENTIRE
 * execution.
 *
 * Fixture isolates F16: task.cwd == broker cwd (cwd divergence is covered by
 * delegate-execution-cwd.test.ts — one defect per test).
 *
 * AC map (docs/stories/RR-012/overview.md §5):
 *   AC-5  shadow is `running` while the grandchild runs (onSpawn promote)
 *   AC-6  depth-2 grandchild (identity subId) may delegate to depth 3
 *   AC-7  terminalize on EVERY outcome (ok / !ok / spawner throw)
 *   3f    depth policy denial stays `policy-denied` (not parent-not-running)
 *   3g/3h a REAL not-running task is still rejected parent-not-running
 *         (the admission gate is NOT loosened)
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
import { isDelegateShadowTask } from "../../../../src/runtime/broker/delegate/shadow-lifecycle.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../../../src/runtime/delegate-spawn.ts";
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	return path.join(os.tmpdir(), `dlgshadow-${tok}-${suffix}.sock`);
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
}

/** Scaffold with the executor task flipped to running (delegate-broker.test.ts pattern). */
async function scaffoldRunningTask(prefix: string): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dlgshadow-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `delegate-shadow-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const task = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) => (t.id === task.id ? { ...t, status: "running" as const, startedAt: now, depth: 1 } : t));
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now  }, { allowTerminalExit: true });
	return { cwd, runId, taskId: task.id, eventsPath: loaded.manifest.eventsPath };
}

/** Same scaffold but the executor task stays QUEUED (for the not-loosened gate test). */
async function scaffoldQueuedTask(prefix: string): Promise<ScaffoldRun> {
	const s = await scaffoldRunningTask(prefix);
	const loaded = loadRunManifestById(s.cwd, s.runId)!;
	const now = new Date().toISOString();
	saveRunTasks(
		loaded.manifest,
		loaded.tasks.map((t) => (t.id === s.taskId ? { ...t, status: "queued" as const, startedAt: undefined, depth: 1 } : t)),
	);
	return s;
}

async function startBroker(opts: {
	cwd: string;
	nestingEnabled?: boolean;
	nestingMaxDepth?: number;
	spawner?: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
}): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("dlgshadow");
	const broker = new CrewBroker({
		sessionId: "session-delegate-shadow-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		nestingEnabled: opts.nestingEnabled === true,
		nestingTrustedEscalation: opts.nestingEnabled === true,
		...(opts.nestingMaxDepth !== undefined ? { nestingMaxDepth: opts.nestingMaxDepth } : {}),
		...(opts.spawner ? { grandchildSpawner: opts.spawner } : {}),
	});
	await broker.start();
	return { broker, socketPath };
}

async function hello(client: RawClient, runId: string, taskId: string, token: string): Promise<void> {
	client.socket.write(
		encodeBrokerFrame({
			id: `hello-${taskId}-${Math.random().toString(16).slice(2, 6)}`,
			method: "hello",
			params: { protocol: 1, runId, taskId, token },
		}),
	);
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

/** Poll tasks.json until the gc-* record exists; returns its current status. */
async function pollShadowStatus(s: ScaffoldRun, subId: string, until: (status: string | undefined) => boolean): Promise<string> {
	const deadline = Date.now() + 2500;
	for (;;) {
		const fresh = loadRunManifestById(s.cwd, s.runId);
		const shadow = fresh?.tasks.find((t) => t.id === subId);
		if (shadow && until(shadow.status)) return shadow.status;
		if (Date.now() > deadline) return shadow?.status ?? "missing";
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** Pending spawner: signals onSpawn (process exists) then never settles. */
function pendingSpawnerWithSpawn(): (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult> {
	return (input) =>
		new Promise<GrandchildSpawnResult>(() => {
			input.onSpawn?.(4321);
			/* never resolves — grandchild still running */
		});
}

// ----------------------------------------------------------------------------

// BR-09: the shadow discriminator is STRUCTURAL (no stepId), never agent-name.
// Pre-fix the predicate was `agent === "delegate"`, which filtered a REAL
// workflow task whose resolved agent is literally named `delegate` out of every
// batch (never dispatched ⇒ finalize-run marks the run `blocked`).
test("BR-09: isDelegateShadowTask keys on stepId, not on the agent name", () => {
	// Broker shadow literal: gc-* id, agent "delegate", NO stepId.
	assert.equal(isDelegateShadowTask({ id: "gc-1234", agent: "delegate", stepId: undefined }), true);
	// Legacy persisted shadows also carried no stepId ⇒ still excluded.
	assert.equal(isDelegateShadowTask({ id: "gc-legacy", agent: "delegate" }), true);
	// THE regression: a legitimate workflow task whose agent is `delegate`
	// (scheduler-set stepId) must NOT be treated as a shadow.
	assert.equal(isDelegateShadowTask({ id: "02_del", agent: "delegate", stepId: "deliver" }), false);
	// Ordinary workflow task.
	assert.equal(isDelegateShadowTask({ id: "01_explore", agent: "explorer", stepId: "explore" }), false);
});

test("F16/AC-5: shadow record is `running` while the grandchild runs (promoted on spawn)", async () => {
	const s = await scaffoldRunningTask("promote");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: pendingSpawnerWithSpawn() });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "long work" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			const subId = res.result!.grandchildTaskRef as string;
			// RED pre-fix: record stays "queued" for the ENTIRE execution.
			const status = await pollShadowStatus(s, subId, (st) => st === "running" || st === "completed");
			assert.equal(status, "running", "gc-* record must be `running` while the grandchild executes (onSpawn promote)");
			const fresh = loadRunManifestById(s.cwd, s.runId)!;
			const shadow = fresh.tasks.find((t) => t.id === subId)!;
			// BR-09: the discriminator is the ABSENT stepId (the broker literal sets
			// none); `agent` is display metadata, not the marker.
			assert.equal(shadow.stepId, undefined, "gc-* record carries no stepId — the structural shadow marker");
			assert.equal(shadow.agent, "delegate", "broker still labels the shadow agent `delegate` (display only)");
			assert.equal(shadow.depth, 2, "shadow depth from the record");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/AC-6: depth-2 grandchild (subId identity) may delegate to depth 3 — no parent-not-running", async () => {
	const s = await scaffoldRunningTask("depth3");
	let creds: { socketPath: string; token: string } | undefined;
	let gcSubId = "";
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: (input) =>
			new Promise<GrandchildSpawnResult>(() => {
				gcSubId = input.subId;
				creds = input.brokerSpawn; // pre-minted grandchild-scoped token (2 < maxDepth 4)
				input.onSpawn?.(5309);
				/* never resolves — grandchild still running */
			}),
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "grandchild that will delegate" });
			assert.ok(res.result, `depth-2 delegate must be admitted: ${JSON.stringify(res)}`);
			assert.equal(res.result!.childDepth, 2);
			// Wait for the promote + creds hand-off.
			await pollShadowStatus(s, res.result!.grandchildTaskRef as string, (st) => st === "running");
			assert.ok(creds, "grandchild creds must be pre-minted (childDepth 2 < maxDepth 4)");
			// The GRANDCHILD itself (identity = subId) sends delegate.request.
			const client2 = await rawConnect(creds!.socketPath);
			try {
				await hello(client2, s.runId, gcSubId, creds!.token);
				const res2 = await sendDelegate(client2, { prompt: "depth-3 hop" }, "dlg-gc-1");
				// RED pre-fix: error bad-params "parent task '<subId>' is queued, not running".
				assert.ok(res2.result, `depth-3 delegate via grandchild identity must be admitted: ${JSON.stringify(res2)}`);
				assert.equal(res2.result!.childDepth, 3, "depth from the gc record (2) + 1");
				const events = parseEvents(s.eventsPath);
				const rejected = events.filter((e) => e.type === "delegate.rejected");
				assert.ok(
					!rejected.some((e) => e.data?.reason === "parent-not-running"),
					"no parent-not-running rejection for a running grandchild",
				);
			} finally {
				client2.close();
			}
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/AC-7a: spawner resolves ok:true ⇒ shadow terminal `completed`", async () => {
	const s = await scaffoldRunningTask("term-ok");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: async (input) => {
			input.onSpawn?.(11);
			return { ok: true, resultText: "done", usageTokens: 5 };
		},
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "x" });
			const subId = res.result!.grandchildTaskRef as string;
			const status = await pollShadowStatus(s, subId, (st) => st === "completed");
			assert.equal(status, "completed");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/AC-7b: spawner resolves ok:false ⇒ shadow terminal `failed`", async () => {
	const s = await scaffoldRunningTask("term-fail");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: async (input) => {
			input.onSpawn?.(12);
			return { ok: false, resultText: "grandchild failed" };
		},
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "x" });
			const subId = res.result!.grandchildTaskRef as string;
			const status = await pollShadowStatus(s, subId, (st) => st === "failed");
			assert.equal(status, "failed");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/AC-7c: spawner THROWS ⇒ shadow terminal `failed` (never stuck queued/running)", async () => {
	const s = await scaffoldRunningTask("term-throw");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: async (input) => {
			input.onSpawn?.(13);
			throw new Error("spawn exploded");
		},
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "x" });
			const subId = res.result!.grandchildTaskRef as string;
			const status = await pollShadowStatus(s, subId, (st) => st === "failed");
			assert.equal(status, "failed", "thrown spawner must terminalize the promoted shadow");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/3f: depth policy denial is `policy-denied`/depth-exceeded — never parent-not-running", async () => {
	const s = await scaffoldRunningTask("depthdeny");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		nestingMaxDepth: 1,
		spawner: async () => ({ ok: true, resultText: "never" }),
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "too deep" });
			assert.ok(res.error, "depth-2 at maxDepth 1 must be denied");
			assert.equal(res.error!.code, "policy-denied");
			assert.match(res.error!.message, /depth/);
			assert.ok(!res.error!.message.includes("parent-not-running"));
			assert.ok(!res.error!.message.includes("not running"), "the denial reason must be policy, not lifecycle");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F16/3g+3h: a REAL task that is not running is still rejected parent-not-running (gate NOT loosened)", async () => {
	const s = await scaffoldQueuedTask("gate");
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		nestingEnabled: true,
		spawner: async () => ({ ok: true, resultText: "never" }),
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "x" });
			assert.ok(res.error, "queued (not running) parent must still be rejected");
			assert.equal(res.error!.code, "bad-params");
			assert.match(res.error!.message, /not running/);
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.rejected"));
			const rej = events.find((e) => e.type === "delegate.rejected");
			assert.equal(rej!.data?.reason, "parent-not-running", "delegate.rejected event reason preserved for real not-running tasks");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});
