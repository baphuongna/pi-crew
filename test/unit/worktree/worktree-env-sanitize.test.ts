/**
 * Worktree env sanitization tests — verify that git operations in worktree
 * files use sanitized environment instead of raw process.env.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEnvSecrets } from "../../../src/utils/env-filter.ts";
import { buildGitSafeEnv, parseSystemCoreEol } from "../../../src/worktree/git-hardening.ts";

test("sanitizeEnvSecrets strips secret env vars", () => {
	const env = {
		PATH: "/usr/bin",
		HOME: "/home/user",
		ANTHROPIC_API_KEY: "sk-secret-123",
		AWS_SECRET_ACCESS_KEY: "aws-secret",
		MY_TOKEN: "token-value",
		NODE_ENV: "test",
	};
	const sanitized = sanitizeEnvSecrets(env as Record<string, string>, {
		allowList: ["PATH", "HOME", "NODE_ENV"],
	});
	assert.equal(sanitized.PATH, "/usr/bin");
	assert.equal(sanitized.HOME, "/home/user");
	assert.equal(sanitized.NODE_ENV, "test");
	assert.equal(sanitized.ANTHROPIC_API_KEY, undefined);
	assert.equal(sanitized.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(sanitized.MY_TOKEN, undefined);
});

test("sanitizeEnvSecrets supports glob patterns in allowList", () => {
	const env = {
		PATH: "/usr/bin",
		PI_CREW_RUN_ID: "run-123",
		PI_CREW_VAR: "custom",
		OTHER_VAR: "other",
		API_KEY: "secret",
	};
	const sanitized = sanitizeEnvSecrets(env as Record<string, string>, {
		allowList: ["PATH", "PI_CREW_*"],
	});
	assert.equal(sanitized.PATH, "/usr/bin");
	assert.equal(sanitized.PI_CREW_RUN_ID, "run-123");
	assert.equal(sanitized.PI_CREW_VAR, "custom");
	assert.equal(sanitized.OTHER_VAR, undefined);
	assert.equal(sanitized.API_KEY, undefined);
});

test("sanitizeEnvSecrets includes git-relevant vars", () => {
	const env = {
		PATH: "/usr/bin",
		GIT_AUTHOR_NAME: "Author",
		GIT_AUTHOR_EMAIL: "author@example.com",
		GIT_COMMITTER_NAME: "Committer",
		GIT_COMMITTER_EMAIL: "committer@example.com",
		LANG: "C",
		LC_ALL: "C",
		SECRET_TOKEN: "should-be-stripped",
	};
	const sanitized = sanitizeEnvSecrets(env as Record<string, string>, {
		allowList: ["PATH", "LANG", "LC_ALL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"],
	});
	assert.equal(sanitized.GIT_AUTHOR_NAME, "Author");
	assert.equal(sanitized.GIT_AUTHOR_EMAIL, "author@example.com");
	assert.equal(sanitized.GIT_COMMITTER_NAME, "Committer");
	assert.equal(sanitized.GIT_COMMITTER_EMAIL, "committer@example.com");
	assert.equal(sanitized.SECRET_TOKEN, undefined);
});

test("sanitizeEnvSecrets with no allowList uses deny-list mode", () => {
	const env = {
		PATH: "/usr/bin",
		HOME: "/home/user",
		MY_API_KEY: "secret-key",
		SECRET_TOKEN: "should-be-stripped",
	};
	const sanitized = sanitizeEnvSecrets(env as Record<string, string>);
	assert.equal(sanitized.PATH, "/usr/bin");
	assert.equal(sanitized.HOME, "/home/user");
	// Secret keys are omitted entirely in deny-list mode
	assert.equal(sanitized.MY_API_KEY, undefined);
	assert.equal(sanitized.SECRET_TOKEN, undefined);
});

// --- R-A4: pins for the SHARED git env builder (buildGitSafeEnv, replaces
// the per-module GIT_SAFE_ENV copies in cleanup.ts / worktree-manager.ts /
// branch-freshness.ts). ---

test("parseSystemCoreEol: strict [core] eol scalars only — invalid/foreign keys dropped", () => {
	// Valid scalars in and out (comments + spacing tolerated).
	assert.deepEqual(
		parseSystemCoreEol("[core]\n\tautocrlf = true\n\teol = crlf\n"),
		{ autocrlf: "true", eol: "crlf" },
	);
	assert.deepEqual(parseSystemCoreEol("[core]\nautocrlf=input # trailing comment\n"), { autocrlf: "input" });
	// Values outside the domain are DROPPED (never forwarded).
	assert.deepEqual(parseSystemCoreEol("[core]\nautocrlf = $(curl evil)\neol = bogus\n"), {});
	// Keys outside [core] never contribute.
	assert.deepEqual(
		parseSystemCoreEol("[fetch]\nautocrlf = true\n[core]\nfsmonitor = /evil.sh\n"),
		{},
	);
	// The dangerous [core] keys a poisoned system config could carry are NOT
	// parsed at all — the channel is structurally limited to the two eol keys.
	assert.deepEqual(
		parseSystemCoreEol("[core]\nautocrlf = true\nfsmonitor = /evil.sh\nsshCommand = /evil.sh\n"),
		{ autocrlf: "true" },
	);
});

test("buildGitSafeEnv eol passthrough: attacker GIT_CONFIG_* stays stripped; injected keys are only validated eol scalars", () => {
	process.env.GIT_CONFIG_COUNT = "1";
	process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
	process.env.GIT_CONFIG_VALUE_0 = "/attacker/script.sh";
	try {
		const env = buildGitSafeEnv();
		// Attacker-controlled key/value never survives (allowlist strip) and is
		// never MERGED into any injected entry.
		for (const [k, v] of Object.entries(env)) {
			if (k.startsWith("GIT_CONFIG_KEY_") || k.startsWith("GIT_CONFIG_VALUE_")) {
				assert.ok(v === "core.autocrlf" || v === "core.eol" || v === "true" || v === "false" || v === "input" || v === "lf" || v === "crlf" || v === "native", `injected GIT_CONFIG entry must be a validated eol scalar, got ${k}=${v}`);
			}
		}
		if (env.GIT_CONFIG_COUNT !== undefined) {
			// When the host system gitconfig carries eol semantics, the injected
			// count matches the validated entries 1:1 — the attacker's count was
			// overwritten, not added to.
			const n = Number(env.GIT_CONFIG_COUNT);
			assert.ok(Number.isInteger(n) && n >= 1 && n <= 2, `injected count must be 1-2, got ${env.GIT_CONFIG_COUNT}`);
			for (let i = 0; i < n; i++) assert.ok(env[`GIT_CONFIG_KEY_${i}`] && env[`GIT_CONFIG_VALUE_${i}`] !== undefined, `injected entry ${i} incomplete`);
			assert.equal(env["GIT_CONFIG_KEY_2"], undefined, "no injected entry beyond the count");
		}
		// NOSYSTEM stays forced regardless of injection.
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
	} finally {
		delete process.env.GIT_CONFIG_COUNT;
		delete process.env.GIT_CONFIG_KEY_0;
		delete process.env.GIT_CONFIG_VALUE_0;
	}
});

test("R-A4: buildGitSafeEnv strips secrets, drops GIT_CONFIG_SYSTEM, forces GIT_CONFIG_NOSYSTEM", () => {
	const saved = { ...process.env };
	process.env.W108_MED1_API_KEY = "sk-leak-me";
	process.env.GIT_CONFIG_SYSTEM = "/attacker/controlled/system.gitconfig";
	process.env.GIT_CONFIG_GLOBAL = "/user/global.gitconfig";
	try {
		const env = buildGitSafeEnv();
		// Secrets never reach the git child process.
		assert.equal(env.W108_MED1_API_KEY, undefined);
		// R-A4(a): GIT_CONFIG_SYSTEM is NOT forwarded — a forwarded value would
		// defeat GIT_CONFIG_NOSYSTEM on git>=2.32.
		assert.equal(env.GIT_CONFIG_SYSTEM, undefined);
		assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
		// R-A4(b): GIT_CONFIG_GLOBAL stays forwarded (commit identity) with the
		// documented residual (trusted-config filter definitions stay executable).
		assert.equal(env.GIT_CONFIG_GLOBAL, "/user/global.gitconfig");
		// Locale pinned per variant.
		assert.equal(env.LANG, "C");
		assert.equal(env.LC_ALL, "C");
		assert.equal(buildGitSafeEnv("en_US.UTF-8").LC_ALL, "en_US.UTF-8");
		// Essentials survive.
		assert.equal(typeof env.PATH, "string");
	} finally {
		delete process.env.W108_MED1_API_KEY;
		delete process.env.GIT_CONFIG_SYSTEM;
		if (saved.GIT_CONFIG_SYSTEM !== undefined) process.env.GIT_CONFIG_SYSTEM = saved.GIT_CONFIG_SYSTEM;
		if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
	}
});
