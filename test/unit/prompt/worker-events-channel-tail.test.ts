import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createWorkerEventsChannel } from "../../../src/prompt/worker-events-channel.ts";

function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wec-"));
	const eventsPath = path.join(dir, "events.jsonl");
	return { dir, eventsPath };
}

test("appends separator when file does not end with newline", () => {
	const { dir, eventsPath } = setup();
	try {
		fs.writeFileSync(eventsPath, '{"a":1}', "utf-8"); // no trailing \n
		const ch = createWorkerEventsChannel({
			env: {
				PI_CREW_EVENTS_PATH: eventsPath,
				PI_CREW_BROKER_RUN_ID: "test-run",
				PI_CREW_TASK_ID: "test-task",
			},
		});
		const emitted = ch.emit("worker.test", {});
		assert.equal(emitted, true);
		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[1]!).type, "worker.test");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("no separator when file already ends with newline; none for empty or missing file", () => {
	const { dir, eventsPath } = setup();
	try {
		fs.writeFileSync(eventsPath, '{"a":1}\n', "utf-8");
		const ch = createWorkerEventsChannel({
			env: {
				PI_CREW_EVENTS_PATH: eventsPath,
				PI_CREW_BROKER_RUN_ID: "test-run",
				PI_CREW_TASK_ID: "test-task",
			},
		});
		const emitted = ch.emit("worker.test", {});
		assert.equal(emitted, true);
		let lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);

		fs.writeFileSync(eventsPath, "", "utf-8");
		const emitted2 = ch.emit("worker.test2", {});
		assert.equal(emitted2, true);
		lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);

		fs.rmSync(eventsPath);
		const emitted3 = ch.emit("worker.test3", {});
		assert.equal(emitted3, true);
		lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(lines.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
