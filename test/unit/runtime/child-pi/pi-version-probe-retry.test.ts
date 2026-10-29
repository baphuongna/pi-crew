import assert from "node:assert/strict";
import test from "node:test";
import {
	PROBE_FAILURE_RETRY_TTL_MS,
	__test_resetPiVersionMemo,
	probePiVersion,
	type ExecPiVersionFn,
} from "../../../../src/runtime/child-pi/pi-version.ts";

const failExec: ExecPiVersionFn = async () => {
	throw new Error("simulated transient probe failure (cold-start timeout)");
};
const okExec: ExecPiVersionFn = async () => ({ stdout: "pi 1.0.4\n" }) as never;

test("N2: SUCCESSFUL probe memoizes for the process lifetime", async () => {
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(okExec), "1.0.4");
	// Second call with a DIFFERENT seam still returns the memoized success
	// (single-flight contract: the seam is consumed only by the memo-creating call).
	assert.equal(await probePiVersion(failExec), "1.0.4");
});

test("N2: FAILED probe stays memoized WITHIN the TTL window (single-flight)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(failExec), null);
	// Before the TTL elapses, a healthy seam must NOT re-probe.
	assert.equal(await probePiVersion(okExec), null);
	t.mock.timers.reset();
});

test("N2: FAILED probe re-arms after the TTL — a later spawn retries and recovers", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(failExec), null);
	t.mock.timers.tick(PROBE_FAILURE_RETRY_TTL_MS + 1);
	// TTL elapsed: the memo re-armed, so this call creates a FRESH probe with
	// the healthy seam and recovers the version (the N2 regression: previously
	// the null memo was permanent, dropping --no-mcp for the process lifetime).
	assert.equal(await probePiVersion(okExec), "1.0.4");
	t.mock.timers.reset();
});
