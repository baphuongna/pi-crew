import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import {
	acknowledgeMailboxMessage,
	appendMailboxMessage,
	readDeliveryState,
	replayPendingMailboxMessages,
} from "../../../../src/state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-replay-retention",
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

/**
 * Seed `queued` delivery entries + matching inbox lines directly on disk, plus
 * one entry already acknowledged. Returns the acked message id.
 */
function seedDeliveryCap(stateRoot: string, queued: number, ackId: string): void {
	const mailboxDir = path.join(stateRoot, "mailbox");
	fs.mkdirSync(mailboxDir, { recursive: true });
	const lines: string[] = [];
	const messages: Record<string, string> = {};
	for (let i = 0; i < queued; i += 1) {
		const id = `msg_seed_${i}`;
		lines.push(
			JSON.stringify({
				id,
				runId: "mailbox-replay-retention",
				direction: "inbox",
				from: "leader",
				to: "team",
				body: `seed ${i}`,
				createdAt: new Date(Date.now() - 60_000 + i).toISOString(),
				status: "queued",
			}),
		);
		messages[id] = "queued";
	}
	lines.push(
		JSON.stringify({
			id: ackId,
			runId: "mailbox-replay-retention",
			direction: "inbox",
			from: "leader",
			to: "team",
			body: "already acknowledged",
			createdAt: new Date(Date.now() - 30_000).toISOString(),
			status: "queued",
		}),
	);
	messages[ackId] = "acknowledged";
	fs.writeFileSync(path.join(mailboxDir, "inbox.jsonl"), `${lines.join("\n")}\n`, "utf-8");
	fs.writeFileSync(
		path.join(mailboxDir, "delivery.json"),
		`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		"utf-8",
	);
}

function firstText(result: Awaited<ReturnType<typeof handleTeamTool>>): string {
	const first = result.content?.[0];
	return first && "text" in first ? String(first.text) : "";
}

test("mailbox replay redelivers pending inbox messages and skips acknowledged messages", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-replay-"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox replay",
			},
			{ cwd },
		);
		const runId = run.details?.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		const rootMessage = appendMailboxMessage(loaded.manifest, {
			direction: "inbox",
			from: "leader",
			to: "team",
			body: "root",
		});
		const taskMessage = appendMailboxMessage(loaded.manifest, {
			direction: "inbox",
			from: "leader",
			to: loaded.tasks[0]!.id,
			taskId: loaded.tasks[0]!.id,
			body: "task",
		});
		const acked = appendMailboxMessage(loaded.manifest, {
			direction: "inbox",
			from: "leader",
			to: "team",
			body: "acked",
		});
		acknowledgeMailboxMessage(loaded.manifest, acked.id);

		const replay = replayPendingMailboxMessages(loaded.manifest);
		assert.deepEqual(replay.messages.map((message) => message.id).sort(), [rootMessage.id, taskMessage.id].sort());
		const delivery = readDeliveryState(loaded.manifest);
		assert.equal(delivery.messages[rootMessage.id], "delivered");
		assert.equal(delivery.messages[taskMessage.id], "delivered");
		assert.equal(delivery.messages[acked.id], "acknowledged");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume emits mailbox replay event before rerunning queued work", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-resume-"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox resume",
			},
			{ cwd },
		);
		const runId = run.details?.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		appendMailboxMessage(loaded.manifest, {
			direction: "inbox",
			from: "leader",
			to: loaded.tasks[0]!.id,
			taskId: loaded.tasks[0]!.id,
			body: "resume me",
		});
		const resumed = await handleTeamTool(
			{
				action: "resume",
				runId,
				config: { runtime: { mode: "scaffold" } },
			},
			{ cwd },
		);
		assert.equal(resumed.isError, false);
		const events = await handleTeamTool({ action: "events", runId }, { cwd });
		assert.match(firstText(events), /mailbox\.replayed/);
		assert.match(firstText(events), /replayedMailboxMessages/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// F09 / RR-016 — delivery retention must never make an acknowledged message
// replayable again. Baseline (measured before the fix): with 10000 seeded
// delivery entries (9999 queued + 1 acknowledged), appending ONE message made
// writeDeliveryState prune by `queued(0) < delivered(1) < acknowledged(2)` and
// `slice(0, 10000)` — i.e. it evicted the ACKNOWLEDGED entry first. Replay then
// returned the acked message on EVERY resume (it only ever writes "delivered"),
// so the acked message was re-delivered forever and the replay set grew to
// O(10001) on each resume.
// ---------------------------------------------------------------------------

test("F09: an acknowledged message is not evicted by the delivery cap and never replays", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-cap-"));
	try {
		const stateRoot = path.join(cwd, "state", "runs", "mailbox-replay-retention");
		const manifest = makeManifest(stateRoot);
		const ackId = "msg_ack_under_cap";
		seedDeliveryCap(stateRoot, 9999, ackId);
		assert.equal(Object.keys(readDeliveryState(manifest).messages).length, 10_000, "seeded at the cap");

		// Crossing the cap must NOT drop the acknowledged entry.
		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "fresh" });
		const delivery = readDeliveryState(manifest);
		assert.equal(Object.keys(delivery.messages).length, 10_000, "cap still enforced");
		assert.equal(delivery.messages[ackId], "acknowledged", "acked entry must survive the cap (baseline: EVICTED)");

		// And it must not replay — on this resume or any later one (AC-8, AC-9).
		for (let round = 1; round <= 3; round += 1) {
			const replay = replayPendingMailboxMessages(manifest);
			assert.equal(
				replay.messages.some((message) => message.id === ackId),
				false,
				`resume #${round} must not replay the acknowledged message`,
			);
			assert.equal(readDeliveryState(manifest).messages[ackId], "acknowledged", `ack survives resume #${round}`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F09: the freshly appended message still replays while the acked one does not (AC-13)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-cap-mixed-"));
	try {
		const stateRoot = path.join(cwd, "state", "runs", "mailbox-replay-retention");
		const manifest = makeManifest(stateRoot);
		const ackId = "msg_ack_mixed";
		seedDeliveryCap(stateRoot, 9999, ackId);
		const fresh = appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "fresh" });

		const replay = replayPendingMailboxMessages(manifest);
		const ids = replay.messages.map((message) => message.id);
		assert.equal(ids.includes(fresh.id), true, "new message must replay");
		assert.equal(ids.includes(ackId), false, "acked message must not replay");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F09: with no acknowledgements, the queued→delivered eviction order is unchanged (AC-12)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-cap-order-"));
	try {
		const stateRoot = path.join(cwd, "state", "runs", "mailbox-replay-retention");
		const manifest = makeManifest(stateRoot);
		const mailboxDir = path.join(stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });
		// 9998 queued (oldest) + 2 delivered (newest), then one append crosses the cap.
		const lines: string[] = [];
		const messages: Record<string, string> = {};
		for (let i = 0; i < 9998; i += 1) {
			const id = `msg_q_${i}`;
			messages[id] = "queued";
			lines.push(
				JSON.stringify({
					id,
					runId: "mailbox-replay-retention",
					direction: "inbox",
					from: "leader",
					to: "team",
					body: `q ${i}`,
					createdAt: new Date(Date.now() - 60_000 + i).toISOString(),
					status: "queued",
				}),
			);
		}
		for (const id of ["msg_d_0", "msg_d_1"]) {
			messages[id] = "delivered";
			lines.push(
				JSON.stringify({
					id,
					runId: "mailbox-replay-retention",
					direction: "inbox",
					from: "leader",
					to: "team",
					body: id,
					createdAt: new Date(Date.now() - 1000).toISOString(),
					status: "delivered",
				}),
			);
		}
		fs.writeFileSync(path.join(mailboxDir, "inbox.jsonl"), `${lines.join("\n")}\n`, "utf-8");
		fs.writeFileSync(
			path.join(mailboxDir, "delivery.json"),
			`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
			"utf-8",
		);

		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "trigger" });
		const delivery = readDeliveryState(manifest);
		assert.equal(Object.keys(delivery.messages).length, 10_000, "cap enforced");
		// Unchanged legacy order: the sort is ascending by priority and the FIRST
		// `MAX` entries are kept, so `queued` (0) outranks `delivered` (1) outranks
		// `acknowledged` (2) — i.e. acknowledged is evicted first, then delivered.
		// With 9999 queued + 2 delivered the one survivor of the delivered tier is
		// the first-inserted, and NO queued entry is dropped.
		assert.equal(delivery.messages.msg_d_0, "delivered", "the first delivered entry survives");
		assert.equal(delivery.messages.msg_d_1, undefined, "the delivered tier is drained before queued (legacy order)");
		assert.equal(delivery.messages.msg_q_0, "queued", "queued entries are never evicted ahead of delivered ones");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F09: acknowledged entries are still bounded when their message left the replayable history", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-ack-sweep-"));
	try {
		const stateRoot = path.join(cwd, "state", "runs", "mailbox-replay-retention");
		const manifest = makeManifest(stateRoot);
		// 6000 acked ids that have NO inbox line at all → provably dead → swept.
		// 1000 acked ids WITH an inbox line → must be kept (they are still replayable
		// in principle, so their ack is the only thing stopping a replay).
		const mailboxDir = path.join(stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });
		const lines: string[] = [];
		const messages: Record<string, string> = {};
		for (let i = 0; i < 6000; i += 1) messages[`msg_gone_${i}`] = "acknowledged";
		for (let i = 0; i < 1000; i += 1) {
			const id = `msg_live_${i}`;
			messages[id] = "acknowledged";
			lines.push(
				JSON.stringify({
					id,
					runId: "mailbox-replay-retention",
					direction: "inbox",
					from: "leader",
					to: "team",
					body: `live ${i}`,
					createdAt: new Date(Date.now() - 60_000 + i).toISOString(),
					status: "queued",
				}),
			);
		}
		fs.writeFileSync(path.join(mailboxDir, "inbox.jsonl"), `${lines.join("\n")}\n`, "utf-8");
		fs.writeFileSync(
			path.join(mailboxDir, "delivery.json"),
			`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
			"utf-8",
		);

		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "trigger" });
		const delivery = readDeliveryState(manifest);
		assert.equal(delivery.messages.msg_gone_0, undefined, "acks for messages with no inbox line are swept");
		assert.equal(delivery.messages.msg_live_0, "acknowledged", "acks for still-replayable messages are kept");
		const replay = replayPendingMailboxMessages(manifest);
		assert.equal(
			replay.messages.some((message) => message.id.startsWith("msg_live_")),
			false,
			"every kept ack still suppresses its replay",
		);
		assert.deepEqual(
			replay.messages.map((message) => message.id).filter((id) => id.startsWith("msg_gone_")),
			[],
			"swept acks have no inbox line left, so nothing of theirs can replay",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F09: acks for messages that live in an ARCHIVE file are still protected", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-cap-archive-"));
	try {
		const stateRoot = path.join(cwd, "state", "runs", "mailbox-replay-retention");
		const manifest = makeManifest(stateRoot);
		const mailboxDir = path.join(stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });
		const ackId = "msg_archived_ack";
		// Fill the cap with queued entries so the NEXT write prunes, and put the
		// acknowledged message only in a rotated archive — safeReadMailboxFile still
		// replays archives, so its ack must be protected exactly like a live one.
		const lines: string[] = [];
		const messages: Record<string, string> = {};
		for (let i = 0; i < 9999; i += 1) {
			const id = `msg_seed_${i}`;
			lines.push(
				JSON.stringify({
					id,
					runId: "mailbox-replay-retention",
					direction: "inbox",
					from: "leader",
					to: "team",
					body: `seed ${i}`,
					createdAt: new Date(Date.now() - 60_000 + i).toISOString(),
					status: "queued",
				}),
			);
			messages[id] = "queued";
		}
		messages[ackId] = "acknowledged";
		fs.writeFileSync(path.join(mailboxDir, "inbox.jsonl"), `${lines.join("\n")}\n`, "utf-8");
		fs.writeFileSync(
			path.join(mailboxDir, "inbox.jsonl.2026-01-01T00-00-00-000Z.archive.jsonl"),
			`${JSON.stringify({
				id: ackId,
				runId: "mailbox-replay-retention",
				direction: "inbox",
				from: "leader",
				to: "team",
				body: "archived",
				createdAt: new Date(Date.now() - 120_000).toISOString(),
				status: "queued",
			})}\n`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(mailboxDir, "delivery.json"),
			`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
			"utf-8",
		);

		appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "trigger" });
		assert.equal(readDeliveryState(manifest).messages[ackId], "acknowledged", "archived ack must be kept");
		const replay = replayPendingMailboxMessages(manifest);
		assert.equal(
			replay.messages.some((message) => message.id === ackId),
			false,
			"archived acked message must not replay",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
