/**
 * R2 — AdaptiveCard: width-deferred card component.
 *
 * Regression locks for the three behaviours the tool renderers now rely on:
 *  1. the frame is built at the RENDER width (no baked terminal-width guess),
 *  2. results are cached per width and invalidated,
 *  3. a throwing builder surfaces a fail-visible error line instead of
 *     propagating into the TUI render loop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptiveCard } from "../../../src/ui/adaptive-card.ts";

const frame = (w: number): string => {
	const inner = "─".repeat(w - 4);
	return `╭${inner}╮\n│ x${" ".repeat(w - 6)}x │\n╰${inner}╯`;
};

test("R2: builds the frame at the RENDER width, not a baked guess", () => {
	const card = new AdaptiveCard(frame);
	const at100 = card.render(100);
	assert.equal(at100.length, 3, "no wrap at the render width");
	assert.ok(at100[0]!.trimEnd().endsWith("╮"), "top border intact");
	assert.ok(at100[2]!.trimEnd().endsWith("╯"), "bottom border intact");
	for (const line of at100) assert.ok(line.trimEnd().length <= 100, `line within width: ${line.length}`);
});

test("R2: re-render at a different width rebuilds the frame for THAT width", () => {
	const card = new AdaptiveCard(frame);
	const wide = card.render(120);
	const narrow = card.render(80);
	assert.ok(wide[0]!.includes("─".repeat(116)), "built at 120");
	assert.ok(narrow[0]!.includes("─".repeat(76)), "rebuilt at 80, not wrapped 120");
	assert.equal(narrow.length, 3, "narrow render stays intact");
});

test("R2: same-width re-render is cached (identity), invalidate drops the cache", () => {
	const card = new AdaptiveCard(frame);
	const first = card.render(90);
	const second = card.render(90);
	assert.equal(first, second, "cached lines are the same array instance");
	card.invalidate();
	const third = card.render(90);
	assert.notEqual(first, third, "invalidate forces a rebuild");
	assert.deepEqual(third, first, "content unchanged after rebuild");
});

test("R2: a throwing builder renders a fail-visible error line, never throws", () => {
	const card = new AdaptiveCard(
		() => {
			throw new Error("builder exploded");
		},
		(t) => `\u001b[31m${t}\u001b[39m`,
	);
	const lines = card.render(60);
	assert.equal(lines.length, 1);
	assert.match(lines[0]!, /✖ card render error: builder exploded/);
	// and it keeps failing visibly (not crashing) on the next render
	assert.match(card.render(60)[0]!, /✖ card render error/);
});

test("R2: empty builder output renders nothing (same contract as Text)", () => {
	const card = new AdaptiveCard(() => "");
	assert.deepEqual(card.render(40), []);
});
