import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "../../../src/utils/sleep.ts";

test("sleep resolves after delay", async () => {
	const start = Date.now();
	await sleep(60);
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 50);
});

test("sleep rejects immediately when signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => sleep(1000, controller.signal), /aborted/i);
});

test("sleep rejects when aborted during wait", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, 20);
	try {
		await assert.rejects(() => sleep(200, controller.signal), /aborted/i);
	} finally {
		clearTimeout(timer);
	}
});
