/**
 * Review-round MAJOR 1 (HIGH, 2026-09-17 review of the F01–F20 remediation
 * wave): sweepDeadAcknowledgements must be FAIL-CLOSED when the replayable
 * history cannot be read.
 *
 * THE BUG: collectReplayableInboxIds caught read errors and returned an EMPTY
 * set — indistinguishable at the call site from "no messages are replayable".
 * sweepDeadAcknowledgements then treated every acknowledged entry as dead and
 * deleted ALL of them, so already-processed messages would replay (the exact
 * F09 bug class, re-introduced by its own guard). Trigger: ≥1000 acks +
 * a transient read error (EPERM/EBUSY) or a symlinked/corrupt tasks root at
 * the moment the sweep runs.
 *
 * FAIL-CLOSED CONTRACT (this file pins it): when the history read throws, the
 * sweep must abort, delete NOTHING, and not consume the throttle window — so
 * the next prune retries once the filesystem is readable again.
 *
 * RED (pre-fix): the 1001 acknowledged entries below are wiped from
 * delivery.json. GREEN (post-fix): they all survive and only the newly
 * appended message is added.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendMailboxMessage, readDeliveryState } from "../../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const ACK_SWEEP_MIN_ACKS = 1000; // mirrors mailbox.ts (sweep trigger threshold)

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-sweep-fail-closed-run",
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
	} as unknown as TeamRunManifest;
}

test("sweep aborts fail-closed when the replayable history is unreadable (symlinked tasks root)", () => {
	const stateRoot = createTrackedTempDir("mbox-sweep-failclosed-");
	try {
		const manifest = makeManifest(stateRoot);
		const mailboxDir = path.join(stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });

		// Bootstrap: delivery.json already carries >ACK_SWEEP_MIN_ACKS
		// acknowledged entries, so the very next delivery write enters the sweep.
		const ackIds: string[] = [];
		const messages: Record<string, string> = {};
		for (let i = 0; i < ACK_SWEEP_MIN_ACKS + 1; i++) {
			const id = `ack_msg_${i}`;
			ackIds.push(id);
			messages[id] = "acknowledged";
		}
		fs.writeFileSync(
			path.join(mailboxDir, "delivery.json"),
			`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		);

		// Make the replayable-history read THROW deterministically: a tasks root
		// that is a symlink is rejected by safeMailboxTasksRoot (lstatSync check).
		// The symlink target EXISTS, so the existsSync fast-path in
		// safeMailboxTasksRoot is bypassed and the lstatSync symlink guard fires.
		const realTasksDir = path.join(stateRoot, "real-tasks");
		fs.mkdirSync(realTasksDir, { recursive: true });
		fs.symlinkSync(realTasksDir, path.join(mailboxDir, "tasks"), "dir");

		// Public trigger: appendMailboxMessage -> delivery read-modify-write ->
		// pruneDeliveryMessages -> sweepDeadAcknowledgements (ackedCount > 1000).
		const appended = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "team",
			body: "trigger",
		});

		// FAIL-CLOSED: the unreadable history must NOT be interpreted as "every
		// ack is dead". All acknowledged entries survive untouched…
		const state = readDeliveryState(manifest);
		for (const id of ackIds) {
			assert.equal(state.messages[id], "acknowledged", `ack ${id} must survive an unreadable-history sweep`);
		}
		// …and the new message is recorded normally.
		assert.equal(state.messages[appended.id], "queued");
	} finally {
		removeTrackedTempDir(stateRoot);
	}
});

test("aborted sweep does not consume the throttle window and resumes once the history is readable again", () => {
	const stateRoot = createTrackedTempDir("mbox-sweep-recover-");
	try {
		const manifest = makeManifest(stateRoot);
		const mailboxDir = path.join(stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });

		// Seed: 1000 acks with NO inbox line (provably dead once the sweep can
		// read the history) + 1 ack whose message IS still replayable (must never
		// be swept). 1001 acks > ACK_SWEEP_MIN_ACKS so every delivery write below
		// enters sweepDeadAcknowledgements.
		const keepId = "msg_keep";
		const deadIds: string[] = [];
		const messages: Record<string, string> = { [keepId]: "acknowledged" };
		for (let i = 0; i < ACK_SWEEP_MIN_ACKS; i++) {
			const id = `msg_dead_${i}`;
			deadIds.push(id);
			messages[id] = "acknowledged";
		}
		fs.writeFileSync(
			path.join(mailboxDir, "inbox.jsonl"),
			`${JSON.stringify({
				id: keepId,
				runId: manifest.runId,
				direction: "inbox",
				from: "leader",
				to: "team",
				body: "still replayable",
				createdAt: new Date().toISOString(),
				status: "queued",
			})}\n`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(mailboxDir, "delivery.json"),
			`${JSON.stringify({ messages, updatedAt: new Date().toISOString() }, null, 2)}\n`,
		);

		// Phase 1 — unreadable history (symlinked tasks root): the sweep ABORTS.
		const realTasksDir = path.join(stateRoot, "real-tasks");
		fs.mkdirSync(realTasksDir, { recursive: true });
		const tasksLink = path.join(mailboxDir, "tasks");
		fs.symlinkSync(realTasksDir, tasksLink, "dir");
		const first = appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "fail-closed trigger" });
		const afterAbort = readDeliveryState(manifest);
		assert.equal(afterAbort.messages[keepId], "acknowledged", "phase 1: abort keeps the replayable ack");
		for (const id of deadIds) {
			assert.equal(afterAbort.messages[id], "acknowledged", `phase 1: abort keeps dead ack ${id} (fail-closed)`);
		}

		// Phase 2 — the filesystem heals WITHIN the 30s throttle window: the
		// symlink is removed and replaced by a real directory. If the aborted
		// attempt had consumed the throttle window (recordAckSweep before the
		// read — the pre-fix ordering), this second sweep would be throttled and
		// the dead acks would survive. The fix records the timestamp ONLY after
		// a successful history read, so the retry happens immediately.
		fs.unlinkSync(tasksLink);
		fs.mkdirSync(tasksLink, { recursive: true });
		const second = appendMailboxMessage(manifest, { direction: "inbox", from: "leader", to: "team", body: "recovery trigger" });
		const afterRecovery = readDeliveryState(manifest);
		assert.equal(afterRecovery.messages[keepId], "acknowledged", "phase 2: the replayable ack is never swept");
		for (const id of deadIds) {
			assert.equal(afterRecovery.messages[id], undefined, `phase 2: dead ack ${id} is swept once the history is readable`);
		}
		// Both appended messages are themselves replayable (they have inbox
		// lines) and stay queued.
		assert.equal(afterRecovery.messages[first.id], "queued");
		assert.equal(afterRecovery.messages[second.id], "queued");
	} finally {
		removeTrackedTempDir(stateRoot);
	}
});
