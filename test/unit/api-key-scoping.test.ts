import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildPiSpawnOptions } from "../../src/runtime/child-pi.ts";

// Per-task API key scoping: a worker assigned to a specific model only receives
// that provider's env keys. Provider keys for other models are stripped.
// When no model is provided, NO provider keys leak (deny-by-default).

test("scopes API keys to OpenAI when model='openai/gpt-4o'", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
			GOOGLE_API_KEY: "google-secret",
		},
		"openai/gpt-4o",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, "openai-secret", "OpenAI key should be present");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT be present");
	assert.equal(env.GOOGLE_API_KEY, undefined, "Google key must NOT be present");
	// System vars still present
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.HOME, "/home/user");
});

test("scopes API keys to Anthropic when model='anthropic/claude'", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
		},
		"anthropic/claude-sonnet-4-5",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.ANTHROPIC_API_KEY, "anthropic-secret", "Anthropic key should be present");
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT be present");
});

test("injects AWS keys for bedrock model", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			AWS_ACCESS_KEY_ID: "aws-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_REGION: "us-east-1",
			OPENAI_API_KEY: "openai-secret",
		},
		"bedrock/anthropic.claude",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.AWS_ACCESS_KEY_ID, "aws-key", "AWS key should be present");
	assert.equal(env.AWS_REGION, "us-east-1", "AWS region should be present");
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT be present");
});

test("leaks no provider keys when model is undefined", () => {
	const opts = buildChildPiSpawnOptions("/tmp/project", {
		PATH: "/usr/bin",
		HOME: "/home/user",
		OPENAI_API_KEY: "openai-secret",
		ANTHROPIC_API_KEY: "anthropic-secret",
	});
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT leak when model undefined");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT leak when model undefined");
	assert.equal(env.PATH, "/usr/bin", "PATH should still be present");
	assert.equal(env.HOME, "/home/user", "HOME should still be present");
});

test("leaks no extra provider keys for unknown provider", () => {
	const opts = buildChildPiSpawnOptions(
		"/tmp/project",
		{
			PATH: "/usr/bin",
			OPENAI_API_KEY: "openai-secret",
			ANTHROPIC_API_KEY: "anthropic-secret",
		},
		"custom/unknown-model",
	);
	const env = opts.env as Record<string, string>;
	assert.equal(env.OPENAI_API_KEY, undefined, "OpenAI key must NOT leak for unknown provider");
	assert.equal(env.ANTHROPIC_API_KEY, undefined, "Anthropic key must NOT leak for unknown provider");
	assert.equal(env.PATH, "/usr/bin", "PATH should still be present");
});
