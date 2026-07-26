import assert from "node:assert/strict";
import test from "node:test";
import { DynamicCrewBorder } from "../../src/ui/dynamic-border.ts";
import { asCrewTheme } from "../../src/ui/theme-adapter.ts";

// These 2 tests were preserved from the deleted test/unit/loaders.test.ts (C9
// cleanup removed the dead CrewBorderedLoader + CountdownTimer classes, but
// DynamicCrewBorder is a LIVE class used by mascot.ts, settings-overlay.ts,
// and run-dashboard.ts). See reports/ui-animation-audit-2026-07-24.md (C9).

test("DynamicCrewBorder renders horizontal lines", () => {
	const border = new DynamicCrewBorder(asCrewTheme(undefined), {
		color: (value) => value,
	});
	assert.deepEqual(border.render(20), ["─".repeat(20)]);
});

test("DynamicCrewBorder supports custom characters", () => {
	const border = new DynamicCrewBorder(asCrewTheme(undefined), {
		char: "═",
		color: (value) => value,
	});
	assert.deepEqual(border.render(4), ["════"]);
});
