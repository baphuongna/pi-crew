import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PostCheckConfig } from "../../src/runtime/post-checks.ts";
import { runPostCheck } from "../../src/runtime/post-checks.ts";

describe("runPostCheck", () => {
	it("passes and skips when no script path is configured", async () => {
		const config: PostCheckConfig = { scriptPath: "", timeoutMs: 5000 };
		const result = await runPostCheck(config, "/tmp");

		assert.equal(result.passed, true);
		assert.equal(result.timedOut, false);
		assert.ok(result.output.includes("No post-check script configured"));
		assert.equal(result.durationMs, 0);
	});

	it("passes for a script that exits 0", async (t) => {
		// These tests use POSIX `.sh` scripts with the `bash` shebang. On
		// Windows, `runPostCheck` invokes the runtime's resolveShellForScript
		// which routes `.sh` through bash — not portable when Git Bash is
		// absent. Skip on win32 (path coverage parity with previous fix).
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture; Windows uses .ps1/.bat routed by resolveShellForScript");
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const scriptPath = path.join(dir, "check.sh");
			fs.writeFileSync(scriptPath, "#!/bin/bash\necho 'All checks passed'\nexit 0\n");
			fs.chmodSync(scriptPath, 0o755);

			const config: PostCheckConfig = { scriptPath, timeoutMs: 10000 };
			const result = await runPostCheck(config, dir);

			assert.equal(result.passed, true);
			assert.equal(result.timedOut, false);
			assert.ok(result.output.includes("All checks passed"));
			assert.ok(result.durationMs >= 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails for a script that exits non-zero", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture; Windows uses .ps1/.bat routed by resolveShellForScript");
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const scriptPath = path.join(dir, "fail.sh");
			fs.writeFileSync(scriptPath, "#!/bin/bash\necho 'Check failed' >&2\nexit 1\n");
			fs.chmodSync(scriptPath, 0o755);

			const config: PostCheckConfig = { scriptPath, timeoutMs: 10000 };
			const result = await runPostCheck(config, dir);

			assert.equal(result.passed, false);
			assert.equal(result.timedOut, false);
			assert.ok(result.output.includes("Check failed"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports timeout when script runs too long", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture with sleep builtin; Windows uses .ps1/.bat");
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		try {
			const scriptPath = path.join(dir, "slow.sh");
			fs.writeFileSync(scriptPath, "#!/bin/bash\nsleep 10\necho 'done'\n");
			fs.chmodSync(scriptPath, 0o755);

			const config: PostCheckConfig = { scriptPath, timeoutMs: 500 };
			const result = await runPostCheck(config, dir);

			assert.equal(result.passed, false);
			assert.equal(result.timedOut, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses env var PI_CREW_POST_CHECK_SCRIPT as fallback", async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX .sh fixture; Windows uses .ps1/.bat routed by resolveShellForScript");
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-test-"));
		const originalEnv = process.env.PI_CREW_POST_CHECK_SCRIPT;
		try {
			const scriptPath = path.join(dir, "env-check.sh");
			fs.writeFileSync(scriptPath, "#!/bin/bash\necho 'env script ran'\nexit 0\n");
			fs.chmodSync(scriptPath, 0o755);

			process.env.PI_CREW_POST_CHECK_SCRIPT = scriptPath;

			// Empty scriptPath in config → should fall back to env var
			const config: PostCheckConfig = {
				scriptPath: "",
				timeoutMs: 10000,
			};
			const result = await runPostCheck(config, dir);

			assert.equal(result.passed, true);
			assert.ok(result.output.includes("env script ran"));
		} finally {
			if (originalEnv !== undefined) {
				process.env.PI_CREW_POST_CHECK_SCRIPT = originalEnv;
			} else {
				delete process.env.PI_CREW_POST_CHECK_SCRIPT;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
