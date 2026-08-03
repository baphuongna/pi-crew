import assert from "node:assert/strict";
import test from "node:test";
import { AnimatedMascot } from "../../../src/ui/mascot.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("AnimatedMascot animates frames over time", async () => {
	let closed = 0;
	const mascot = new AnimatedMascot(
		undefined,
		() => {
			closed += 1;
		},
		{
			frameIntervalMs: 20,
			autoCloseMs: 300,
			requestRender: () => undefined,
			style: "cat",
			effect: "none",
		},
	);
	const first = mascot.render(60);
	// Poll until the frame advances. The animation interval is unref'd, so
	// under CI load (--test-concurrency) timers can be delayed; a fixed wait
	// is flaky. Polling is robust: finishes fast normally, waits longer under load.
	let second = mascot.render(60);
	for (let i = 0; i < 30 && first.join("\n") === second.join("\n"); i++) {
		await wait(20);
		second = mascot.render(60);
	}
	assert.notEqual(first.join("\n"), second.join("\n"));
	mascot.dispose();
	assert.equal(closed, 0);
});

test("AnimatedMascot closes on q input", async () => {
	let closed = 0;
	const mascot = new AnimatedMascot(
		undefined,
		() => {
			closed += 1;
		},
		{
			frameIntervalMs: 0,
			autoCloseMs: 0,
			requestRender: () => undefined,
			style: "cat",
			effect: "none",
		},
	);
	mascot.handleInput("q");
	await wait(5);
	assert.equal(closed, 1);
	mascot.dispose();
});

test("AnimatedMascot auto-closes after timeout", async () => {
	let closed = 0;
	new AnimatedMascot(
		undefined,
		() => {
			closed += 1;
		},
		{
			frameIntervalMs: 30,
			autoCloseMs: 40,
			requestRender: () => undefined,
			style: "cat",
			effect: "none",
		},
	);
	await wait(80);
	assert.equal(closed, 1);
});

test("AnimatedMascot cat render output includes greeting and mascot", () => {
	const mascot = new AnimatedMascot(undefined, () => undefined, {
		frameIntervalMs: 30,
		autoCloseMs: 0,
		requestRender: () => undefined,
		style: "cat",
		effect: "none",
	});
	const lines = mascot.render(52);
	assert.ok(lines.length >= 6);
	assert.ok(lines.some((line) => line.includes("ARMIN")));
	assert.ok(lines.some((line) => line.includes("/\\_/\\")));
	mascot.dispose();
});

test("AnimatedMascot armin style renders XBM grid and resolves effect", async () => {
	const mascot = new AnimatedMascot(undefined, () => undefined, {
		frameIntervalMs: 16,
		autoCloseMs: 0,
		requestRender: () => undefined,
		style: "armin",
		effect: "scanline",
	});
	const initial = mascot.render(48);
	assert.ok(
		initial.some((line) => line.includes("ARMIN SAYS HI")),
		"should include greeting",
	);
	assert.ok(
		initial.some((line) => line.includes("effect: scanline")),
		"should expose effect hint",
	);
	// Poll until grid advances (unref'd interval is flaky under CI load).
	let later = mascot.render(48);
	for (let i = 0; i < 30 && initial.join("\n") === later.join("\n"); i++) {
		await wait(20);
		later = mascot.render(48);
	}
	assert.notEqual(initial.join("\n"), later.join("\n"), "armin grid should advance over time");
	mascot.dispose();
});

test("AnimatedMascot armin glitch effect produces frames within bounds", () => {
	const mascot = new AnimatedMascot(undefined, () => undefined, {
		frameIntervalMs: 16,
		autoCloseMs: 0,
		requestRender: () => undefined,
		style: "armin",
		effect: "glitch",
	});
	const lines = mascot.render(48);
	assert.ok(lines.length >= 12, "armin render should be tall enough for XBM rows");
	mascot.dispose();
});

test("AnimatedMascot does not requestRender when invisible (C6)", async () => {
	let renderCalls = 0;
	const mascot = new AnimatedMascot(undefined, () => undefined, {
		frameIntervalMs: 20,
		autoCloseMs: 0,
		requestRender: () => {
			renderCalls += 1;
		},
		style: "cat",
		effect: "none",
	});
	// Wait a bit so at least one tick fires while visible (default).
	await wait(50);
	const visibleCalls = renderCalls;
	assert.ok(visibleCalls > 0, "requestRender should fire while visible");
	// Hide the mascot and wait for more ticks.
	mascot.setVisible(false);
	renderCalls = 0;
	await wait(60);
	assert.equal(renderCalls, 0, "requestRender should NOT fire while invisible");
	// Restore visibility and confirm it resumes.
	mascot.setVisible(true);
	renderCalls = 0;
	await wait(50);
	assert.ok(renderCalls > 0, "requestRender should resume after setVisible(true)");
	mascot.dispose();
});
