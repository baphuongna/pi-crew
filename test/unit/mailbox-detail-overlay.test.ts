import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendMailboxMessage } from "../../src/state/mailbox.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
import { type MailboxAction, MailboxDetailOverlay } from "../../src/ui/overlays/mailbox-detail-overlay.ts";

function createRun(): { cwd: string; runId: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-overlay-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "mail",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "mail" });
	appendMailboxMessage(created.manifest, {
		direction: "inbox",
		from: "lead",
		to: created.tasks[0]?.id ?? "one",
		body: "ping",
		taskId: created.tasks[0]?.id ?? "one",
	});
	return { cwd, runId: created.manifest.runId };
}

test("MailboxDetailOverlay renders mailbox and emits ack action", () => {
	const run = createRun();
	try {
		const actions: MailboxAction[] = [];
		const overlay = new MailboxDetailOverlay({
			cwd: run.cwd,
			runId: run.runId,
			done: (action) => {
				if (action) actions.push(action);
			},
		});
		assert.ok(overlay.render(100).some((line) => line.includes("ping")));
		overlay.handleInput("A");
		assert.equal(actions[0]?.type, "ack");
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("MailboxDetailOverlay supports compose nudge ackAll and close actions", () => {
	const run = createRun();
	try {
		const actions: MailboxAction[] = [];
		const overlay = new MailboxDetailOverlay({
			cwd: run.cwd,
			runId: run.runId,
			done: (action) => {
				if (action) actions.push(action);
			},
		});
		overlay.handleInput("N");
		overlay.handleInput("C");
		overlay.handleInput("X");
		overlay.handleInput("\u001b");
		assert.deepEqual(
			actions.map((action) => action.type),
			["nudge", "compose", "ackAll", "close"],
		);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
