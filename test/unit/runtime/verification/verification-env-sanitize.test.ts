/**
 * Phase 1.5 #1 — verification env sanitization unit tests.
 * RFC 13 §6 info-disclosure residual mitigation.
 *
 * P1f redaction at artifact-write + judge-bound is regex-best-effort against
 * adversarial workers. Phase 1.5 #1 closes the leak at the SOURCE by stripping
 * model-provider secrets from the env passed to verification commands. Opt-out
 * via PI_CREW_VERIFICATION_SANITIZE_ENV=0; escape hatch via
 * PI_CREW_VERIFICATION_PRESERVE_ENV=KEY1,KEY2.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { executeVerificationCommands, isVerificationEnvSanitizeEnabled } from "../../../../src/runtime/verification/verification-gates.ts";
import type { VerificationCommandResult } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/** Wave F (S-3, 2026-10-31) removed `printenv` from the gate allowlist, so
 *  the env probes now enter through an ALLOWLISTED entry whose recipe reads
 *  the env — the same entry-command-allowed/script-contents-free pattern as
 *  npm-run: `make test` is the allowlisted entry, the Makefile recipe body
 *  (`@printenv <var>`) is what actually reads the environment. One Makefile
 *  per var, run with cwd=the tmpdir. Never `node -e` (NODE_EVAL_MODE_PATTERN)
 *  and never re-add printenv to the allowlist. */
async function runMakePrintenv(name: string, artifactsDir: string): Promise<VerificationCommandResult[]> {
	const fs = await import("node:fs");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-envsan-"));
	// NOTE: the recipe line MUST start with a real tab (make requirement).
	fs.writeFileSync(path.join(dir, "Makefile"), `test:\n\t@printenv ${name}\n`);
	try {
		return await executeVerificationCommands(
			{ commands: ["make test"] } as never,
			dir,
			"test-run",
			"test-task",
			artifactsDir,
			undefined,
		);
	} finally {
		await removeDirWithRetry(dir);
	}
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	return Promise.resolve(fn()).finally(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
}

test("isVerificationEnvSanitizeEnabled: defaults to true (opt-out)", () => {
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: undefined,
			PI_TEAMS_VERIFICATION_SANITIZE_ENV: undefined,
		},
		() => {
			assert.equal(isVerificationEnvSanitizeEnabled(), true);
		},
	);
});

test("isVerificationEnvSanitizeEnabled: true when PI_CREW_VERIFICATION_SANITIZE_ENV=1", () => {
	return withEnv({ PI_CREW_VERIFICATION_SANITIZE_ENV: "1" }, () => {
		assert.equal(isVerificationEnvSanitizeEnabled(), true);
	});
});

test("isVerificationEnvSanitizeEnabled: true when PI_TEAMS_VERIFICATION_SANITIZE_ENV=1", () => {
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: undefined,
			PI_TEAMS_VERIFICATION_SANITIZE_ENV: "1",
		},
		() => {
			assert.equal(isVerificationEnvSanitizeEnabled(), true);
		},
	);
});

test("INTEGRATION: with sanitize ON, secret env var does NOT reach the verification subprocess", async (t) => {
	if (process.platform === "win32") {
		t.skip("make entry unavailable on win32 runners — env probe kept POSIX-only (S-3 printenv removal)");
		return;
	}
	// Set a fake secret in our env. The allowlisted `make test` entry runs a
	// `@printenv VAR` recipe that reads the named env var to stdout; output
	// should be empty (or absent) when sanitization is enabled.
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "1",
			FAKE_SECRET_API_KEY: "sk-leak-me-12345",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await runMakePrintenv("FAKE_SECRET_API_KEY", path.join(process.cwd(), ".test-artifacts-tmp"));
			assert.equal(results.length, 1);
			// Output artifact captures the printenv output. The secret should NOT appear.
			const out = results[0]?.outputArtifact;
			assert.ok(out, "output artifact must be written");
			const fs = await import("node:fs");
			const content = out?.path ? fs.readFileSync(out.path, "utf-8") : "";
			assert.equal(content.includes("sk-leak-me-12345"), false, "secret must NOT reach verification subprocess when sanitize is ON");
			await removeDirWithRetry(path.join(process.cwd(), ".test-artifacts-tmp"));
		},
	);
});

test("INTEGRATION: with sanitize OFF (explicit opt-out), secret env var DOES reach the verification subprocess", async (t) => {
	if (process.platform === "win32") {
		t.skip("make entry unavailable on win32 runners — env probe kept POSIX-only (S-3 printenv removal)");
		return;
	}
	// Explicit opt-out: sanitize disabled via env var set to '0'.
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "0",
			FAKE_SECRET_API_KEY: "sk-visible-default",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await runMakePrintenv("FAKE_SECRET_API_KEY", path.join(process.cwd(), ".test-artifacts-tmp"));
			assert.equal(results.length, 1);
			const fs = await import("node:fs");
			const content = results[0]?.outputArtifact?.path ? fs.readFileSync(results[0].outputArtifact.path, "utf-8") : "";
			assert.equal(
				content.includes("sk-visible-default"),
				true,
				"explicit opt-out (sanitize=0) preserves existing behavior — secret visible",
			);
			await removeDirWithRetry(path.join(process.cwd(), ".test-artifacts-tmp"));
		},
	);
});

test("INTEGRATION: with sanitize ON + PRESERVE_ENV, explicitly-preserved secret DOES reach subprocess", async (t) => {
	if (process.platform === "win32") {
		t.skip("make entry unavailable on win32 runners — env probe kept POSIX-only (S-3 printenv removal)");
		return;
	}
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "1",
			PI_CREW_VERIFICATION_PRESERVE_ENV: "FAKE_SECRET_API_KEY",
			FAKE_SECRET_API_KEY: "sk-preserved-explicit",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await runMakePrintenv("FAKE_SECRET_API_KEY", path.join(process.cwd(), ".test-artifacts-tmp2"));
			assert.equal(results.length, 1);
			const fs = await import("node:fs");
			const content = results[0]?.outputArtifact?.path ? fs.readFileSync(results[0].outputArtifact.path, "utf-8") : "";
			assert.equal(content.includes("sk-preserved-explicit"), true, "PRESERVE_ENV must allow explicitly-listed secret through");
			await removeDirWithRetry(path.join(process.cwd(), ".test-artifacts-tmp2"));
		},
	);
});

test("INTEGRATION: sanitize ON keeps essential non-secret vars (PATH, HOME)", async (t) => {
	// POSIX-only: the `make test` entry (and its `@printenv` recipe) needs a
	// POSIX make + sh; parity with the prior fix's platform scoping.
	if (process.platform === "win32") {
		t.skip("sanitize-env essential-vars test kept POSIX-only for parity with prior fix");
		return;
	}
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "1",
			PATH: "/usr/bin:/bin",
			HOME: "/tmp/fake-home",
		},
		async () => {
			// One Makefile per var (one target per var) — two allowlisted
			// `make test` entries, one command each (validateGateCommand
			// rejects `&&`, same as before). SEPARATE artifacts dirs: both calls
			// use taskId "test-task", so a shared dir would overwrite
			// phase-1 artifacts with the second run's output.
			const pathResults = await runMakePrintenv("PATH", path.join(process.cwd(), ".test-artifacts-tmp3"));
			const homeResults = await runMakePrintenv("HOME", path.join(process.cwd(), ".test-artifacts-tmp3b"));
			assert.equal(pathResults.length, 1);
			assert.equal(homeResults.length, 1);
			const fs = await import("node:fs");
			const pathContent = pathResults[0]?.outputArtifact?.path ? fs.readFileSync(pathResults[0].outputArtifact.path, "utf-8") : "";
			const homeContent = homeResults[0]?.outputArtifact?.path ? fs.readFileSync(homeResults[0].outputArtifact.path, "utf-8") : "";
			assert.equal(pathContent.includes("/usr/bin:/bin"), true, "PATH must be preserved");
			assert.equal(homeContent.includes("/tmp/fake-home"), true, "HOME must be preserved");
			await removeDirWithRetry(path.join(process.cwd(), ".test-artifacts-tmp3"));
			await removeDirWithRetry(path.join(process.cwd(), ".test-artifacts-tmp3b"));
		},
	);
});
