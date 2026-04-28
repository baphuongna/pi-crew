import test from "node:test";
import assert from "node:assert/strict";
import { AnimatedMascot } from "../../src/ui/mascot.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("AnimatedMascot animates frames over time", async () => {
	let closed = 0;
	const mascot = new AnimatedMascot(undefined, () => {
		closed += 1;
	}, { frameIntervalMs: 20, autoCloseMs: 300, requestRender: () => {}, style: "cat", effect: "none" });
	const first = mascot.render(60);
	await wait(70);
	const second = mascot.render(60);
	assert.notEqual(first.join("\n"), second.join("\n"));
	mascot.dispose();
	assert.equal(closed, 0);
});

test("AnimatedMascot closes on q input", async () => {
	let closed = 0;
	const mascot = new AnimatedMascot(undefined, () => {
		closed += 1;
	}, { frameIntervalMs: 0, autoCloseMs: 0, requestRender: () => {}, style: "cat", effect: "none" });
	mascot.handleInput("q");
	await wait(5);
	assert.equal(closed, 1);
	mascot.dispose();
});

test("AnimatedMascot auto-closes after timeout", async () => {
	let closed = 0;
	new AnimatedMascot(undefined, () => {
		closed += 1;
	}, { frameIntervalMs: 30, autoCloseMs: 40, requestRender: () => {}, style: "cat", effect: "none" });
	await wait(80);
	assert.equal(closed, 1);
});

test("AnimatedMascot cat render output includes greeting and mascot", () => {
	const mascot = new AnimatedMascot(undefined, () => {}, { frameIntervalMs: 30, autoCloseMs: 0, requestRender: () => {}, style: "cat", effect: "none" });
	const lines = mascot.render(52);
	assert.ok(lines.length >= 6);
	assert.ok(lines.some((line) => line.includes("ARMIN")));
	assert.ok(lines.some((line) => line.includes("/\\_/\\")));
	mascot.dispose();
});

test("AnimatedMascot armin style renders XBM grid and resolves effect", async () => {
	const mascot = new AnimatedMascot(undefined, () => {}, { frameIntervalMs: 16, autoCloseMs: 0, requestRender: () => {}, style: "armin", effect: "scanline" });
	const initial = mascot.render(48);
	assert.ok(initial.some((line) => line.includes("ARMIN SAYS HI")), "should include greeting");
	assert.ok(initial.some((line) => line.includes("effect: scanline")), "should expose effect hint");
	await wait(120);
	const later = mascot.render(48);
	assert.notEqual(initial.join("\n"), later.join("\n"), "armin grid should advance over time");
	mascot.dispose();
});

test("AnimatedMascot armin glitch effect produces frames within bounds", () => {
	const mascot = new AnimatedMascot(undefined, () => {}, { frameIntervalMs: 16, autoCloseMs: 0, requestRender: () => {}, style: "armin", effect: "glitch" });
	const lines = mascot.render(48);
	assert.ok(lines.length >= 12, "armin render should be tall enough for XBM rows");
	mascot.dispose();
});
