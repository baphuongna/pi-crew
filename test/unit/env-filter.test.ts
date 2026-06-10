import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeEnvSecrets } from "../../src/utils/env-filter.ts";

test("default deny-list strips secret-like keys", () => {
	const result = sanitizeEnvSecrets({
		PATH: "/usr/bin",
		HOME: "/home/user",
		OPENAI_API_KEY: "sk-secret",
		MY_TOKEN: "tok-secret",
		NORMAL_VAR: "ok",
	});
	assert.equal(result.PATH, "/usr/bin");
	assert.equal(result.HOME, "/home/user");
	assert.equal(result.NORMAL_VAR, "ok");
	assert.equal(result.OPENAI_API_KEY, undefined);
	assert.equal(result.MY_TOKEN, undefined);
});

test("PI_* glob is rejected as dangerous (catches accidental SECRET-like additions)", () => {
	// PI_* is rejected because the prefix + secret suffix would create a secret key
	// (e.g., PI_TOKEN, PI_API_KEY, PI_PASSWORD could all exist in env and would leak).
	// Use PI_CREW_* (controlled namespace) or explicit vars instead.
	assert.throws(
		() => sanitizeEnvSecrets({ PI_HOME: "/pi" }, { allowList: ["PI_*"] }),
		/Allowlist pattern "PI_\*"/,
	);
});

test("allow-list only passes through matched keys", () => {
	const result = sanitizeEnvSecrets(
		{
			PATH: "/usr/bin",
			HOME: "/home/user",
			SECRET: "hidden",
			PI_CREW_DEPTH: "5",
			PI_CREW_PARENT_PID: "1234",
		},
		{ allowList: ["PATH", "HOME", "PI_CREW_*"] },
	);
	assert.equal(result.PATH, "/usr/bin");
	assert.equal(result.HOME, "/home/user");
	assert.equal(result.PI_CREW_DEPTH, "5");
	assert.equal(result.PI_CREW_PARENT_PID, "1234");
	assert.equal(result.SECRET, undefined);
});

test("allow-list glob PI_CREW_* does not match PIPELINE", () => {
	const result = sanitizeEnvSecrets(
		{
			PI_CREW_HOME: "/pi",
			PIPELINE: "ci",
		},
		{ allowList: ["PI_CREW_*"] },
	);
	assert.equal(result.PI_CREW_HOME, "/pi");
	assert.equal(result.PIPELINE, undefined);
});
