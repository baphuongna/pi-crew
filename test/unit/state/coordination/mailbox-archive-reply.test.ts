/**
 * DR-04 W5 / R7-3 + L-9 (2026-10-16).
 *
 * R7-3: `updateMailboxMessageReply` only scanned LIVE mailbox files —
 * rotation moves the original into `*.archive.jsonl`, so a reply to a rotated
 * message was silently lost. Fix: archives stay immutable; the reply is
 * appended to the LIVE file as a compensating record (same id + reply
 * metadata) and `safeReadMailboxFile` merges by id last-wins (live beats
 * archive), so readers see ONE reply-marked copy.
 *
 * L-9: `validateMailbox` now also validates/repairs task mailboxes
 * (`mailbox/tasks/<id>/*.jsonl`) and includes task messages in the
 * delivery-entry check.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	appendMailboxMessage,
	readAllMailboxMessages,
	readMailbox,
	readMailboxMessage,
	signMailboxMessage,
	updateMailboxMessageReply,
	validateMailbox,
} from "../../../../src/state/coordination/mailbox.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "archive",
	description: "archive reply test",
	source: "builtin",
	filePath: "archive.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "archive",
	description: "archive reply test",
	source: "builtin",
	filePath: "archive.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

function setupCwd(): string {
	// CI platform parity (2026-10-16, caught by the 0.11.22 matrix): the
	// manifest (product createRunManifest) records a stateRoot canonicalized
	// with realpathSync.NATIVE — validateMailbox reports issue paths from that
	// root, so the test must compare against the SAME form. Plain realpathSync
	// fixes macOS (/var → /private/var) but NOT Windows 8.3 short names
	// (RUNNER~1 → runneradmin — only .native expands those).
	const cwd = (() => {
		const lexical = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-archive-reply-"));
		try {
			return fs.realpathSync.native(lexical);
		} catch {
			try {
				return fs.realpathSync(lexical);
			} catch {
				return lexical;
			}
		}
	})();
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

/** Simulate rotateMailboxFileIfNeeded exactly: rename live → archive,
 *  recreate an empty live file. */
function rotateFile(livePath: string): string {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const archivePath = `${livePath}.${ts}.archive.jsonl`;
	fs.renameSync(livePath, archivePath);
	fs.writeFileSync(livePath, "", "utf-8");
	return archivePath;
}

test("R7-3: reply to a rotated (archived) message surfaces repliedAt via readMailboxMessage", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "archived reply" });
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "leader",
			to: "all",
			body: "Original question",
		});
		// Sanity: message readable pre-rotation.
		assert.ok(readMailboxMessage(manifest, original.id), "original readable while live");

		const archivePath = rotateFile(path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox", "outbox.jsonl"));
		assert.equal(fs.readFileSync(archivePath, "utf-8").trim().length > 0, true, "archive holds the original");
		assert.equal(
			fs.readFileSync(path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox", "outbox.jsonl"), "utf-8"),
			"",
			"live file recreated empty",
		);

		// Regression: archive-only message still readable (merge did not break reads).
		assert.ok(readMailboxMessage(manifest, original.id), "archived original still readable");

		const archiveBefore = fs.readFileSync(archivePath, "utf-8");

		updateMailboxMessageReply(manifest, original.id, "Here is the answer");

		// Archive is immutable history — byte-identical after the reply.
		assert.equal(fs.readFileSync(archivePath, "utf-8"), archiveBefore, "archive must not be rewritten");

		// Reader merge: exactly ONE message with the id, carrying reply metadata.
		const updated = readMailboxMessage(manifest, original.id);
		assert.ok(updated, "readMailboxMessage finds the reply-marked record");
		assert.ok(updated.repliedAt, "repliedAt set on merged record");
		assert.equal(updated.replyContent, "Here is the answer");
		const withId = readMailbox(manifest, "outbox").filter((m) => m.id === original.id);
		assert.equal(withId.length, 1, "no duplicate archived+compensating copies surface to readers");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R7-3: compensating record is appended to the LIVE file (not the archive)", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "compensating append" });
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "leader",
			to: "all",
			body: "Original question",
		});
		const mailboxDir = path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox");
		rotateFile(path.join(mailboxDir, "outbox.jsonl"));

		updateMailboxMessageReply(manifest, original.id, "answer");

		const liveLines = fs.readFileSync(path.join(mailboxDir, "outbox.jsonl"), "utf-8").split(/\r?\n/).filter(Boolean);
		assert.equal(liveLines.length, 1, "live file holds the compensating record");
		const stored = JSON.parse(liveLines[0] ?? "") as { id: string; repliedAt?: string; replyContent?: string };
		assert.equal(stored.id, original.id, "compensating record keeps the SAME id");
		assert.ok(stored.repliedAt, "compensating record carries repliedAt");
		assert.equal(stored.replyContent, "answer");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R7-3: task mailbox archives are scanned too (task-scoped original)", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "task archive" });
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "01_explore",
			to: "leader",
			taskId: "01_explore",
			body: "Task question",
		});
		const taskMailbox = path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox", "tasks", "01_explore");
		const archivePath = rotateFile(path.join(taskMailbox, "outbox.jsonl"));

		updateMailboxMessageReply(manifest, original.id, "task answer");

		// Archive untouched.
		const archivedLines = fs.readFileSync(archivePath, "utf-8").split(/\r?\n/).filter(Boolean);
		const archivedOriginal = JSON.parse(archivedLines[0] ?? "") as { repliedAt?: string };
		assert.equal(archivedOriginal.repliedAt, undefined, "archived original keeps no reply metadata");

		// Task readers (readAllMailboxMessages walks tasks dir) see the merged record once.
		const matches = readAllMailboxMessages(manifest).filter((m) => m.id === original.id);
		assert.equal(matches.length, 1, "task message surfaces exactly once");
		assert.ok(matches[0]?.repliedAt, "task reply metadata visible after merge");
		assert.equal(matches[0]?.replyContent, "task answer");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("R7-3: live-file originals still get the in-place rewrite (no compensating record)", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "live rewrite" });
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "leader",
			to: "all",
			body: "Original question",
		});
		updateMailboxMessageReply(manifest, original.id, "live answer");
		const updated = readMailboxMessage(manifest, original.id);
		assert.ok(updated?.repliedAt, "live rewrite still works");
		assert.equal(updated?.replyContent, "live answer");
		const mailboxDir = path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox");
		const liveLines = fs.readFileSync(path.join(mailboxDir, "outbox.jsonl"), "utf-8").split(/\r?\n/).filter(Boolean);
		assert.equal(liveLines.length, 1, "no duplicate rows appended for a live original");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("L-9: corrupt line in a TASK mailbox is reported (and repaired) by validateMailbox", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "validate task" });
		appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "valid task message",
		});
		const taskInbox = path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox", "tasks", "01_explore", "inbox.jsonl");
		fs.appendFileSync(taskInbox, "{{{not-json\n", "utf-8");

		const report = validateMailbox(manifest);
		const issue = report.issues.find((i) => i.path === taskInbox);
		assert.ok(issue, `corrupt task-mailbox line must be reported (issues: ${JSON.stringify(report.issues)})`);
		assert.equal(issue?.level, "error");

		const repairedReport = validateMailbox(manifest, { repair: true });
		assert.ok(
			repairedReport.repaired.includes(taskInbox),
			`task mailbox file must appear in repaired list (${JSON.stringify(repairedReport.repaired)})`,
		);
		const after = validateMailbox(manifest);
		assert.equal(
			after.issues.find((i) => i.path === taskInbox),
			undefined,
			"corrupt line gone after repair",
		);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("L-9: task messages participate in the delivery-entry check", async () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow, goal: "delivery check" });
		// Valid message appended WITHOUT going through appendMailboxMessage →
		// no delivery entry → validate must warn (L-9 extends the check to tasks).
		const taskInbox = path.join(cwd, ".crew", "state", "runs", manifest.runId, "mailbox", "tasks", "01_explore", "inbox.jsonl");
		fs.mkdirSync(path.dirname(taskInbox), { recursive: true });
		const orphanId = "orphan-task-msg-1";
		fs.writeFileSync(
			taskInbox,
			// w1a: delivery-entry coverage walks the SIGNED delivery-read path, so
			// the fixture row carries the test-process signature like any append.
			`${JSON.stringify(
				signMailboxMessage({
					id: orphanId,
					runId: manifest.runId,
					direction: "inbox",
					from: "leader",
					to: "01_explore",
					body: "orphan",
					createdAt: new Date().toISOString(),
					status: "queued",
					taskId: "01_explore",
				}),
			)}\n`,
			"utf-8",
		);

		const report = validateMailbox(manifest);
		assert.ok(
			report.issues.some((i) => i.message.includes(orphanId)),
			`missing delivery entry for task message must be reported (${JSON.stringify(report.issues)})`,
		);

		const repaired = validateMailbox(manifest, { repair: true });
		assert.ok(
			repaired.repaired.some((p) => p.endsWith("delivery.json")),
			"delivery state must be rewritten by repair",
		);
		// NOTE: the REPAIR run still reports the pre-repair warning (issues are
		// collected before backfill) — the clean signal is the NEXT validate run.
		const afterRepair = validateMailbox(manifest);
		assert.equal(
			afterRepair.issues.some((i) => i.message.includes(orphanId)),
			false,
			"repair backfills the delivery entry (next run is clean)",
		);
	} finally {
		await removeDirWithRetry(cwd);
	}
});
