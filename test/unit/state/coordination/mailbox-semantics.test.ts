import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	appendFollowUpMessage,
	appendMailboxMessage,
	appendSteeringMessage,
	listMailboxByKind,
	readMailbox,
} from "../../../../src/state/coordination/mailbox.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "mb",
	description: "mb",
	source: "builtin",
	filePath: "mb.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "mb",
	description: "mb",
	source: "builtin",
	filePath: "mb.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

test("mailbox preserves steering and follow-up semantics", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-kind-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "mailbox semantics",
		});
		const steer = appendSteeringMessage(manifest, {
			taskId: "01_explore",
			body: "stop and report",
		});
		const follow = appendFollowUpMessage(manifest, {
			taskId: "01_explore",
			body: "afterwards, summarize",
		});
		assert.equal(steer.kind, "steer");
		assert.equal(steer.priority, "urgent");
		assert.equal(steer.deliveryMode, "interrupt");
		assert.equal(follow.kind, "follow-up");
		assert.equal(follow.deliveryMode, "next_turn");
		assert.equal(listMailboxByKind(manifest, "steer", "inbox").length, 1);
		assert.equal(listMailboxByKind(manifest, "follow-up", "inbox").length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("legacy mailbox messages without kind remain readable", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-legacy-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "legacy mailbox",
		});
		const legacy = appendMailboxMessage(manifest, {
			direction: "inbox",
			from: "leader",
			to: "01_explore",
			taskId: "01_explore",
			body: "hello",
		});
		const read = readMailbox(manifest, "inbox", "01_explore");
		assert.equal(read[0]!.id, legacy.id);
		assert.equal(read[0]!.kind, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
