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
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { executeVerificationCommands, isVerificationEnvSanitizeEnabled } from "../../src/runtime/verification-gates.ts";
import { pickPrintenv } from "../fixtures/cross-platform-cmd.ts";

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

test("INTEGRATION: with sanitize ON, secret env var does NOT reach the verification subprocess", async () => {
	// Set a fake secret in our env. The verification command reads the named
	// env var to stdout (POSIX: `printenv FAKE_SECRET_API_KEY`, win32: node
	// `process.env.VAR`); output should be empty (or absent) when sanitization
	// is enabled.
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "1",
			FAKE_SECRET_API_KEY: "sk-leak-me-12345",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await executeVerificationCommands(
				{ commands: [pickPrintenv("FAKE_SECRET_API_KEY")] } as never,
				process.cwd(),
				"test-run",
				"test-task",
				path.join(process.cwd(), ".test-artifacts-tmp"),
				undefined,
			);
			assert.equal(results.length, 1);
			// Output artifact captures the printenv output. The secret should NOT appear.
			const out = results[0]?.outputArtifact;
			assert.ok(out, "output artifact must be written");
			const fs = await import("node:fs");
			const content = out?.path ? fs.readFileSync(out.path, "utf-8") : "";
			assert.equal(content.includes("sk-leak-me-12345"), false, "secret must NOT reach verification subprocess when sanitize is ON");
			fs.rmSync(path.join(process.cwd(), ".test-artifacts-tmp"), {
				recursive: true,
				force: true,
			});
		},
	);
});

test("INTEGRATION: with sanitize OFF (explicit opt-out), secret env var DOES reach the verification subprocess", async () => {
	// Explicit opt-out: sanitize disabled via env var set to '0'.
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "0",
			FAKE_SECRET_API_KEY: "sk-visible-default",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await executeVerificationCommands(
				{ commands: [pickPrintenv("FAKE_SECRET_API_KEY")] } as never,
				process.cwd(),
				"test-run",
				"test-task",
				path.join(process.cwd(), ".test-artifacts-tmp"),
				undefined,
			);
			const fs = await import("node:fs");
			const content = results[0]?.outputArtifact?.path ? fs.readFileSync(results[0].outputArtifact.path, "utf-8") : "";
			assert.equal(
				content.includes("sk-visible-default"),
				true,
				"explicit opt-out (sanitize=0) preserves existing behavior — secret visible",
			);
			fs.rmSync(path.join(process.cwd(), ".test-artifacts-tmp"), {
				recursive: true,
				force: true,
			});
		},
	);
});

test("INTEGRATION: with sanitize ON + PRESERVE_ENV, explicitly-preserved secret DOES reach subprocess", async () => {
	return withEnv(
		{
			PI_CREW_VERIFICATION_SANITIZE_ENV: "1",
			PI_CREW_VERIFICATION_PRESERVE_ENV: "FAKE_SECRET_API_KEY",
			FAKE_SECRET_API_KEY: "sk-preserved-explicit",
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		},
		async () => {
			const results = await executeVerificationCommands(
				{ commands: [pickPrintenv("FAKE_SECRET_API_KEY")] } as never,
				process.cwd(),
				"test-run",
				"test-task",
				path.join(process.cwd(), ".test-artifacts-tmp2"),
				undefined,
			);
			const fs = await import("node:fs");
			const content = results[0]?.outputArtifact?.path ? fs.readFileSync(results[0].outputArtifact.path, "utf-8") : "";
			assert.equal(content.includes("sk-preserved-explicit"), true, "PRESERVE_ENV must allow explicitly-listed secret through");
			fs.rmSync(path.join(process.cwd(), ".test-artifacts-tmp2"), {
				recursive: true,
				force: true,
			});
		},
	);
});

test("INTEGRATION: sanitize ON keeps essential non-secret vars (PATH, HOME)", async (t) => {
	// This test spawns the cross-platform env-read fixture. On Windows it
	// routes through Node's `process.env`; the previous `printenv`-only skip
	// is preserved for the sanitize-test infrastructure parity the prior
	// fix relied on (POSIX path coverage is the primary surface here).
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
			// Run two separate commands (validateGateCommand rejects `&&`).
			const results = await executeVerificationCommands(
				{
					commands: [pickPrintenv("PATH"), pickPrintenv("HOME")],
				} as never,
				process.cwd(),
				"test-run",
				"test-task",
				path.join(process.cwd(), ".test-artifacts-tmp3"),
				undefined,
			);
			assert.equal(results.length, 2);
			const fs = await import("node:fs");
			const pathContent = results[0]?.outputArtifact?.path ? fs.readFileSync(results[0].outputArtifact.path, "utf-8") : "";
			const homeContent = results[1]?.outputArtifact?.path ? fs.readFileSync(results[1].outputArtifact.path, "utf-8") : "";
			assert.equal(pathContent.includes("/usr/bin:/bin"), true, "PATH must be preserved");
			assert.equal(homeContent.includes("/tmp/fake-home"), true, "HOME must be preserved");
			fs.rmSync(path.join(process.cwd(), ".test-artifacts-tmp3"), {
				recursive: true,
				force: true,
			});
		},
	);
});
