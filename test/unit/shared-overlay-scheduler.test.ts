import assert from "node:assert/strict";
import test from "node:test";
import { registerOverlayScheduler } from "../../src/ui/shared-overlay-scheduler.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("C3: register fan-out — both overlays render on schedule()", async () => {
	let renderA = 0;
	let renderB = 0;
	const a = registerOverlayScheduler(() => {
		renderA += 1;
	});
	const b = registerOverlayScheduler(() => {
		renderB += 1;
	});
	// schedule() fans out to both registered overlays after the debounce window.
	a.schedule();
	await sleep(120);
	assert.ok(renderA >= 1, `overlay A should have rendered, got ${renderA}`);
	assert.ok(renderB >= 1, `overlay B should have rendered, got ${renderB}`);
	a.dispose();
	b.dispose();
});

test("C3: register fan-out — onInvalidate fires for both overlays", async () => {
	let invA = 0;
	let invB = 0;
	const a = registerOverlayScheduler(
		() => {},
		() => {
			invA += 1;
		},
	);
	const b = registerOverlayScheduler(
		() => {},
		() => {
			invB += 1;
		},
	);
	// schedule() forwards the payload to onInvalidate for all registered overlays.
	a.schedule();
	await sleep(10);
	assert.ok(invA >= 1, `overlay A onInvalidate should have fired, got ${invA}`);
	assert.ok(invB >= 1, `overlay B onInvalidate should have fired, got ${invB}`);
	a.dispose();
	b.dispose();
});

test("C3: dispose ref-count — disposing one keeps shared scheduler alive for the other", async () => {
	let renderB = 0;
	const a = registerOverlayScheduler(() => {});
	const b = registerOverlayScheduler(() => {
		renderB += 1;
	});
	// Dispose A — the shared scheduler must stay alive for B.
	a.dispose();
	b.schedule();
	await sleep(120);
	assert.ok(renderB >= 1, `overlay B should still render after A disposed, got ${renderB}`);
	// Now dispose the last overlay — the shared scheduler is torn down.
	b.dispose();
	// A fresh register recreates the scheduler (no leak / no crash).
	let renderC = 0;
	const c = registerOverlayScheduler(() => {
		renderC += 1;
	});
	c.schedule();
	await sleep(120);
	assert.ok(renderC >= 1, `fresh register after full teardown should work, got ${renderC}`);
	c.dispose();
});

test("C3: error isolation — a throwing renderer does not block the other", async () => {
	let renderOk = 0;
	const throwing = registerOverlayScheduler(() => {
		throw new Error("boom in overlay");
	});
	const ok = registerOverlayScheduler(() => {
		renderOk += 1;
	});
	// schedule() fans out to both; the throwing overlay must not propagate.
	assert.doesNotThrow(() => throwing.schedule());
	await sleep(120);
	assert.ok(renderOk >= 1, `healthy overlay should still render despite the other throwing, got ${renderOk}`);
	throwing.dispose();
	ok.dispose();
});

test("C3: error isolation — a throwing onInvalidate does not block others", async () => {
	let invOk = 0;
	const throwing = registerOverlayScheduler(
		() => {},
		() => {
			throw new Error("boom in invalidate");
		},
	);
	const ok = registerOverlayScheduler(
		() => {},
		() => {
			invOk += 1;
		},
	);
	assert.doesNotThrow(() => throwing.schedule());
	await sleep(10);
	assert.ok(invOk >= 1, `healthy onInvalidate should fire despite the other throwing, got ${invOk}`);
	throwing.dispose();
	ok.dispose();
});
