/**
 * delegate-grandchild-model.test.ts — RR-023 F3 regression (RED-first),
 * 2026-09-29 full-battery finding #3 (empty grandchild relay).
 *
 * Root cause (explorer report, run team_20260929041427_5c40c4fd7e950443):
 * the relay/capture chain is FAITHFUL — the grandchild genuinely produced
 * zero assistant text because all 3 delegate calls omitted `model`, so the
 * broker spawned the gc model-less, the child pi booted on the GLOBAL
 * default `minimax/MiniMax-M3` (parents ran `zai/glm-5.3`), and that model
 * returned empty completions (assistant `content: []`) in all 3 gc sessions
 * (~/.pi/agent/sessions/--home-bom-source-my_pi--/2026-09-29T04-1*-*.jsonl).
 * `delegate-spawn.ts` then correctly relayed an empty string as ok:true.
 *
 * This is the same family as finding #1 (75502b68 — parent model routing
 * detached from detached parallel/goal runs): a model-less grandchild falls
 * through to the pi global default instead of inheriting the team's routing.
 *
 * AC map:
 *   AC-1  model-less delegate.request ⇒ spawner receives the PARENT TASK's
 *         model from the locked admission read (never the global default)
 *   AC-2  explicit `model` still wins over the parent's model (no override)
 *   AC-3  no model anywhere (record + request) ⇒ spawner input.model stays
 *         undefined — default passthrough unchanged
 *
 * Harness precedent: delegate-execution-cwd.test.ts (RR-012 F03) — the
 * broker-handler harness with `options.grandchildSpawner` DI capturing the
 * spawn input; the parent record is the single source of truth.
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
	return path.join(os.tmpdir(), `dlgmdl-${tok}-${suffix}.sock`);
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

/** Scaffold a single-workspace run with one RUNNING depth-1 task that carries
 *  a parent `model` on its record — the shape tasks.json had in the incident
 *  run (depth-1 records carried "model":"zai/glm-5.3", gc-* records none). */
async function scaffoldRunningTaskWithModel(prefix: string, parentModel: string | undefined): Promise<ScaffoldRun> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-dlgmdl-${prefix}-`));
	// .git marker so findRepoRoot resolves project-scoped state inside the temp
	// tree (bug-029 lesson).
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `delegate-model-${prefix}` },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const task = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const now = new Date().toISOString();
	const updatedTasks = loaded.tasks.map((t) =>
		t.id === task.id
			? {
					...t,
					status: "running" as const,
					startedAt: now,
					depth: 1,
					...(parentModel !== undefined ? { model: parentModel } : {}),
				}
			: t,
	);
	saveRunTasks(loaded.manifest, updatedTasks);
	saveRunManifest({ ...loaded.manifest, status: "running", updatedAt: now }, { allowTerminalExit: true });
	return { cwd, runId, taskId: task.id, eventsPath: loaded.manifest.eventsPath };
}

async function startBroker(opts: {
	cwd: string;
	spawner: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
}): Promise<{ broker: CrewBroker; socketPath: string }> {
	const socketPath = tempSocketPath("dlgmdl");
	const broker = new CrewBroker({
		sessionId: "session-delegate-model-test",
		socketPath,
		enabled: true,
		cwd: opts.cwd,
		nestingEnabled: true,
		nestingTrustedEscalation: true,
		grandchildSpawner: opts.spawner,
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

test("F3/AC-1: model-less delegate.request inherits the PARENT TASK's model (never the pi global default)", async () => {
	const s = await scaffoldRunningTaskWithModel("inherit", "zai/glm-5.3");
	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "DELEGATED_OK_TEAM", usageTokens: 7 };
	};
	const { broker, socketPath } = await startBroker({ cwd: s.cwd, spawner: fakeSpawner });
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			// The exact incident shape: NO `model` in the delegate args.
			const res = await sendDelegate(client, { description: "gc probe", prompt: "do the nested work" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			assert.match(res.result!.grandchildTaskRef as string, /^gc-/);
			await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			// AC-1 core (RED pre-fix: spawns[0].model === undefined → gc fell
			// through to the pi global default minimax/MiniMax-M3).
			assert.equal(spawns[0]?.model, "zai/glm-5.3", "spawner must receive the parent task's model when the request omits `model`");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F3/AC-2: explicit `model` wins over the parent task's model", async () => {
	const s = await scaffoldRunningTaskWithModel("explicit", "zai/glm-5.3");
	const spawns: GrandchildSpawnInput[] = [];
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		spawner: async (input) => {
			spawns.push(input);
			return { ok: true, resultText: "explicit ok" };
		},
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "use the explicit model", model: "openai/gpt-5-mini" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.equal(spawns[0]?.model, "openai/gpt-5-mini", "an explicit model must not be overridden by the parent's model");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});

test("F3/AC-3: no model anywhere (record + request) ⇒ spawner input.model stays undefined (passthrough unchanged)", async () => {
	const s = await scaffoldRunningTaskWithModel("nomodel", undefined);
	const spawns: GrandchildSpawnInput[] = [];
	const { broker, socketPath } = await startBroker({
		cwd: s.cwd,
		spawner: async (input) => {
			spawns.push(input);
			return { ok: true, resultText: "default routing as ever" };
		},
	});
	try {
		const token = broker.issueRunToken(s.runId, s.taskId);
		const client = await rawConnect(socketPath);
		try {
			await hello(client, s.runId, s.taskId, token);
			const res = await sendDelegate(client, { prompt: "default mode" });
			assert.ok(res.result, `delegate must be admitted: ${JSON.stringify(res)}`);
			await readEventsUntil(s.eventsPath, (evts) => evts.some((e) => e.type === "delegate.completed"));
			assert.equal(spawns[0]?.model, undefined, "no model on record or request: spawner receives no model (legacy behavior)");
		} finally {
			client.close();
		}
	} finally {
		await broker.stop();
		fs.rmSync(s.cwd, { recursive: true, force: true });
	}
});
