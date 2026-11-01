/**
 * broker-steer.test.ts — HƯỚNG A follow-up (probe19, 2026-11-01): token-less
 * `steer.force` — the lane that lets a RESTARTED/foreign session steer a LIVE
 * worker. probe19 proved the dead end: a foreign session's steering-file row
 * is signed with a key outside the worker's verify set → pollSteering drops
 * it → in-context delivery NEVER happens (worker conversation received
 * NOTHING while the file row sat on disk); pendingSteers only delivers at the
 * next spawn.
 *
 * steer.force performs the delivery broker-side: mailbox row (kind:"steer",
 * interrupt) + BROKER-SIGNED steering line — the same write pair
 * handleSteerPush does for orchestrators, minus the hello/token gate, plus
 * the live-task gate + the steer.broker_force audit event.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CrewBroker } from "../../../../src/runtime/broker/crew-broker.ts";
import { createRunManifest, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import { getBrokerSocketPath } from "../../../../src/utils/socket-path.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

interface Fixture {
	cwd: string;
	runId: string;
	taskId: string;
	broker: CrewBroker;
	socketPath: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
	stop: () => Promise<void>;
}

async function scaffold(): Promise<Fixture> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-force-"));
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	const created = createRunManifest({ cwd, team, workflow, goal: "steer.force probe" });
	saveRunManifest(created.manifest);
	const socketPath = getBrokerSocketPath(`sf-${randomUUID()}`);
	const broker = new CrewBroker({ sessionId: `sf-${randomUUID()}`, socketPath, enabled: true, cwd });
	await broker.start();
	return {
		cwd,
		runId: created.manifest.runId,
		taskId: created.tasks[0]!.id,
		broker,
		socketPath,
		manifest: created.manifest,
		stop: async () => {
			await broker.stop();
			fs.rmSync(cwd, { recursive: true, force: true });
		},
	};
}

interface RawClient {
	send(frame: unknown): void;
	waitFor(id: string): Promise<Record<string, unknown>>;
	destroy(): void;
}

function rawConnect(socketPath: string): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const sock = net.createConnection(socketPath);
		let buf = "";
		const pending = new Map<string, (frame: Record<string, unknown>) => void>();
		sock.once("error", reject);
		sock.once("connect", () => {
			resolve({
				send: (frame) => sock.write(JSON.stringify(frame) + "\n"),
				waitFor: (id) =>
					new Promise((res, rej) => {
						pending.set(id, res);
						setTimeout(() => rej(new Error(`frame ${id} timeout`)), 10_000).unref();
					}),
				destroy: () => sock.destroy(),
			});
		});
		sock.on("data", (d) => {
			buf += d.toString();
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) {
					try {
						const f = JSON.parse(line) as Record<string, unknown>;
						const cb = pending.get(f.id as string);
						if (cb) {
							pending.delete(f.id as string);
							cb(f);
						}
					} catch {
						/* skip malformed */
					}
				}
				nl = buf.indexOf("\n");
			}
		});
	});
}

test("steer.force: foreign session (pre-hello) delivers a broker-signed steering line + mailbox row + audit event", async () => {
	const fx = await scaffold();
	try {
		const client = await rawConnect(fx.socketPath);
		client.send({ id: "sf1", method: "steer.force", params: { runId: fx.runId, taskId: fx.taskId, body: "GUAVA" } });
		const reply = await client.waitFor("sf1");
		assert.ok(!reply.error, `unexpected error: ${JSON.stringify(reply.error)}`);
		const result = reply.result as Record<string, unknown>;
		assert.equal(result.auth, "forced");
		assert.equal(result.ok, true);

		// Broker-SIGNED steering line — verifiable with the broker host's
		// public key (a key every worker of this run holds).
		const steeringFile = path.join(fx.manifest.artifactsRoot, "steering", `${fx.taskId}.jsonl`);
		assert.ok(fs.existsSync(steeringFile), "steering file written");
		const line = JSON.parse(fs.readFileSync(steeringFile, "utf8").trim()) as Record<string, unknown>;
		assert.equal(line.message, "GUAVA");
		assert.ok(typeof line.sig === "string" && (line.sig as string).length > 0, "row carries a signature");

		// Mailbox row (kind steer, interrupt).
		const inbox = path.join(fx.manifest.stateRoot, "mailbox", "tasks", fx.taskId, "inbox.jsonl");
		assert.ok(fs.existsSync(inbox), "mailbox row written");
		const row = JSON.parse(fs.readFileSync(inbox, "utf8").trim()) as Record<string, unknown>;
		assert.equal(row.kind, "steer");
		assert.equal(row.body, "GUAVA");

		// Audit event (buffered append — poll briefly for it to land).
		let events = "";
		for (let i = 0; i < 20 && !events.includes("steer.broker_force"); i++) {
			try {
				events = fs.readFileSync(fx.manifest.eventsPath, "utf8");
			} catch {
				events = "";
			}
			if (!events.includes("steer.broker_force")) await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(events.includes("steer.broker_force"), "audit event present");
		assert.ok(events.includes('"auth":"forced"'), "auth:forced recorded");
		client.destroy();
	} finally {
		await fx.stop();
	}
});

test("steer.force: terminal task is rejected (live-task gate)", async () => {
	const fx = await scaffold();
	try {
		// Flip the disk task terminal directly.
		const tasksPath = fx.manifest.tasksPath;
		const disk = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as Array<Record<string, unknown>>;
		disk[0]!.status = "completed";
		fs.writeFileSync(tasksPath, JSON.stringify(disk));
		const client = await rawConnect(fx.socketPath);
		client.send({ id: "sf2", method: "steer.force", params: { runId: fx.runId, taskId: fx.taskId, body: "LATE" } });
		const reply = await client.waitFor("sf2");
		assert.ok(reply.error, "terminal task must be rejected");
		assert.equal((reply.error as Record<string, unknown>).code, "no-task");
		client.destroy();
	} finally {
		await fx.stop();
	}
});

test("steer.force: unknown task and bad params rejected; requestId dedupes the write pair", async () => {
	const fx = await scaffold();
	try {
		const client = await rawConnect(fx.socketPath);
		client.send({ id: "sf3", method: "steer.force", params: { runId: fx.runId, body: "missing taskId" } });
		assert.equal(((await client.waitFor("sf3")).error as Record<string, unknown>).code, "bad-params");
		client.send({ id: "sf4", method: "steer.force", params: { runId: fx.runId, taskId: "no-such-task", body: "x" } });
		assert.equal(((await client.waitFor("sf4")).error as Record<string, unknown>).code, "no-task");
		client.send({ id: "sf5", method: "steer.force", params: { runId: "team_nope", taskId: fx.taskId, body: "x" } });
		assert.equal(((await client.waitFor("sf5")).error as Record<string, unknown>).code, "no-manifest");

		// requestId dedup (R2-L-A4 mirror): the resend must not duplicate the
		// steering line or the mailbox row.
		const p = { runId: fx.runId, taskId: fx.taskId, body: "SALAK", requestId: "dedup-1" };
		client.send({ id: "sf6", method: "steer.force", params: p });
		const first = (await client.waitFor("sf6")).result as Record<string, unknown>;
		assert.equal(first.deduped, false);
		client.send({ id: "sf7", method: "steer.force", params: p });
		const second = (await client.waitFor("sf7")).result as Record<string, unknown>;
		assert.equal(second.deduped, true, "resend dedupes");
		const steeringFile = path.join(fx.manifest.artifactsRoot, "steering", `${fx.taskId}.jsonl`);
		const lines = fs.readFileSync(steeringFile, "utf8").trim().split("\n");
		assert.equal(lines.length, 1, "exactly one steering line after dedup resend");
		client.destroy();
	} finally {
		await fx.stop();
	}
});
