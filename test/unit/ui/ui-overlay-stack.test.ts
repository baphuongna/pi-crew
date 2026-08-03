/**
 * PR-G3 (UI-4) — verify the overlay stack provides z-order, focus, and
 * dismissal chaining (push / pop / top / handleInput routing / dismiss).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { InteractiveComponent } from "../../../src/ui/component.ts";
import { OverlayStack } from "../../../src/ui/overlay-stack.ts";

/** Minimal recording overlay implementing InteractiveComponent. */
interface RecordingOverlay extends InteractiveComponent {
	id: string;
	rendered: number;
	inputs: string[];
}

function makeOverlay(id: string, body: string[]): RecordingOverlay {
	return {
		id,
		rendered: 0,
		inputs: [],
		invalidate(): void { /* no-op */ },
		render(_width: number): string[] {
			this.rendered += 1;
			return body.slice();
		},
		handleInput(data: string): void {
			this.inputs.push(data);
		},
	};
}

test("UI-4: push places an overlay on top and exposes size/top/isEmpty", () => {
	const stack = new OverlayStack();
	assert.equal(stack.isEmpty(), true);
	assert.equal(stack.size, 0);
	assert.equal(stack.top(), undefined);

	const a = makeOverlay("a", ["a-1"]);
	stack.push(a);

	assert.equal(stack.isEmpty(), false);
	assert.equal(stack.size, 1);
	assert.equal(stack.top(), a);
});

test("UI-4: LIFO ordering — top is the most recently pushed overlay", () => {
	const stack = new OverlayStack();
	const a = makeOverlay("a", ["a"]);
	const b = makeOverlay("b", ["b"]);
	const c = makeOverlay("c", ["c"]);
	stack.push(a);
	stack.push(b);
	stack.push(c);

	assert.equal(stack.size, 3);
	assert.equal(stack.top(), c);
	assert.equal(stack.at(0), a, "bottom is the first pushed");
	assert.equal(stack.at(2), c, "top is the last pushed");
});

test("UI-4: pop removes and returns the top overlay (LIFO)", () => {
	const stack = new OverlayStack();
	const a = makeOverlay("a", ["a"]);
	const b = makeOverlay("b", ["b"]);
	stack.push(a);
	stack.push(b);

	const popped = stack.pop();
	assert.equal(popped, b);
	assert.equal(stack.size, 1);
	assert.equal(stack.top(), a);

	// pop on the last overlay empties the stack.
	assert.equal(stack.pop(), a);
	assert.equal(stack.isEmpty(), true);
	// pop on an empty stack returns undefined (no throw).
	assert.equal(stack.pop(), undefined);
});

test("UI-4: handleInput routes to the top overlay only", () => {
	const stack = new OverlayStack();
	const a = makeOverlay("a", ["a"]);
	const b = makeOverlay("b", ["b"]);
	stack.push(a);
	stack.push(b);

	// Input goes to the top (b), never to a.
	const handled = stack.handleInput("\u001b");
	assert.equal(handled, true);
	assert.deepEqual(b.inputs, ["\u001b"]);
	assert.deepEqual(a.inputs, [], "non-top overlay must not receive input");
});

test("UI-4: handleInput returns false when the stack is empty (base-input fallback)", () => {
	const stack = new OverlayStack();
	assert.equal(stack.handleInput("x"), false, "empty stack does not consume input");
});

test("UI-4: dismissTop removes the top and chains focus to the next overlay", () => {
	const stack = new OverlayStack();
	const a = makeOverlay("a", ["a"]);
	const b = makeOverlay("b", ["b"]);
	stack.push(a);
	stack.push(b);

	// Dismiss the topmost (b). Focus restores to a.
	assert.equal(stack.dismissTop(), true);
	assert.equal(stack.size, 1);
	assert.equal(stack.top(), a);

	// Input now routes to a (the new top).
	stack.handleInput("k");
	assert.deepEqual(a.inputs, ["k"]);

	// Chained dismissal: dismiss until empty.
	assert.equal(stack.dismissTop(), true);
	assert.equal(stack.isEmpty(), true);
	// Dismissing an empty stack returns false.
	assert.equal(stack.dismissTop(), false);
});

test("UI-4: render returns the top overlay's lines by default", () => {
	const stack = new OverlayStack();
	const a = makeOverlay("a", ["a-1", "a-2"]);
	const b = makeOverlay("b", ["b-1"]);
	stack.push(a);
	stack.push(b);

	assert.deepEqual(stack.render(60), ["b-1"], "top overlay is rendered");
	// After popping b, a is rendered.
	stack.pop();
	assert.deepEqual(stack.render(60), ["a-1", "a-2"]);
	// Empty stack renders nothing.
	stack.pop();
	assert.deepEqual(stack.render(60), []);
});

test("UI-4: composite render returns every layer bottom-to-top", () => {
	const stack = new OverlayStack();
	stack.push(makeOverlay("a", ["a"]));
	stack.push(makeOverlay("b", ["b"]));
	stack.push(makeOverlay("c", ["c"]));

	assert.deepEqual(stack.render(60, { composite: true }), ["a", "b", "c"]);
});

test("UI-4: invalidateAll forwards to every overlay", () => {
	const stack = new OverlayStack();
	let aInvalidated = 0;
	let bInvalidated = 0;
	stack.push({
		id: "a",
		invalidate() {
			aInvalidated += 1;
		},
		render(): string[] {
			return [];
		},
		handleInput(): void { /* no-op */ },
	});
	stack.push({
		id: "b",
		invalidate() {
			bInvalidated += 1;
		},
		render(): string[] {
			return [];
		},
		handleInput(): void { /* no-op */ },
	});

	stack.invalidateAll();
	assert.equal(aInvalidated, 1);
	assert.equal(bInvalidated, 1);
});

test("UI-4: clear empties the stack", () => {
	const stack = new OverlayStack();
	stack.push(makeOverlay("a", ["a"]));
	stack.push(makeOverlay("b", ["b"]));
	assert.equal(stack.size, 2);

	stack.clear();
	assert.equal(stack.isEmpty(), true);
	assert.deepEqual(stack.render(60), []);
});

test("UI-4: onTopChanged fires on push, pop, dismissTop, and clear (not on empty ops)", () => {
	const calls: string[] = [];
	const stack = new OverlayStack({ onTopChanged: () => calls.push("changed") });

	stack.push(makeOverlay("a", ["a"]));
	stack.push(makeOverlay("b", ["b"]));
	stack.pop();
	stack.dismissTop(); // empties the stack
	stack.dismissTop(); // no-op on empty -> should NOT fire
	stack.clear(); // already empty -> should NOT fire

	assert.deepEqual(calls, ["changed", "changed", "changed", "changed"]);
});

test("UI-4: real overlays (ConfirmOverlay) opt in automatically via structural compatibility", () => {
	const stack = new OverlayStack();
	const overlay = new (class {
		invalidate(): void { /* no-op */ }
		render(_w: number): string[] {
			return ["overlay"];
		}
		handleInput(_d: string): void { /* no-op */ }
	})();
	// A plain InteractiveComponent-shaped object pushes without adaptation.
	stack.push(overlay);
	assert.equal(stack.size, 1);
	assert.deepEqual(stack.render(40), ["overlay"]);
});
