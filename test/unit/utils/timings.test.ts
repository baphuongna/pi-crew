import assert from "node:assert/strict";
import test from "node:test";
import { printTimings, resetTimings, time } from "../../../src/utils/timings.ts";

test("timings utility can be called without crashing", () => {
	assert.doesNotThrow(() => {
		resetTimings();
		time("start");
		time("step");
		printTimings();
	});
});
