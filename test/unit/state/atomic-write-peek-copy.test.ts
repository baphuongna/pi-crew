import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteJsonCoalesced, peekPendingCoalescedWrite } from "../../../src/state/atomic-write.ts";

interface ProbeRecord {
	id: string;
	taskId: string;
	role?: string;
	nested?: { usage?: { input?: number; output?: number } };
}

/**
 * RM-01 (2026-09-22): peekPendingCoalescedWrite returned the pending buffer
 * BY REFERENCE. The flush path stringifies entry.value at flush time, so any
 * caller mutating the returned object would corrupt a not-yet-flushed write
 * (write-then-flush alias bug). Now returns a deep copy.
 *
 * A long coalesce window (e.g. 5s) keeps the entry pending across the whole
 * test so we probe the BUFFER, not the disk. Mutation: revert
 * peekPendingCoalescedWrite to return `value` by reference → case 3 RED.
 */

const envHome = process.env.PI_TEAMS_HOME;
test.after(() => {
	if (envHome === undefined) delete process.env.PI_TEAMS_HOME;
	else process.env.PI_TEAMS_HOME = envHome;
});

test("RM-01: peek returns a deep copy — top-level mutation does not corrupt the buffer", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rm01-"));
	const filePath = path.join(cwd, "agents.json");
	try {
		const seeded: ProbeRecord[] = [{ id: "a1", taskId: "t1", role: "executor", nested: { usage: { input: 100, output: 5 } } }];
		atomicWriteJsonCoalesced(filePath, seeded, 5_000); // stays pending for 5s
		const peeked = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.ok(peeked, "must see the pending value before flush");
		peeked[0].id = "a1-mutated"; // top-level mutation
		const peeked2 = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.equal(peeked2?.[0]?.id, "a1", "top-level mutation must not corrupt the pending buffer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RM-01: peek returns a deep copy — NESTED mutation does not corrupt the buffer", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rm01-"));
	const filePath = path.join(cwd, "agents.json");
	try {
		const seeded: ProbeRecord[] = [{ id: "a1", taskId: "t1", role: "executor", nested: { usage: { input: 100, output: 5 } } }];
		atomicWriteJsonCoalesced(filePath, seeded, 5_000);
		const peeked = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.ok(peeked);
		assert.ok(peeked[0]?.nested?.usage);
		peeked[0].nested.usage.input = 999_999; // nested mutation
		const peeked2 = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.equal(peeked2?.[0]?.nested?.usage?.input, 100, "nested mutation must not corrupt the pending buffer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RM-01: mutating the returned ARRAY (push) does not corrupt the buffer", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rm01-"));
	const filePath = path.join(cwd, "agents.json");
	try {
		const seeded: ProbeRecord[] = [{ id: "a1", taskId: "t1", role: "executor" }];
		atomicWriteJsonCoalesced(filePath, seeded, 5_000);
		const peeked = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.ok(peeked);
		peeked.push({ id: "sneaky", taskId: "t9" });
		const peeked2 = peekPendingCoalescedWrite<ProbeRecord[]>(filePath);
		assert.equal(peeked2?.length, 1, "array push must not corrupt the pending buffer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
