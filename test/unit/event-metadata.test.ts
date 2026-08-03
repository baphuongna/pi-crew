import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { appendEvent, computeEventFingerprint, dedupeTerminalEvents, readEvents } from "../../src/state/event-log/event-log.ts";

const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

function tempEventsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-events-"));
	createdTmpDirs.push(dir);
	return path.join(dir, "events.jsonl");
}

test("appendEvent adds event metadata sequence, provenance, and terminal fingerprint", () => {
	const eventsPath = tempEventsPath();
	const first = appendEvent(eventsPath, {
		type: "run.created",
		runId: "run_1",
	});
	const second = appendEvent(eventsPath, {
		type: "run.completed",
		runId: "run_1",
		metadata: {
			seq: 99,
			provenance: "test",
			sessionIdentity: {
				title: "test",
				workspace: "/tmp/repo",
				purpose: "unit",
			},
			ownership: {
				owner: "verifier",
				workflowScope: "unit",
				watcherAction: "observe",
			},
		},
	});

	assert.equal(first.metadata?.seq, 1);
	assert.equal(first.metadata?.provenance, "team_runner");
	assert.equal(second.metadata?.seq, 99);
	assert.equal(second.metadata?.provenance, "test");
	assert.equal(second.metadata?.fingerprint?.length, 16);
	assert.deepEqual(
		readEvents(eventsPath).map((event) => event.type),
		["run.created", "run.completed"],
	);
});

test("terminal event fingerprints are deterministic and dedupe repeated terminal events", () => {
	const event = {
		type: "task.failed",
		runId: "run_1",
		taskId: "task_1",
		data: { reason: "boom" },
	};
	assert.equal(computeEventFingerprint(event), computeEventFingerprint(event));
	const eventsPath = tempEventsPath();
	const first = appendEvent(eventsPath, event);
	const duplicate = appendEvent(eventsPath, event);
	const advisory = appendEvent(eventsPath, {
		type: "policy.action",
		runId: "run_1",
		taskId: "task_1",
		data: { reason: "boom" },
	});

	const deduped = dedupeTerminalEvents([first, duplicate, advisory]);
	assert.deepEqual(
		deduped.map((item) => item.type),
		["task.failed", "policy.action"],
	);
});
