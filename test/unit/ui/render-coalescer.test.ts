import assert from "node:assert/strict";
import test from "node:test";
import { RenderCoalescer } from "../../../src/ui/render-coalescer.ts";

test("RenderCoalescer — initial state", () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 10);
	assert.equal(coalescer.pending, false);
	assert.equal(calls, 0);
	coalescer.dispose();
});

test("RenderCoalescer — request() triggers callback after interval", async () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 10);
	coalescer.request();
	assert.equal(coalescer.pending, true);
	assert.equal(calls, 0);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(calls, 1);
	assert.equal(coalescer.pending, false);
	coalescer.dispose();
});

test("RenderCoalescer — multiple request() calls only trigger one callback", async () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 20);
	coalescer.request();
	coalescer.request();
	coalescer.request();
	coalescer.request();
	coalescer.request();
	assert.equal(coalescer.pending, true);
	assert.equal(calls, 0);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls, 1);
	assert.equal(coalescer.pending, false);
	coalescer.dispose();
});

test("RenderCoalescer — flush() triggers callback immediately", () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 1000);
	coalescer.request();
	assert.equal(calls, 0);
	coalescer.flush();
	assert.equal(calls, 1);
	assert.equal(coalescer.pending, false);
	coalescer.dispose();
});

test("RenderCoalescer — flush() clears pending timer", async () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 30);
	coalescer.request();
	coalescer.flush();
	assert.equal(calls, 1);
	assert.equal(coalescer.pending, false);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(calls, 1);
	coalescer.dispose();
});

test("RenderCoalescer — dispose() prevents callback from firing", async () => {
	let calls = 0;
	const coalescer = new RenderCoalescer(() => {
		calls++;
	}, 20);
	coalescer.request();
	assert.equal(coalescer.pending, true);
	coalescer.dispose();
	assert.equal(coalescer.pending, false);
	assert.equal(calls, 0);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls, 0);
});

test("RenderCoalescer — pending property reflects state", async () => {
	const coalescer = new RenderCoalescer(() => undefined, 15);
	assert.equal(coalescer.pending, false);
	coalescer.request();
	assert.equal(coalescer.pending, true);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(coalescer.pending, false);
	coalescer.request();
	assert.equal(coalescer.pending, true);
	coalescer.flush();
	assert.equal(coalescer.pending, false);
	coalescer.dispose();
	assert.equal(coalescer.pending, false);
});
