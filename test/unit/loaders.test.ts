import test from "node:test";
import assert from "node:assert/strict";
import { CrewBorderedLoader, CountdownTimer } from "../../src/ui/loaders.ts";
import { asCrewTheme } from "../../src/ui/theme-adapter.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("CrewBorderedLoader signals abort on cancel key", () => {
	let aborted = false;
	let callbackCount = 0;
	const loader = new CrewBorderedLoader(null as never, asCrewTheme(undefined), {
		message: "loading",
		onAbort: () => {
			aborted = true;
			callbackCount += 1;
		},
	});
	assert.equal(loader.signal.aborted, false);
	loader.handleInput("q");
	assert.equal(loader.signal.aborted, true);
	assert.equal(aborted, true);
	assert.equal(callbackCount, 1);
	loader.handleInput("q");
	assert.equal(callbackCount, 1, "callback should not fire twice");
});

test("CountdownTimer emits ticks and calls onExpire exactly once", async () => {
	const observed: number[] = [];
	let expired = 0;
	const timer = new CountdownTimer({
		timeoutMs: 120,
		onTick: (seconds: number) => {
			observed.push(seconds);
		},
		onExpire: () => {
			expired += 1;
		},
	});
	await wait(350);
	timer.dispose();
	assert.ok(observed.length >= 1);
	assert.ok(observed.at(-1) === 0, `expected last tick to be 0, got ${observed.at(-1)}`);
	assert.equal(expired, 1);
});

test("CountdownTimer stops after dispose", async () => {
	let ticks = 0;
	let expired = false;
	const timer = new CountdownTimer({
		timeoutMs: 500,
		onTick: () => {
			ticks += 1;
		},
		onExpire: () => {
			expired = true;
		},
	});
	await wait(20);
	timer.dispose();
	const frozen = ticks;
	await wait(200);
	assert.equal(ticks, frozen);
	assert.equal(expired, false);
});
