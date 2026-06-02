/**
 * Tests for src/runtime/auto-resume.ts
 * Coverage:
 * - scheduleResume basic fire
 * - cancelResume prevents callback
 * - rapid scheduleResume debounces (only last fires)
 * - turn limit enforcement
 * - resetTurnCount
 * - hasPendingResume
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AutoResumeController, SETTLE_WINDOW_MS } from "../../src/runtime/auto-resume.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("AutoResumeController.scheduleResume fires callback after settle window", async () => {
	const ctl = new AutoResumeController();
	let fired = false;
	ctl.scheduleResume("test", () => {
		fired = true;
	});
	await sleep(SETTLE_WINDOW_MS + 100);
	assert.equal(fired, true);
});

test("AutoResumeController.cancelResume prevents pending callback", async () => {
	const ctl = new AutoResumeController();
	let fired = false;
	ctl.scheduleResume("test", () => {
		fired = true;
	});
	ctl.cancelResume();
	await sleep(SETTLE_WINDOW_MS + 100);
	assert.equal(fired, false);
});

test("AutoResumeController rapid scheduleResume debounces (only last fires)", async () => {
	const ctl = new AutoResumeController();
	const fired: string[] = [];
	ctl.scheduleResume("a", () => fired.push("a"));
	ctl.scheduleResume("b", () => fired.push("b"));
	ctl.scheduleResume("c", () => fired.push("c"));
	await sleep(SETTLE_WINDOW_MS + 100);
	assert.deepEqual(fired, ["c"]);
});

test("AutoResumeController hasPendingResume returns true while scheduled", () => {
	const ctl = new AutoResumeController();
	assert.equal(ctl.hasPendingResume(), false);
	ctl.scheduleResume("test", () => {});
	assert.equal(ctl.hasPendingResume(), true);
	ctl.cancelResume();
	assert.equal(ctl.hasPendingResume(), false);
});

test("AutoResumeController turn count increments on scheduleResume", () => {
	const ctl = new AutoResumeController();
	assert.equal(ctl.currentTurnCount, 0);
	ctl.scheduleResume("a", () => {});
	ctl.cancelResume();
	ctl.scheduleResume("b", () => {});
	ctl.cancelResume();
	assert.equal(ctl.currentTurnCount, 2);
});

test("AutoResumeController.resetTurnCount resets the counter", () => {
	const ctl = new AutoResumeController();
	ctl.scheduleResume("a", () => {});
	ctl.scheduleResume("b", () => {});
	assert.equal(ctl.currentTurnCount, 2);
	ctl.resetTurnCount();
	assert.equal(ctl.currentTurnCount, 0);
});

test("AutoResumeController has no pending after callback fires", async () => {
	const ctl = new AutoResumeController();
	ctl.scheduleResume("test", () => {});
	assert.equal(ctl.hasPendingResume(), true);
	await sleep(SETTLE_WINDOW_MS + 100);
	assert.equal(ctl.hasPendingResume(), false);
});
