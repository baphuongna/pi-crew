/**
 * Tests for src/state/mailbox.ts
 *
 * Mailbox operations require a proper stateRoot directory structure.
 * These tests exercise the core public API: readMailbox, appendMailboxMessage,
 * appendSteeringMessage, appendFollowUpMessage, acknowledgeMailboxMessage,
 * validateMailbox, replayPendingMailboxMessages, readDeliveryState, etc.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acknowledgeMailboxMessage,
	appendFollowUpMessage,
	appendMailboxMessage,
	appendSteeringMessage,
	listMailboxByKind,
	readAllMailboxMessages,
	readDeliveryState,
	readMailbox,
	readMailboxMessage,
	replayPendingMailboxMessages,
	updateMailboxMessageReply,
	validateMailbox,
} from "../../src/state/mailbox.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "mailbox-test-run",
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

function setupMailboxWorkspace(): { dir: string; manifest: TeamRunManifest } {
	const dir = createTrackedTempDir("mailbox-cov-");
	const stateRoot = path.join(dir, "state", "runs", "mailbox-test-run");
	fs.mkdirSync(stateRoot, { recursive: true });
	return { dir, manifest: makeManifest(stateRoot) };
}

// ─── appendMailboxMessage ─────────────────────────────────────────────────

describe("appendMailboxMessage writes a message", () => {
	it("appends an outbox message and returns it with id and runId", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "outbox",
				from: "leader",
				to: "worker-1",
				body: "Hello worker",
			});

			assert.ok(msg.id, "should have an auto-generated id");
			assert.equal(msg.runId, manifest.runId);
			assert.equal(msg.direction, "outbox");
			assert.equal(msg.from, "leader");
			assert.equal(msg.to, "worker-1");
			assert.equal(msg.body, "Hello worker");
			assert.equal(msg.status, "queued");
			assert.ok(msg.createdAt);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("appendMailboxMessage preserves explicit id", () => {
	it("uses the provided id instead of generating one", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				id: "custom-msg-id",
				direction: "inbox",
				from: "worker",
				to: "leader",
				body: "Status update",
			});
			assert.equal(msg.id, "custom-msg-id");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("appendMailboxMessage sets status to delivered when provided", () => {
	it("honors explicit status field", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "worker",
				to: "leader",
				body: "Already delivered",
				status: "delivered",
			});
			assert.equal(msg.status, "delivered");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── readMailbox ──────────────────────────────────────────────────────────

describe("readMailbox returns messages", () => {
	it("reads back previously appended messages", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Get to work",
			});
			appendMailboxMessage(manifest, {
				direction: "outbox",
				from: "worker",
				to: "leader",
				body: "Working on it",
			});

			const messages = readMailbox(manifest);
			assert.equal(messages.length, 2);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("readMailbox filters by direction", () => {
	it("returns only inbox messages when direction is specified", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Inbox message",
			});
			appendMailboxMessage(manifest, {
				direction: "outbox",
				from: "worker",
				to: "leader",
				body: "Outbox message",
			});

			const inbox = readMailbox(manifest, "inbox");
			assert.equal(inbox.length, 1);
			assert.equal(inbox[0].direction, "inbox");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("readMailbox filters by kind", () => {
	it("returns only messages matching the specified kind", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendSteeringMessage(manifest, {
				taskId: "01_task",
				body: "Steer!",
			});
			appendFollowUpMessage(manifest, {
				taskId: "01_task",
				body: "Follow up",
			});

			// Steering messages are written to task-specific mailboxes;
			// readMailbox with taskId returns messages from that task's mailbox.
			const steers = readMailbox(manifest, "inbox", "01_task", "steer");
			assert.equal(steers.length, 1);
			assert.equal(steers[0].kind, "steer");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── appendSteeringMessage ────────────────────────────────────────────────

describe("appendSteeringMessage creates a steering inbox message", () => {
	it("sets kind=steer, priority=urgent, deliveryMode=interrupt", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendSteeringMessage(manifest, {
				taskId: "01_task",
				body: "Change direction",
			});

			assert.equal(msg.direction, "inbox");
			assert.equal(msg.kind, "steer");
			assert.equal(msg.priority, "urgent");
			assert.equal(msg.deliveryMode, "interrupt");
			assert.equal(msg.taskId, "01_task");
			assert.equal(msg.from, "leader");
			assert.equal(msg.to, "01_task");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("appendSteeringMessage uses custom from/to", () => {
	it("honors custom from and to fields", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendSteeringMessage(manifest, {
				taskId: "01_task",
				body: "Steer",
				from: "orchestrator",
				to: "agent-1",
			});
			assert.equal(msg.from, "orchestrator");
			assert.equal(msg.to, "agent-1");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── appendFollowUpMessage ────────────────────────────────────────────────

describe("appendFollowUpMessage creates a follow-up inbox message", () => {
	it("sets kind=follow-up, priority=normal, deliveryMode=next_turn", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendFollowUpMessage(manifest, {
				taskId: "02_task",
				body: "Check on this",
			});

			assert.equal(msg.direction, "inbox");
			assert.equal(msg.kind, "follow-up");
			assert.equal(msg.priority, "normal");
			assert.equal(msg.deliveryMode, "next_turn");
			assert.equal(msg.taskId, "02_task");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── readDeliveryState ────────────────────────────────────────────────────

describe("readDeliveryState returns initial state", () => {
	it("returns empty messages map for new mailbox", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			// Trigger mailbox creation
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "a",
				to: "b",
				body: "init",
			});
			const state = readDeliveryState(manifest);
			assert.ok(state.messages);
			assert.ok(state.updatedAt);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── acknowledgeMailboxMessage ────────────────────────────────────────────

describe("acknowledgeMailboxMessage updates delivery state", () => {
	it("marks a message as acknowledged", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Ack this",
			});

			const delivery = acknowledgeMailboxMessage(manifest, msg.id);
			assert.equal(delivery.messages[msg.id], "acknowledged");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("acknowledgeMailboxMessage throws for unknown message", () => {
	it("throws when message ID is not found", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "a",
				to: "b",
				body: "init",
			});
			assert.throws(() => acknowledgeMailboxMessage(manifest, "nonexistent-msg"), /not found/);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── validateMailbox ──────────────────────────────────────────────────────

describe("validateMailbox reports no issues for clean mailbox", () => {
	it("returns empty issues for well-formed mailbox", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Valid message",
			});

			const report = validateMailbox(manifest);
			assert.equal(report.issues.length, 0);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("validateMailbox repairs invalid lines", () => {
	it("removes invalid JSONL lines when repair=true", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Good",
			});

			// Manually append a garbage line to inbox.jsonl
			const mailboxDir = path.join(manifest.stateRoot, "mailbox");
			const inboxPath = path.join(mailboxDir, "inbox.jsonl");
			fs.appendFileSync(inboxPath, "THIS IS NOT JSON\n");

			const report = validateMailbox(manifest, { repair: true });
			assert.ok(report.issues.length >= 1, "should report the garbage line");
			assert.ok(report.repaired.length >= 1, "should repair the file");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── replayPendingMailboxMessages ─────────────────────────────────────────

describe("replayPendingMailboxMessages delivers queued messages", () => {
	it("returns pending inbox messages and marks them delivered", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Pending msg",
			});

			const result = replayPendingMailboxMessages(manifest);
			assert.equal(result.messages.length, 1);
			assert.equal(result.messages[0].body, "Pending msg");

			// Delivery state should now show "delivered"
			const delivery = readDeliveryState(manifest);
			assert.equal(delivery.messages[result.messages[0].id], "delivered");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("replayPendingMailboxMessages returns empty when all acknowledged", () => {
	it("returns no messages after all are acknowledged", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Will be acked",
			});
			acknowledgeMailboxMessage(manifest, msg.id);

			const result = replayPendingMailboxMessages(manifest);
			assert.equal(result.messages.length, 0);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── readMailboxMessage ───────────────────────────────────────────────────

describe("readMailboxMessage finds message by ID", () => {
	it("returns the message with matching ID", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "a",
				to: "b",
				body: "Find me",
			});

			const found = readMailboxMessage(manifest, msg.id);
			assert.ok(found);
			assert.equal(found!.id, msg.id);
			assert.equal(found!.body, "Find me");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

describe("readMailboxMessage returns undefined for unknown ID", () => {
	it("returns undefined when no message matches", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "a",
				to: "b",
				body: "Exists",
			});
			assert.equal(readMailboxMessage(manifest, "nonexistent"), undefined);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── listMailboxByKind ────────────────────────────────────────────────────

describe("listMailboxByKind filters messages by kind", () => {
	it("returns only steering messages", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendSteeringMessage(manifest, { taskId: "01", body: "Steer" });
			appendFollowUpMessage(manifest, { taskId: "01", body: "Follow" });

			const steers = listMailboxByKind(manifest, "steer");
			assert.equal(steers.length, 1);
			assert.equal(steers[0].kind, "steer");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── updateMailboxMessageReply ────────────────────────────────────────────

describe("updateMailboxMessageReply updates original message", () => {
	it("adds repliedAt and replyContent to the original message", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Need response",
			});

			updateMailboxMessageReply(manifest, msg.id, "Here is my reply");

			const updated = readMailboxMessage(manifest, msg.id);
			assert.ok(updated);
			assert.equal(updated!.replyContent, "Here is my reply");
			assert.ok(updated!.repliedAt);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── Task-specific mailbox ────────────────────────────────────────────────

describe("appendMailboxMessage with taskId creates task mailbox", () => {
	it("appends to task-specific mailbox and can be read back", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			const msg = appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "01_task",
				body: "Task-specific message",
				taskId: "01_task",
			});

			assert.equal(msg.taskId, "01_task");

			// Read task-specific inbox
			const taskMessages = readMailbox(manifest, "inbox", "01_task");
			assert.equal(taskMessages.length, 1);
			assert.equal(taskMessages[0].body, "Task-specific message");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── readAllMailboxMessages ───────────────────────────────────────────────

describe("readAllMailboxMessages includes both run and task messages", () => {
	it("reads messages from global and task mailboxes", () => {
		const { dir, manifest } = setupMailboxWorkspace();
		try {
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "worker",
				body: "Global message",
			});
			appendMailboxMessage(manifest, {
				direction: "inbox",
				from: "leader",
				to: "01_task",
				body: "Task message",
				taskId: "01_task",
			});

			const all = readAllMailboxMessages(manifest, "inbox");
			assert.equal(all.length, 2);
			assert.ok(all.some((m) => m.body === "Global message"));
			assert.ok(all.some((m) => m.body === "Task message"));
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
