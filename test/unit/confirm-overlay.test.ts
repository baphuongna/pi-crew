import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmOverlay } from "../../src/ui/overlays/confirm-overlay.ts";

test("ConfirmOverlay renders title and safe hint", () => {
	const overlay = new ConfirmOverlay({ title: "Delete?", body: "Danger", dangerLevel: "high" }, () => undefined);
	const lines = overlay.render(80);
	assert.ok(lines.some((line) => line.includes("Delete?")));
	assert.ok(lines.some((line) => line.includes("Y confirm")));
});

test("ConfirmOverlay confirms with Y and cancels with N or Enter by default", () => {
	const results: boolean[] = [];
	new ConfirmOverlay({ title: "Confirm" }, (confirmed) => results.push(confirmed)).handleInput("Y");
	new ConfirmOverlay({ title: "Confirm" }, (confirmed) => results.push(confirmed)).handleInput("N");
	new ConfirmOverlay({ title: "Confirm" }, (confirmed) => results.push(confirmed)).handleInput("\r");
	assert.deepEqual(results, [true, false, false]);
});

test("ConfirmOverlay can make Enter confirm explicitly", () => {
	const results: boolean[] = [];
	new ConfirmOverlay({ title: "Confirm", defaultAction: "confirm" }, (confirmed) => results.push(confirmed)).handleInput("\r");
	assert.deepEqual(results, [true]);
});

test("ConfirmOverlay cancels with ESC and q", () => {
	const results: boolean[] = [];
	new ConfirmOverlay({ title: "Confirm" }, (confirmed) => results.push(confirmed)).handleInput("\u001b");
	new ConfirmOverlay({ title: "Confirm" }, (confirmed) => results.push(confirmed)).handleInput("q");
	assert.deepEqual(results, [false, false]);
});
