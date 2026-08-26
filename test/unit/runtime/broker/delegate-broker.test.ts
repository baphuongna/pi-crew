/**
 * delegate-broker.test.ts — T3/R5 WP-5 step 5 (ADR-5 §1/§4/§5/§10).
 *
 * Binding contract: ADR-5 docs/decisions/2026-08-17-governed-nesting.md.
 *
 * Real socket + temp run dir (scaffold run, executor task flipped running —
 * same fixture discipline as wait-request-broker.test.ts):
 *  1. auth matrix: compound task-scoped token ✓; legacy bare-runId token ✗
 *     (migrate-hint message); unauthenticated ✗.
 *  2. flag off (nestingEnabled default false): policy-disabled error AND a
 *     delegate.rejected event in events.jsonl — never silent.
 *  3. admission denials surfaced as typed errors: depth (depth-exceeded at
 *     default maxDepth=4), slots exhausted (fail-fast). The parent ROLE is no
 *     longer a gate (D8) — a read-only explorer parent is admitted.
 *  4. happy path (injected fake spawner): immediate {grandchildTaskRef}
 *     response, fenced result delivered to the PARENT task mailbox,
 *     budget reservation → roll-up reconciliation on disk, slot released
 *     (second delegate admitted after completion).
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
import type { TeamEvent } from "../../../../src/state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import { encodeBrokerFrame, NdjsonDecoder } from "../../../../src/utils/ndjson.ts";

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-crew-test-${tok}-${suffix}`;
	return path.join(os.tmpdir(), `dlg-${tok}-${suffix}.sock`);
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

async function scaffoldRunningTask(prefix: string, role = "executor"): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dlg-${prefix}-`));
	// .git marker so findRepoRoot resolves project-scoped state inside the temp
	// tree (bug-029 lesson — raw mkdtemp without a marker can escape to a shared
	// root depending on platform tmpdir layout).
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `delegate-${prefix}` },
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

async function startBroker(opts: {
	cwd: string;
	nestingEnabled?: boolean;
	nestingMaxSlots?: number;
	spawner?: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
	modelCatalog?: string[];
}): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("dlg");
	const broker = new CrewBroker({
		sessionId: "session-delegate-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		nestingEnabled: opts.nestingEnabled === true,
		// ADR-5 §12: tests opt into the trust decision explicitly (production:
		// config.nesting.enabled === true threads it).
		nestingTrustedEscalation: opts.nestingEnabled === true,
		...(opts.nestingMaxSlots !== undefined ? { nestingMaxSlots: opts.nestingMaxSlots } : {}),
		...(opts.spawner ? { grandchildSpawner: opts.spawner } : {}),
		...(opts.modelCatalog ? { modelCatalog: () => opts.modelCatalog } : {}),
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

test("auth: legacy bare-runId token is rejected with a migrate hint (pin iii)", async () => {
	const s = await scaffoldRunningTask("auth");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true });
	try {
		const legacy = broker.issueRunToken(s.runId); // legacy per-run token (no taskId)
		assert.ok(typeof legacy === "string" && legacy.length > 0, "legacy token must be minted");
		const client = await rawConnect(socketPath);
		try {
			// hello with the legacy token: runId-only fallback match.
			await hello(client, s.runId, s.taskId, legacy);
			const res = await sendDelegate(client, { prompt: "do work" });
			assert.ok(res.error, "delegate with legacy token must fail");
			assert.equal(res.error!.code, "forbidden");
			assert.match(res.error!.message, /task-scoped token/);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("flag off (default): policy-disabled error + delegate.rejected event — never silent", async () => {
	const s = await scaffoldRunningTask("flagoff");
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: false });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "x" });
			assert.ok(res.error);
			assert.equal(res.error!.code, "policy-disabled");
			assert.match(res.error!.message, /nesting\.enabled=false/);
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.rejected"));
			const rej = events.find((e) => e.type === "delegate.rejected");
			assert.ok(rej, "delegate.rejected event must be recorded");
			assert.equal(rej!.data?.reason, "nesting-disabled");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("admission D8: read-only parent role (explorer) may now delegate", async () => {
	const s = await scaffoldRunningTask("role", "explorer");
	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "explorer grandchild did the thing", usageTokens: 42 };
	};
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: fakeSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "explore" });
			assert.ok(res.result, `explorer parent must be admitted: ${JSON.stringify(res)}`);
			assert.equal(res.result!.ok, true);
			const ref = res.result!.grandchildTaskRef as string;
			assert.match(ref, /^gc-/);
			assert.equal(spawns[0]?.role, "explorer", "grandchild role threads the parent record role");
			// Background lifecycle completes (mailbox + roll-up).
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.ok(events.some((e) => e.type === "delegate.admitted"));
			assert.ok(events.some((e) => e.type === "delegate.completed"));
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("happy path: immediate ref, fenced mailbox delivery, budget reserve→roll-up, slot released", async () => {
	const s = await scaffoldRunningTask("happy");
	// Grant the parent task an allocation so budget admission passes.
	const loaded = loadRunManifestById(s.cwd, s.runId)!;
	saveRunTasks(
		loaded.manifest,
		loaded.tasks.map((t) => (t.id === s.taskId ? { ...t, allocation: { tokensGranted: 10_000, tokensSpent: 0 } } : t)),
	);

	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "grandchild did the thing", usageTokens: 300 };
	};

	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, spawner: fakeSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "summarize", budgetTokens: 500, role: "analyst" });
			assert.ok(res.result, `delegate must succeed: ${JSON.stringify(res)}`);
			assert.equal(res.result!.ok, true);
			const ref = res.result!.grandchildTaskRef as string;
			assert.match(ref, /^gc-/);
			assert.equal(res.result!.childDepth, 2);

			// Background lifecycle completes: mailbox + roll-up + events.
			const events = await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.ok(events.some((e) => e.type === "delegate.admitted"));
			assert.ok(events.some((e) => e.type === "delegate.completed"));
			const rolled = events.find((e) => e.type === "delegate.rolled_up");
			assert.ok(rolled, "roll-up event");
			assert.equal(rolled!.data?.actualTokens, 300);

			// Fenced result delivered to the parent task's mailbox inbox file
			// (<stateRoot>/mailbox/tasks/<taskId>/inbox.jsonl).
			const fresh = loadRunManifestById(s.cwd, s.runId)!;
			const inboxPath = path.join(fresh.manifest.stateRoot, "mailbox", "tasks", s.taskId, "inbox.jsonl");
			const lines = fs
				.readFileSync(inboxPath, "utf8")
				.split("\n")
				.filter((l) => l.trim().length > 0);
			const last = JSON.parse(lines.at(-1)!) as { body: string; from: string };
			assert.equal(last.from, `delegate:${ref}`);
			assert.match(last.body, /--- delegate gc-/);
			assert.match(last.body, /grandchild did the thing/);

			// Budget reconciled: 10000 granted, 300 spent (500 reserved → 300 actual).
			const parent = fresh.tasks.find((t) => t.id === s.taskId)!;
			assert.equal(parent.allocation?.tokensSpent, 300);

			// Spawner received depthOverride from the RECORD (grandchild = 2).
			assert.equal(spawns[0]?.depthOverride, 2);

			// Slot released → a second delegate is admitted (no exhaustion).
			const res2 = await sendDelegate(client, { prompt: "again" }, "dlg-2");
			assert.ok(res2.result, `second delegate after release must be admitted: ${JSON.stringify(res2)}`);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("fail-fast: exhausted nested budget rejects immediately (never queues)", async () => {
	const s = await scaffoldRunningTask("slots");
	const slowSpawner = () =>
		new Promise<GrandchildSpawnResult>(() => {
			/* never resolves — holds the slot */
		});
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, nestingEnabled: true, nestingMaxSlots: 1, spawner: slowSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const first = await sendDelegate(client, { prompt: "hold the slot" }, "dlg-1");
			assert.ok(first.result, `first delegate admitted (1/1): ${JSON.stringify(first)}`);
			const second = await sendDelegate(client, { prompt: "must be rejected" }, "dlg-2");
			assert.ok(second.error, "second delegate on a full budget must be rejected");
			assert.equal(second.error!.code, "policy-denied");
			assert.match(second.error!.message, /nested spawn budget exhausted; 1\/1 in flight/);
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});
