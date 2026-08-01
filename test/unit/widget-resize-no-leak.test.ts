import assert from "node:assert/strict";
import test from "node:test";
import {
	installResizeListener,
	uninstallResizeListener,
} from "../../src/ui/widget/index.ts";

const RESIZE = "resize";

/** Number of "resize" listeners currently attached to process.stdout. */
function resizeListenerCount(): number {
	const stdout = process.stdout as { listenerCount?: (e: string) => number } | null | undefined;
	return stdout?.listenerCount?.(RESIZE) ?? 0;
}

/**
 * UI-7 (PR-F3): when process.stdout supports removal (off()/removeListener()),
 * the "resize" listener MUST be added on install and removed on uninstall.
 * No leak across repeated install/uninstall cycles.
 */
test("UI-7: resize listener is added on install and removed on uninstall when removal is available", () => {
	// Reset module-level install flag from any prior state.
	uninstallResizeListener();

	const before = resizeListenerCount();

	installResizeListener();
	assert.equal(
		resizeListenerCount(),
		before + 1,
		"installResizeListener() should add exactly one stdout 'resize' listener",
	);

	uninstallResizeListener();
	assert.equal(
		resizeListenerCount(),
		before,
		"uninstallResizeListener() should remove the stdout 'resize' listener",
	);

	// A second cycle must not accumulate an extra listener (the original leak).
	installResizeListener();
	assert.equal(resizeListenerCount(), before + 1);
	uninstallResizeListener();
	assert.equal(resizeListenerCount(), before);
});

/**
 * UI-7 (PR-F3): when process.stdout exposes only `on` but neither `off` nor
 * `removeListener` (older runtime / mock stdout), the "resize" listener must
 * NOT be registered at all — otherwise uninstallResizeListener() could never
 * remove it and every widget reinstall would leak another listener.
 */
test("UI-7: resize listener is NOT added when off()/removeListener() are unavailable (no leak)", () => {
	uninstallResizeListener();

	const stdout = process.stdout as unknown as Record<string, unknown>;
	// Shadow the prototype-provided removal methods with `undefined` to simulate
	// an older runtime / mock stdout that only implements `on`.
	const hadOff = Object.prototype.hasOwnProperty.call(stdout, "off");
	const hadRm = Object.prototype.hasOwnProperty.call(stdout, "removeListener");
	const savedOff = Object.getOwnPropertyDescriptor(stdout, "off");
	const savedRm = Object.getOwnPropertyDescriptor(stdout, "removeListener");

	try {
		Object.defineProperty(stdout, "off", { value: undefined, configurable: true });
		Object.defineProperty(stdout, "removeListener", { value: undefined, configurable: true });

		const before = resizeListenerCount();
		installResizeListener();
		assert.equal(
			resizeListenerCount(),
			before,
			"must NOT add a 'resize' listener when removal is impossible (would leak)",
		);
	} finally {
		// Remove our own shadows so the inherited prototype methods show again.
		delete stdout.off;
		delete stdout.removeListener;
		// Restore pre-existing own properties (defensive: normally none).
		if (hadOff && savedOff) Object.defineProperty(stdout, "off", savedOff);
		if (hadRm && savedRm) Object.defineProperty(stdout, "removeListener", savedRm);
		// Leave module state clean for any later test.
		uninstallResizeListener();
	}
});
