import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("api supports mailbox inbox/outbox and delivery state", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "mailbox api" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const sent = await handleTeamTool({ action: "api", runId, config: { operation: "send-message", direction: "outbox", from: "leader", to: "worker", body: "hello" } }, { cwd });
		assert.equal(sent.isError, false);
		const message = JSON.parse(firstText(sent) || "{}");
		assert.equal(message.direction, "outbox");
		const mailbox = await handleTeamTool({ action: "api", runId, config: { operation: "read-mailbox", direction: "outbox" } }, { cwd });
		const messages = JSON.parse(firstText(mailbox) || "[]") as Array<{ id: string }>;
		assert.equal(messages.length, 1);
		const ack = await handleTeamTool({ action: "api", runId, config: { operation: "ack-message", messageId: messages[0]?.id } }, { cwd });
		assert.equal(ack.isError, false);
		const delivery = JSON.parse(firstText(ack) || "{}");
		assert.equal(delivery.messages[messages[0]!.id], "acknowledged");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("read-mailbox does not create mailbox files on reads", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-readonly-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "mailbox readonly read" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		const mailboxDir = path.join(loaded.manifest.stateRoot, "mailbox");
		assert.equal(fs.existsSync(mailboxDir), false);
		const read = await handleTeamTool({ action: "api", runId, config: { operation: "read-mailbox", direction: "inbox" } }, { cwd });
		assert.equal(read.isError, false);
		assert.equal(fs.existsSync(mailboxDir), false);
		assert.equal(fs.existsSync(path.join(mailboxDir, "delivery.json")), false);
		const messages = JSON.parse(firstText(read) || "[]") as Array<unknown>;
		assert.equal(messages.length, 0);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

