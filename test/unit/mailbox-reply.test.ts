import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendMailboxMessage, readAllMailboxMessages, readMailbox, updateMailboxMessageReply } from "../../src/state/coordination/mailbox.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "reply",
	description: "reply test",
	source: "builtin",
	filePath: "reply.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "reply",
	description: "reply test",
	source: "builtin",
	filePath: "reply.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

function findMessageById(manifest: ReturnType<typeof createRunManifest>["manifest"], id: string) {
	return readAllMailboxMessages(manifest).find((m) => m.id === id);
}

function setupCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reply-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("mailbox message can have replyTo field", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "reply fields",
		});
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "01_explore",
			to: "leader",
			taskId: "01_explore",
			body: "I need clarification",
		});
		const reply = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "Here is the clarification",
			kind: "response",
			replyTo: original.id,
			replyFrom: "leader",
		});
		assert.equal(reply.replyTo, original.id);
		assert.equal(reply.replyFrom, "leader");
		assert.equal(reply.replyDeadline, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateMailboxMessageReply sets repliedAt and replyContent on original", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "reply update",
		});
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "01_explore",
			to: "leader",
			taskId: "01_explore",
			body: "Original question",
		});

		assert.equal(original.repliedAt, undefined);
		assert.equal(original.replyContent, undefined);

		updateMailboxMessageReply(manifest, original.id, "Here is the answer");

		const updated = findMessageById(manifest, original.id);
		assert.ok(updated, "Original message should still be readable");
		assert.ok(updated.repliedAt, "repliedAt should be set");
		assert.equal(updated.replyContent, "Here is the answer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("replyDeadline is preserved on reply messages", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "deadline",
		});
		const deadline = Date.now() + 60_000;
		const reply = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "Reply with deadline",
			replyDeadline: deadline,
		});
		assert.equal(reply.replyDeadline, deadline);

		const read = readMailbox(manifest, "inbox", "01_explore");
		assert.equal(read.length, 1);
		assert.equal(read[0]!.replyDeadline, deadline);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("messages without reply fields remain backward compatible", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "backward compat",
		});
		const msg = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "No reply fields",
			kind: "message",
		});
		assert.equal(msg.replyTo, undefined);
		assert.equal(msg.replyFrom, undefined);
		assert.equal(msg.replyDeadline, undefined);
		assert.equal(msg.repliedAt, undefined);
		assert.equal(msg.replyContent, undefined);

		const read = readMailbox(manifest, "inbox", "01_explore");
		assert.equal(read.length, 1);
		assert.equal(read[0]!.replyTo, undefined);
		assert.equal(read[0]!.repliedAt, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("updateMailboxMessageReply is non-fatal for missing message", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "missing original",
		});
		// Should not throw when the original message doesn't exist
		updateMailboxMessageReply(manifest, "msg_nonexistent", "reply content");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("reply message with all fields round-trips through disk", () => {
	const cwd = setupCwd();
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "full round-trip",
		});
		const deadline = Date.now() + 120_000;
		const original = appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "01_explore",
			to: "leader",
			taskId: "01_explore",
			body: "Complex question",
			replyDeadline: deadline,
		});

		updateMailboxMessageReply(manifest, original.id, "Complex answer");

		const reply = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "Complex answer",
			kind: "response",
			replyTo: original.id,
			replyFrom: "leader",
			replyDeadline: deadline,
		});

		// Verify original has reply metadata
		const updatedOriginal = findMessageById(manifest, original.id);
		assert.ok(updatedOriginal);
		assert.equal(updatedOriginal.replyContent, "Complex answer");
		assert.ok(updatedOriginal.repliedAt);

		// Verify reply has correct references
		const readReply = findMessageById(manifest, reply.id);
		assert.ok(readReply);
		assert.equal(readReply.replyTo, original.id);
		assert.equal(readReply.replyFrom, "leader");
		assert.equal(readReply.replyDeadline, deadline);

		// Verify original still preserves its own replyDeadline
		assert.equal(updatedOriginal.replyDeadline, deadline);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
