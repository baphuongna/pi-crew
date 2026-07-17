import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HookPayload, HookResult } from "../../src/runtime/iteration-hooks.ts";
import { hookLogEntry, isAllowedHookPath, runIterationHook, steerMessageFromHook } from "../../src/runtime/iteration-hooks.ts";

/** Helper to create a standard hook payload. */
function makePayload(overrides: Partial<HookPayload> = {}): HookPayload {
	return {
		event: "before",
		cwd: os.tmpdir(),
		taskId: "task-1",
		runId: "run-1",
		taskRole: "agent",
		session: {
			teamName: "test-team",
			workflowName: "default",
			goal: "test goal",
			completedTasks: 0,
			totalTasks: 2,
		},
		...overrides,
	};
}

describe("isAllowedHookPath", () => {
	it("rejects empty paths", () => {
		assert.equal(isAllowedHookPath(""), false);
		assert.equal(isAllowedHookPath("   "), false);
	});
	it("rejects absolute paths outside ~/.pi/hooks/", () => {
		assert.equal(isAllowedHookPath("/tmp/evil.sh"), false);
		assert.equal(isAllowedHookPath("/home/user/scripts/hook.sh"), false);
	});
	it("rejects relative paths outside .hooks/", () => {
		assert.equal(isAllowedHookPath("../outside.sh"), false);
		assert.equal(isAllowedHookPath("scripts/hook.sh"), false);
		assert.equal(isAllowedHookPath("hooks/hook.sh"), false);
	});
	it("accepts relative paths starting with .hooks/", () => {
		// Use path.posix.normalize for consistent forward-slash handling on all platforms.
		assert.equal(isAllowedHookPath(".hooks/hook.sh"), true);
		assert.equal(isAllowedHookPath(".hooks/my-hook.sh"), true);
	});
	it("accepts .hooks (without trailing slash)", () => {
		assert.equal(isAllowedHookPath(".hooks"), true);
	});
	it("accepts absolute paths under ~/.pi/hooks/", () => {
		// Normalize to forward slashes to avoid cross-platform path.sep issues.
		// Both path.join and path.isAbsolute use forward slashes on all platforms
		// when the input already contains forward slashes.
		const homeHooks = (process.env.HOME ?? "").replace(/\\/g, "/") + "/.pi/hooks";
		assert.equal(isAllowedHookPath(homeHooks + "/hook.sh"), true);
		assert.equal(isAllowedHookPath(homeHooks), true);
	});
});

describe("runIterationHook", () => {
	let dir: string;
	let hooksDir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hook-"));
		hooksDir = path.join(dir, ".hooks");
		fs.mkdirSync(hooksDir);
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns notFired when script doesn't exist", async () => {
		const result = await runIterationHook(makePayload({ cwd: dir }), ".hooks/nonexistent.sh");
		assert.equal(result.fired, false);
	});

	it("fires and captures stdout when script succeeds with output", async (t) => {
		// These test cases write POSIX `.sh` files to disk and execute them via
		// the iteration-hook shim. On Windows the shim routes `.sh` through
		// bash, but the test file extension is fixed by the runtime's
		// resolveShellForScript policy — so we skip on win32 rather than
		// rewriting the test to cover a .bat equivalent (out of scope; the
		// shim's own .ps1/.bat routing is unit-tested elsewhere).
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture; Windows iteration-hook path uses .ps1/.bat");
			return;
		}
		const scriptPath = path.join(hooksDir, "success.sh");
		fs.writeFileSync(scriptPath, '#!/bin/bash\nread input\necho "hook-output: $input"\nexit 0\n');
		fs.chmodSync(scriptPath, 0o755);
		const result = await runIterationHook(makePayload({ cwd: dir }), ".hooks/success.sh");
		assert.equal(result.fired, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, false);
		assert.ok(result.stdout.includes("hook-output:"));
	});

	it("fires and captures stderr when script exits non-zero", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture; Windows iteration-hook path uses .ps1/.bat");
			return;
		}
		const scriptPath = path.join(hooksDir, "fail.sh");
		fs.writeFileSync(scriptPath, '#!/bin/bash\necho "error message" >&2\nexit 1\n');
		fs.chmodSync(scriptPath, 0o755);
		const result = await runIterationHook(makePayload({ cwd: dir }), ".hooks/fail.sh");
		assert.equal(result.fired, true);
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, false);
		assert.ok(result.stderr.includes("error message"));
	});

	it("reports timeout when script runs longer than timeout", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture with sleep builtin; Windows iteration-hook path uses .ps1/.bat");
			return;
		}
		const scriptPath = path.join(hooksDir, "slow.sh");
		fs.writeFileSync(scriptPath, "#!/bin/bash\nsleep 5\necho done\nexit 0\n");
		fs.chmodSync(scriptPath, 0o755);
		const result = await runIterationHook(makePayload({ cwd: dir }), ".hooks/slow.sh", { timeoutMs: 2000 });
		assert.equal(result.fired, true);
		assert.equal(result.timedOut, true);
		assert.ok(result.durationMs >= 1_500);
	});

	it("truncates stdout at 8KB boundary on newline", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture with for/seq; Windows iteration-hook path uses .ps1/.bat");
			return;
		}
		const scriptPath = path.join(hooksDir, "verbose.sh");
		fs.writeFileSync(scriptPath, '#!/bin/bash\nfor i in $(seq 1 1000); do echo "Line $i: padding"; done\nexit 0\n');
		fs.chmodSync(scriptPath, 0o755);
		const result = await runIterationHook(makePayload({ cwd: dir }), ".hooks/verbose.sh");
		assert.equal(result.fired, true);
		assert.equal(result.exitCode, 0);
		assert.ok(result.stdout.length <= 8192, `stdout ${result.stdout.length} exceeds 8KB`);
		assert.ok(result.stdout.length > 0);
	});

	it("rejects absolute paths outside allowed directories", async () => {
		const result = await runIterationHook(makePayload({ cwd: dir }), "/tmp/evil.sh");
		assert.equal(result.fired, false);
		assert.ok(result.stderr.includes("hook path not allowed"));
	});

	it("rejects paths outside .hooks/ subdirectory", async () => {
		const result = await runIterationHook(makePayload({ cwd: dir }), "../outside.sh");
		assert.equal(result.fired, false);
		assert.ok(result.stderr.includes("hook path not allowed"));
	});
});

describe("steerMessageFromHook", () => {
	it("returns null for notFired result", () => {
		const result: HookResult = {
			fired: false,
			stdout: "",
			stderr: "",
			exitCode: null,
			timedOut: false,
			durationMs: 0,
		};
		assert.equal(steerMessageFromHook("before", result), null);
	});

	it("returns trimmed stdout for successful hook with output", () => {
		const result: HookResult = {
			fired: true,
			stdout: "  proceed with plan  \n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			durationMs: 100,
		};
		assert.equal(steerMessageFromHook("after", result), "proceed with plan");
	});

	it("returns null for successful hook with empty stdout", () => {
		const result: HookResult = {
			fired: true,
			stdout: "   \n  \n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			durationMs: 50,
		};
		assert.equal(steerMessageFromHook("after", result), null);
	});

	it("returns error steer message for non-zero exit code", () => {
		const result: HookResult = {
			fired: true,
			stdout: "",
			stderr: "something went wrong",
			exitCode: 1,
			timedOut: false,
			durationMs: 200,
		};
		const msg = steerMessageFromHook("before", result);
		assert.ok(msg !== null);
		assert.ok(msg!.includes("[before-hook]"));
		assert.ok(msg!.includes("exited with code 1"));
		assert.ok(msg!.includes("something went wrong"));
	});

	it("returns timeout steer message for timed out hook", () => {
		const result: HookResult = {
			fired: true,
			stdout: "",
			stderr: "",
			exitCode: null,
			timedOut: true,
			durationMs: 30_000,
		};
		const msg = steerMessageFromHook("after", result);
		assert.ok(msg !== null);
		assert.ok(msg!.includes("[after-hook]"));
		assert.ok(msg!.includes("timed out"));
	});

	it("filters denied metric names from hook output", () => {
		const result: HookResult = {
			fired: true,
			stdout: "CREW_METRIC __proto__=42\nCREW_METRIC valid_count=7\nCREW_METRIC constructor=99\n",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			durationMs: 100,
		};
		const msg = steerMessageFromHook("after", result);
		assert.ok(msg !== null);
		assert.ok(!msg!.includes("__proto__"));
		assert.ok(!msg!.includes("constructor"));
		assert.ok(msg!.includes("CREW_METRIC valid_count=7"));
	});
});

describe("hookLogEntry", () => {
	it("produces minimal entry for notFired result", () => {
		const result: HookResult = {
			fired: false,
			stdout: "",
			stderr: "",
			exitCode: null,
			timedOut: false,
			durationMs: 0,
		};
		const entry = hookLogEntry("before", result);
		assert.equal(entry.type, "iteration-hook");
		assert.equal(entry.stage, "before");
		assert.equal(entry.fired, false);
		assert.equal(entry.durationMs, 0);
		assert.equal(entry.exitCode, undefined);
	});

	it("includes exitCode and stdout/stderr previews for fired result", () => {
		const result: HookResult = {
			fired: true,
			stdout: "hook output here",
			stderr: "some stderr",
			exitCode: 0,
			timedOut: false,
			durationMs: 150,
		};
		const entry = hookLogEntry("after", result);
		assert.equal(entry.fired, true);
		assert.equal(entry.exitCode, 0);
		assert.equal(entry.stdoutPreview, "hook output here");
		assert.equal(entry.stderrPreview, "some stderr");
	});

	it("includes timedOut flag for timed-out results", () => {
		const result: HookResult = {
			fired: true,
			stdout: "",
			stderr: "",
			exitCode: null,
			timedOut: true,
			durationMs: 30_000,
		};
		const entry = hookLogEntry("before", result);
		assert.equal(entry.timedOut, true);
	});
});
