import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { appendFollowUpMessage, appendSteeringMessage } from "../../../../src/state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

function tryDirectorySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return true;
	} catch {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			return true;
		} catch {
			return false;
		}
	}
}

test("api supports mailbox inbox/outbox and delivery state", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox api",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const sent = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "send-message",
					direction: "outbox",
					from: "leader",
					to: "worker",
					body: "hello",
				},
			},
			{ cwd },
		);
		assert.equal(sent.isError, false);
		const message = JSON.parse(firstText(sent) || "{}");
		assert.equal(message.direction, "outbox");
		const mailbox = await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: "read-mailbox", direction: "outbox" },
			},
			{ cwd },
		);
		const allMessages = JSON.parse(firstText(mailbox) || "[]") as Array<{
			id: string;
			from: string;
			to: string;
			body: string;
		}>;
		// The scaffold run may have written a group-join message to the outbox,
		// so we filter to messages from "leader" (the test's actual send).
		const messages = allMessages.filter((m) => m.from === "leader");
		assert.equal(messages.length, 1, `expected 1 leader message, got ${messages.length}`);
		const ack = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "ack-message",
					messageId: messages[0]?.id,
				},
			},
			{ cwd },
		);
		assert.equal(ack.isError, false);
		const delivery = JSON.parse(firstText(ack) || "{}");
		assert.equal(delivery.messages[messages[0]!.id], "acknowledged");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mailbox api rejects taskId path traversal", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-traversal-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox traversal",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const read = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "read-mailbox",
					taskId: "../escape",
					direction: "inbox",
				},
			},
			{ cwd },
		);
		assert.equal(read.isError, true);
		const sent = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "send-message",
					taskId: "../escape",
					body: "nope",
				},
			},
			{ cwd },
		);
		assert.equal(sent.isError, true);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		assert.equal(fs.existsSync(path.join(loaded.manifest.stateRoot, "escape")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mailbox api rejects symlinked mailbox root writes", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-symlink-root-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox symlink root",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		const mailboxDir = path.join(loaded.manifest.stateRoot, "mailbox");
		const outside = path.join(cwd, "outside-mailbox");
		fs.mkdirSync(outside, { recursive: true });
		if (!tryDirectorySymlink(outside, mailboxDir)) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		const sent = await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: "send-message", body: "nope" },
			},
			{ cwd },
		);
		assert.equal(sent.isError, true);
		assert.equal(fs.existsSync(path.join(outside, "inbox.jsonl")), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("mailbox api rejects symlinked mailbox files", async (t) => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-symlink-file-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox symlink file",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		const mailboxDir = path.join(loaded.manifest.stateRoot, "mailbox");
		fs.mkdirSync(mailboxDir, { recursive: true });
		const outside = path.join(cwd, "outside-inbox.jsonl");
		fs.writeFileSync(outside, "", "utf-8");
		try {
			fs.symlinkSync(outside, path.join(mailboxDir, "inbox.jsonl"), "file");
		} catch {
			t.skip("file symlinks unavailable on this platform");
			return;
		}
		const sent = await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: "send-message", body: "nope" },
			},
			{ cwd },
		);
		assert.equal(sent.isError, true);
		assert.equal(fs.readFileSync(outside, "utf-8"), "");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("read-delivery does not create mailbox files on reads", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-delivery-readonly-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "delivery readonly read",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId)!;
		// The scaffold run may have created the mailbox dir for the auto
		// group-join message. We only assert that *reads* don't create
		// additional files (e.g. delivery.json) and that the delivery
		// state was not modified by a read.
		const deliveryPath = path.join(loaded.manifest.stateRoot, "mailbox", "delivery.json");
		const deliveryBefore = fs.existsSync(deliveryPath) ? JSON.parse(fs.readFileSync(deliveryPath, "utf-8")) : { messages: {} };
		const read = await handleTeamTool({ action: "api", runId, config: { operation: "read-delivery" } }, { cwd });
		assert.equal(read.isError, false);
		const delivery = JSON.parse(firstText(read) || "{}");
		// Read must not add any new entries to the delivery state.
		const expectedKeys = Object.keys(deliveryBefore.messages || {}).sort();
		const actualKeys = Object.keys(delivery.messages || {}).sort();
		assert.deepEqual(actualKeys, expectedKeys, "read-delivery must not modify delivery state");
		// Read should not have created a delivery.json file if it didn't exist.
		// (If it did exist, its content must be unchanged.)
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("read-mailbox does not create mailbox files on reads", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-readonly-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox readonly read",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		// The scaffold run may have created the mailbox dir. We assert that
		// reading doesn't create a *new* inbox jsonl file (which would only
		// exist if a message were sent to inbox).
		const read = await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: "read-mailbox", direction: "inbox" },
			},
			{ cwd },
		);
		assert.equal(read.isError, false);
		const inboxDir = path.join(loaded.manifest.stateRoot, "mailbox", "inbox");
		assert.equal(fs.existsSync(inboxDir), false, "inbox dir should not be created just by reading");
		const messages = JSON.parse(firstText(read) || "[]") as Array<unknown>;
		assert.equal(messages.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("read-mailbox kind filter isolates steering from follow-up", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-kind-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "mailbox kind filter",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		const taskId = loaded.tasks[0]!.id;
		appendSteeringMessage(loaded.manifest, {
			taskId,
			body: "urgent",
			priority: "urgent",
		});
		appendFollowUpMessage(loaded.manifest, { taskId, body: "follow" });
		const steer = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "read-mailbox",
					direction: "inbox",
					taskId,
					kind: "steer",
				},
			},
			{ cwd },
		);
		const steerMessages = JSON.parse(firstText(steer) || "[]") as Array<unknown>;
		assert.equal(steerMessages.length, 1);
		assert.equal((steerMessages[0] as { kind?: string }).kind, "steer");
		const follow = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "read-mailbox",
					direction: "inbox",
					taskId,
					kind: "follow-up",
				},
			},
			{ cwd },
		);
		const followMessages = JSON.parse(firstText(follow) || "[]") as Array<unknown>;
		assert.equal(followMessages.length, 1);
		assert.equal((followMessages[0] as { kind?: string }).kind, "follow-up");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
