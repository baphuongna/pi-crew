import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchBarrier, isTerminalStatus } from "../../src/runtime/scheduling/batch-barrier.ts";

test("BatchBarrier: empty batch snapshot is undefined", () => {
	const b = new BatchBarrier();
	assert.equal(b.snapshot("nope"), undefined);
	assert.equal(b.alreadyNotified("nope"), false);
});

test("BatchBarrier: single-member batch notifies when that member completes", () => {
	const b = new BatchBarrier();
	b.register("b1", "agent_a", { description: "Task A", type: "explorer" });
	// Before terminal: not all done
	const snap = b.markTerminal("b1", {
		id: "agent_a",
		description: "Task A",
		type: "explorer",
		status: "completed",
	});
	assert.equal(snap.allDone, true, "single member terminal => all done");
	assert.equal(snap.notified, false);
	assert.equal(snap.terminal.length, 1);
	assert.equal(snap.members.length, 1);
	assert.equal(b.alreadyNotified("b1"), false);
	b.markNotified("b1");
	assert.equal(b.alreadyNotified("b1"), true);
});

test("BatchBarrier: multi-member batch only allDone when ALL terminal", () => {
	const b = new BatchBarrier();
	b.register("b2", "a1");
	b.register("b2", "a2");
	b.register("b2", "a3");
	// 1/3
	let snap = b.markTerminal("b2", { id: "a1", status: "completed" });
	assert.equal(snap.allDone, false, "1/3 not all done");
	assert.equal(snap.notified, false);
	// 2/3
	snap = b.markTerminal("b2", { id: "a2", status: "failed" });
	assert.equal(snap.allDone, false, "2/3 not all done");
	// 3/3
	snap = b.markTerminal("b2", { id: "a3", status: "completed" });
	assert.equal(snap.allDone, true, "3/3 all done");
	assert.equal(snap.terminal.length, 3);
});

test("BatchBarrier: markNotified is idempotent and suppresses re-emit", () => {
	const b = new BatchBarrier();
	b.register("b3", "x");
	const snap = b.markTerminal("b3", { id: "x", status: "completed" });
	assert.equal(snap.allDone, true);
	b.markNotified("b3");
	assert.equal(b.alreadyNotified("b3"), true);
	b.markNotified("b3"); // idempotent
	assert.equal(b.alreadyNotified("b3"), true);
});

test("BatchBarrier: register is idempotent per (batchId, agentId)", () => {
	const b = new BatchBarrier();
	b.register("b4", "a");
	b.register("b4", "a"); // duplicate
	b.register("b4", "a");
	const snap = b.snapshot("b4");
	assert.ok(snap);
	assert.equal(snap!.members.length, 1, "duplicate register collapsed");
});

test("BatchBarrier: markTerminal for unregistered batch treats as batch-of-one", () => {
	const b = new BatchBarrier();
	const snap = b.markTerminal("phantom", {
		id: "ghost",
		status: "completed",
	});
	assert.equal(snap.allDone, true, "unregistered terminal => all done (batch of one)");
	assert.equal(snap.terminal.length, 1);
});

test("BatchBarrier: blocked status is NOT terminal (batch waits for resume)", () => {
	const b = new BatchBarrier();
	b.register("b5", "a");
	b.register("b5", "b");
	assert.equal(isTerminalStatus("blocked"), false);
	const snap = b.markTerminal("b5", { id: "a", status: "blocked" });
	// 'blocked' is not terminal so it is not counted; still waiting
	assert.equal(snap.allDone, false, "blocked is not terminal => batch still waiting");
});

test("BatchBarrier: terminal statuses recognized", () => {
	for (const s of ["completed", "failed", "cancelled", "error", "stopped"]) {
		assert.equal(isTerminalStatus(s), true, `${s} is terminal`);
	}
	for (const s of ["running", "queued", "blocked", "planning"]) {
		assert.equal(isTerminalStatus(s), false, `${s} is not terminal`);
	}
});

test("BatchBarrier: dispose single + all", () => {
	const b = new BatchBarrier();
	b.register("b6", "a");
	b.register("b7", "a");
	b.dispose("b6");
	assert.equal(b.snapshot("b6"), undefined);
	assert.ok(b.snapshot("b7"));
	b.dispose();
	assert.equal(b.snapshot("b7"), undefined);
});

test("BatchBarrier: member status updates in snapshot after terminal", () => {
	const b = new BatchBarrier();
	b.register("b8", "a", { description: "D", type: "executor" });
	const snap = b.markTerminal("b8", {
		id: "a",
		description: "D",
		type: "executor",
		status: "failed",
	});
	assert.equal(snap.members[0]!.status, "failed", "member status reflects terminal");
	assert.equal(snap.terminal[0]!.status, "failed");
});
