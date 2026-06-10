/**
 * Worktree env sanitization tests — verify that git operations in worktree
 * files use sanitized environment instead of raw process.env.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeEnvSecrets } from "../../src/utils/env-filter.ts";

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
		allowList: [
			"PATH",
			"LANG",
			"LC_ALL",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
		],
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
