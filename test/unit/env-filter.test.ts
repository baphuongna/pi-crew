import assert from "node:assert/strict";
import test from "node:test";
import { buildScopedAllowList, getExtraEnvAllowlist, providerEnvKeys, sanitizeEnvSecrets } from "../../src/utils/env-filter.ts";

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
	assert.throws(() => sanitizeEnvSecrets({ PI_HOME: "/pi" }, { allowList: ["PI_*"] }), /Allowlist pattern "PI_\*"/);
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

// --- providerEnvKeys tests ---

test("providerEnvKeys extracts provider env keys for known providers", () => {
	assert.deepEqual(providerEnvKeys("openai/gpt-4o"), ["OPENAI_API_KEY", "OPENAI_ORG_ID"]);
	assert.deepEqual(providerEnvKeys("anthropic/claude-sonnet-4-5"), ["ANTHROPIC_API_KEY"]);
	assert.deepEqual(providerEnvKeys("google/gemini-2.0-flash"), ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_LANGUAGE_API_KEY"]);
	assert.deepEqual(providerEnvKeys("azure/openai/gpt-4o"), ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]);
	assert.deepEqual(providerEnvKeys("aws/bedrock/anthropic.claude-v2"), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]);
	assert.deepEqual(providerEnvKeys("zai/glm-5.2"), ["ZEU_API_KEY"]);
	assert.deepEqual(providerEnvKeys("minimax/model"), ["MINIMAX_API_KEY", "MINIMAX_GROUP_ID"]);
});

test("providerEnvKeys returns empty array for unknown/custom providers", () => {
	assert.deepEqual(providerEnvKeys("qwencoder/qwen3.7-max"), []);
	assert.deepEqual(providerEnvKeys("custom/model"), []);
});

test("providerEnvKeys returns empty array for invalid input", () => {
	assert.deepEqual(providerEnvKeys(undefined), []);
	assert.deepEqual(providerEnvKeys("no-slash"), []);
	assert.deepEqual(providerEnvKeys(""), []);
});

// --- buildScopedAllowList tests ---

test("buildScopedAllowList includes system vars + provider keys for model", () => {
	const baseList = ["PATH", "HOME"];
	const result = buildScopedAllowList(baseList, ["openai/gpt-4o"]);
	assert.ok(result.includes("PATH"));
	assert.ok(result.includes("HOME"));
	assert.ok(result.includes("OPENAI_API_KEY"));
	assert.ok(result.includes("OPENAI_ORG_ID"));
	assert.ok(!result.includes("ANTHROPIC_API_KEY"));
});

test("buildScopedAllowList includes keys for all models in chain", () => {
	const baseList = ["PATH", "HOME"];
	const result = buildScopedAllowList(baseList, ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
	assert.ok(result.includes("OPENAI_API_KEY"));
	assert.ok(result.includes("OPENAI_ORG_ID"));
	assert.ok(result.includes("ANTHROPIC_API_KEY"));
});

test("buildScopedAllowList deduplicates provider keys", () => {
	const baseList = ["PATH", "HOME"];
	const result = buildScopedAllowList(baseList, ["openai/gpt-4o", "openai/gpt-4o-mini"]);
	const openaiKeys = result.filter((k) => k.startsWith("OPENAI_"));
	assert.equal(openaiKeys.length, 2); // OPENAI_API_KEY + OPENAI_ORG_ID, not duplicates
});

test("buildScopedAllowList with custom provider returns no extra keys", () => {
	const baseList = ["PATH", "HOME"];
	const result = buildScopedAllowList(baseList, ["qwencoder/qwen3.7-max"]);
	assert.ok(result.includes("PATH"));
	assert.ok(result.includes("HOME"));
	// No provider keys for custom provider
	assert.ok(!result.includes("OPENAI_API_KEY"));
	assert.ok(!result.includes("ANTHROPIC_API_KEY"));
});

test("getExtraEnvAllowlist parses comma-separated PI_CREW_EXTRA_ENV_ALLOWLIST", () => {
	const result = getExtraEnvAllowlist({ PI_CREW_EXTRA_ENV_ALLOWLIST: "MY_PROXY_API_KEY, MY_PROXY_AUTH_HEADER" });
	assert.deepEqual(result, ["MY_PROXY_API_KEY", "MY_PROXY_AUTH_HEADER"]);
});

test("getExtraEnvAllowlist returns empty array when unset", () => {
	assert.deepEqual(getExtraEnvAllowlist({}), []);
});

test("sanitizeEnvSecrets allows a secret-looking name declared via user allowlist option", () => {
	const extra = getExtraEnvAllowlist({ PI_CREW_EXTRA_ENV_ALLOWLIST: "MY_PROXY_API_KEY" });
	const result = sanitizeEnvSecrets({ PATH: "/usr/bin", MY_PROXY_API_KEY: "custom-secret-value" }, { allowList: ["PATH", ...extra] });
	assert.equal(result.MY_PROXY_API_KEY, "custom-secret-value");
});

test("sanitizeEnvSecrets still rejects undeclared secret-looking allowlist entries", () => {
	assert.throws(() => {
		sanitizeEnvSecrets({ PATH: "/usr/bin" }, { allowList: ["PATH", "SOME_RANDOM_API_KEY"] });
	}, /looks like a secret key/);
});
