// U9 (pi 1.0.4 version floor): comparePiVersion matrix + probePiVersion
// seam-injected behavior. NO real child spawn anywhere — the exec seam is
// faked and the single-flight memo is reset between cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	__test_resetPiVersionMemo,
	comparePiVersion,
	type ExecPiVersionFn,
	PI_NO_MCP_FLOOR,
	PI_VERSION_PROBE_TIMEOUT_MS,
	piVersionAtLeast,
	probePiVersion,
} from "../../../../src/runtime/child-pi/pi-version.ts";

interface RecordedCall {
	file: string;
	args: string[];
	options: { timeout: number; encoding: string };
}

function fakeExec(stdout: string): { fn: ExecPiVersionFn; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fn: async (file, args, options) => {
			calls.push({ file, args: [...args], options: { ...options } });
			return { stdout, stderr: "" };
		},
	};
}

function rejectingExec(error: Error): ExecPiVersionFn {
	return async () => {
		throw error;
	};
}

// ── comparePiVersion: the 1.0.4 floor neighborhood ──────────────────────

test("comparePiVersion: 1.0.4 vs floor neighbors (1.0.5 / 1.0.3 / 0.99.2 / equal)", () => {
	assert.equal(comparePiVersion("1.0.4", "1.0.5"), -1);
	assert.equal(comparePiVersion("1.0.4", "1.0.3"), 1);
	assert.equal(comparePiVersion("1.0.4", "0.99.2"), 1);
	assert.equal(comparePiVersion("1.0.4", "1.0.4"), 0);
});

test("comparePiVersion: major/minor/patch precedence; numeric (not lexical) compares", () => {
	assert.equal(comparePiVersion("2.0.0", "1.99.99"), 1, "major wins");
	assert.equal(comparePiVersion("1.2.0", "1.1.9"), 1, "minor wins");
	assert.equal(comparePiVersion("1.0.10", "1.0.9"), 1, "patch compares numerically");
	assert.equal(comparePiVersion("1.0.9", "1.0.10"), -1, "'9' < '10' numerically, not lexically");
	assert.equal(comparePiVersion("10.0.0", "9.0.0"), 1);
	assert.equal(comparePiVersion("0.99.2", "1.0.0"), -1);
});

test("comparePiVersion: pre-release ordering (semver §11, simplified)", () => {
	assert.equal(comparePiVersion("1.0.4-beta", "1.0.4"), -1, "pre-release < release");
	assert.equal(comparePiVersion("1.0.4", "1.0.4-beta"), 1);
	assert.equal(comparePiVersion("1.0.4-beta.2", "1.0.4-beta.1"), 1, "numeric identifiers compare numerically");
	assert.equal(comparePiVersion("1.0.4-beta.10", "1.0.4-beta.9"), 1, "10 > 9, NOT lexical");
	assert.equal(comparePiVersion("1.0.4-alpha", "1.0.4-beta"), -1, "alphanumeric lexical order");
	assert.equal(comparePiVersion("1.0.4-1", "1.0.4-alpha"), -1, "numeric identifiers rank BELOW alphanumeric");
	assert.equal(comparePiVersion("1.0.4-beta", "1.0.4-beta.1"), -1, "shorter identifier list is lower");
	assert.equal(comparePiVersion("1.0.4-rc.1", "1.0.4-rc.1"), 0);
	assert.equal(comparePiVersion("1.0.5-alpha", "1.0.4"), 1, "higher release beats lower release's pre-release");
});

test("comparePiVersion: build metadata ignored (semver §10)", () => {
	assert.equal(comparePiVersion("1.0.4+build.5", "1.0.4+other"), 0);
	assert.equal(comparePiVersion("1.0.4+build.5", "1.0.4"), 0);
	assert.equal(comparePiVersion("1.0.4", "1.0.4+build.5"), 0);
});

test("comparePiVersion: malformed input → null on EITHER side (conservative)", () => {
	const malformed: (string | null | undefined)[] = [
		"",
		"1",
		"1.0",
		"1.0.x",
		"abc",
		"1.0.4.5",
		"v1.0.4", // strict parse rejects the 'v' prefix — only the PROBE extraction is lenient
		"1.0.04", // leading zero
		"1.0.4-", // dangling pre-release
		"1..4",
		null,
		undefined,
	];
	// NOTE: surrounding whitespace is NOT malformed — parseVersion trims (a
	// config-sourced " 1.0.4" should not nuke the floor; the probe output is
	// already bare).
	for (const bad of malformed) {
		assert.equal(comparePiVersion(bad, "1.0.4"), null, `(${String(bad)}) as lhs must be malformed → null`);
		assert.equal(comparePiVersion("1.0.4", bad), null, `(${String(bad)}) as rhs must be malformed → null`);
	}
});

// ── piVersionAtLeast: the floor gate used by pi-args.ts ─────────────────

test("piVersionAtLeast: floor semantics for the --no-mcp gate", () => {
	assert.equal(PI_NO_MCP_FLOOR, "1.0.4", "floor registry must pin the documented floor");
	assert.equal(PI_VERSION_PROBE_TIMEOUT_MS, 5000, "probe timeout is ~5s per the U9 contract");
	assert.equal(piVersionAtLeast("1.0.4", PI_NO_MCP_FLOOR), true, "at the floor");
	assert.equal(piVersionAtLeast("1.0.5", PI_NO_MCP_FLOOR), true, "above the floor");
	assert.equal(piVersionAtLeast("2.0.0", PI_NO_MCP_FLOOR), true, "major bump above the floor");
	assert.equal(piVersionAtLeast("1.0.3", PI_NO_MCP_FLOOR), false, "below the floor");
	assert.equal(piVersionAtLeast("0.99.2", PI_NO_MCP_FLOOR), false);
	assert.equal(piVersionAtLeast("1.0.4-beta", PI_NO_MCP_FLOOR), false, "pre-release of the floor is BELOW the floor");
	assert.equal(piVersionAtLeast(null, PI_NO_MCP_FLOOR), false, "unknown → no gated flag");
	assert.equal(piVersionAtLeast(undefined, PI_NO_MCP_FLOOR), false);
	assert.equal(piVersionAtLeast("1.0.x", PI_NO_MCP_FLOOR), false, "malformed → conservative false");
	assert.equal(piVersionAtLeast("1.0.4", "not-a-version"), false, "malformed FLOOR also fails closed");
});

// ── probePiVersion: seam-injected behavior (NO real spawn) ──────────────

test("probePiVersion: success → trimmed version string; probes the spawn binary with --version", async () => {
	__test_resetPiVersionMemo();
	const fake = fakeExec("\n1.0.4\n");
	const version = await probePiVersion(fake.fn);
	assert.equal(version, "1.0.4", "stdout is trimmed to the bare version");
	assert.equal(fake.calls.length, 1, "exactly one exec");
	const call = fake.calls[0] as RecordedCall;
	assert.equal(call.args[call.args.length - 1], "--version", "the binary is asked for --version");
	assert.deepEqual(call.options, { timeout: PI_VERSION_PROBE_TIMEOUT_MS, encoding: "utf8" }, "5s timeout + utf8");
});

test("probePiVersion: lenient extraction tolerates prefix tokens and banners", async () => {
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(fakeExec("pi 1.0.4").fn), "1.0.4");
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(fakeExec("pi coding agent\nVersion: 1.0.3\n").fn), "1.0.3");
});

test("probePiVersion: nonzero exit / spawn error / timeout → null (never rejects)", async () => {
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(rejectingExec(new Error("Command failed: pi --version, exit 1"))), null);
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(rejectingExec(Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }))), null);
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(rejectingExec(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))), null);
});

test("probePiVersion: unparseable stdout → null (not a throw)", async () => {
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(fakeExec("not a version at all").fn), null);
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(fakeExec("").fn), null);
});

test("probePiVersion: single-flight memoization — one exec per process, failures memoize too", async () => {
	__test_resetPiVersionMemo();
	const fake = fakeExec("1.0.4");
	// Concurrent first calls share ONE flight (the memo captures the first seam).
	const [v1, v2] = await Promise.all([probePiVersion(fake.fn), probePiVersion()]);
	assert.equal(v1, "1.0.4");
	assert.equal(v2, "1.0.4");
	assert.equal(fake.calls.length, 1, "concurrent callers share one flight");
	// Sequential later calls reuse the settled memo — no second exec.
	assert.strictEqual(await probePiVersion(), "1.0.4");
	assert.equal(fake.calls.length, 1, "sequential callers reuse the memo");
	// Failures memoize as null: a later call with a HEALTHY seam must not re-probe.
	__test_resetPiVersionMemo();
	assert.equal(await probePiVersion(rejectingExec(new Error("nope"))), null);
	assert.equal(await probePiVersion(fakeExec("9.9.9").fn), null, "memoized null wins over a later fresh seam");
	__test_resetPiVersionMemo();
});
