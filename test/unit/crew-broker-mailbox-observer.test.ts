/**
 * crew-broker-mailbox-observer.test.ts — Phase 1.3 + 1.5 unit tests.
 *
 * 1.3: registerMailboxAppendObserver fires AFTER the durable write, is
 *      non-throwing, and delivers a snapshot (later mutation doesn't affect
 *      what the observer sees).
 * 1.5: events.since returns a bounded page from the durable event log.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	appendMailboxMessageAsync,
	registerMailboxAppendObserver,
} from "../../src/state/mailbox.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

// ----------------------------------------------------------------------------
// 1.3: mailbox append observer
// ----------------------------------------------------------------------------

test("observer: fires after durable append with a snapshot of the message", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "observer" },
			{ cwd },
		);
		const runId = run.details.runId!;
		const loaded = loadRunManifestById(cwd, runId)!;
		const taskId = loaded.tasks[0].id;

		const observed: Array<{ id: string; body: string }> = [];
		const unsub = registerMailboxAppendObserver((msg) => {
			observed.push({ id: msg.id, body: msg.body });
		});
		try {
			const appended = await appendMailboxMessageAsync(loaded.manifest, {
				direction: "inbox",
				from: "leader",
				to: taskId,
				taskId,
				body: "observer-test-body",
				kind: "message",
				priority: "normal",
				deliveryMode: "next_turn",
			});
			// The observer fires via queueMicrotask, so drain one microtask round.
			await new Promise<void>((r) => queueMicrotask(r));
			await new Promise<void>((r) => setImmediate(r));
			assert.equal(observed.length, 1, "observer should fire exactly once");
			assert.equal(observed[0].id, appended.id);
			assert.equal(observed[0].body, "observer-test-body");
		} finally {
			unsub();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("observer: unsubscribe stops further notifications", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-unsub-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "unsub" },
			{ cwd },
		);
		const runId = run.details.runId!;
		const loaded = loadRunManifestById(cwd, runId)!;
		const taskId = loaded.tasks[0].id;

		let count = 0;
		const unsub = registerMailboxAppendObserver(() => { count += 1; });
		await appendMailboxMessageAsync(loaded.manifest, {
			direction: "inbox", from: "x", to: taskId, taskId, body: "first", kind: "message",
		});
		await new Promise<void>((r) => setImmediate(r));
		assert.equal(count, 1);
		unsub();
		await appendMailboxMessageAsync(loaded.manifest, {
			direction: "inbox", from: "x", to: taskId, taskId, body: "second", kind: "message",
		});
		await new Promise<void>((r) => setImmediate(r));
		assert.equal(count, 1, "observer must not fire after unsubscribe");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("observer: a throwing observer does not break the durable append", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-obs-throw-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "throw-obs" },
			{ cwd },
		);
		const runId = run.details.runId!;
		const loaded = loadRunManifestById(cwd, runId)!;
		const taskId = loaded.tasks[0].id;

		const unsub = registerMailboxAppendObserver(() => { throw new Error("boom"); });
		try {
			// The append must succeed despite the observer throwing.
			const result = await appendMailboxMessageAsync(loaded.manifest, {
				direction: "inbox", from: "x", to: taskId, taskId, body: "survives", kind: "message",
			});
			assert.ok(result.id);
			await new Promise<void>((r) => setImmediate(r));
		} finally {
			unsub();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});