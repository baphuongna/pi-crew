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
