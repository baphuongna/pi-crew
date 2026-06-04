import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeEnvSecrets } from "../../src/utils/env-filter.ts";

describe("sanitizeEnvSecrets (default deny-list)", () => {
	it("strips keys matching secret patterns", () => {
		const result = sanitizeEnvSecrets({
			PATH: "/usr/bin",
			OPENAI_API_KEY: "sk-secret",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			NORMAL_VAR: "ok",
		});
		assert.equal(result.PATH, "/usr/bin");
		assert.equal(result.NORMAL_VAR, "ok");
		assert.equal(result.OPENAI_API_KEY, undefined);
		assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined);
	});

	it("strips token-like keys", () => {
		const result = sanitizeEnvSecrets({
			MY_TOKEN: "tok-abc",
			GITHUB_TOKEN: "ghp_abc",
			APP_KEY: "key-abc",
		});
		assert.equal(result.MY_TOKEN, undefined);
		assert.equal(result.GITHUB_TOKEN, undefined);
		assert.equal(result.APP_KEY, undefined);
	});

	it("preserves safe keys", () => {
		const result = sanitizeEnvSecrets({
			HOME: "/home/user",
			NODE_ENV: "test",
			PORT: "3000",
		});
		assert.equal(result.HOME, "/home/user");
		assert.equal(result.NODE_ENV, "test");
		assert.equal(result.PORT, "3000");
	});

	it("skips undefined values", () => {
		const result = sanitizeEnvSecrets({ PATH: undefined, HOME: "/home" });
		assert.equal(result.PATH, undefined);
		assert.equal(result.HOME, "/home");
	});
});

describe("sanitizeEnvSecrets (allow-list mode)", () => {
	it("only preserves keys matching allow-list", () => {
		const result = sanitizeEnvSecrets(
			{
				PATH: "/usr/bin",
				HOME: "/home",
				SECRET: "hidden",
				PI_HOME: "/pi",
			},
			{ allowList: ["PATH", "HOME"] },
		);
		assert.equal(result.PATH, "/usr/bin");
		assert.equal(result.HOME, "/home");
		assert.equal(result.SECRET, undefined);
		assert.equal(result.PI_HOME, undefined);
	});

	it("supports glob patterns with trailing *", () => {
		const result = sanitizeEnvSecrets(
			{
				PI_HOME: "/pi",
				PI_CREW_DIR: "/crew",
				OTHER_VAR: "no",
				PIA: "no-match",
			},
			{ allowList: ["PI_*"] },
		);
		assert.equal(result.PI_HOME, "/pi");
		assert.equal(result.PI_CREW_DIR, "/crew");
		assert.equal(result.OTHER_VAR, undefined);
		assert.equal(result.PIA, undefined); // "PIA" does not start with "PI_"
	});

	it("returns empty object when no keys match", () => {
		const result = sanitizeEnvSecrets(
			{ PATH: "/bin", HOME: "/h" },
			{ allowList: ["NONEXISTENT_*"] },
		);
		assert.deepEqual(result, {});
	});

	it("handles multiple allow-list entries", () => {
		const result = sanitizeEnvSecrets(
			{ A: "1", B: "2", C: "3" },
			{ allowList: ["A", "C"] },
		);
		assert.equal(result.A, "1");
		assert.equal(result.B, undefined);
		assert.equal(result.C, "3");
	});

	it("handles empty allow-list (falls through to deny-list)", () => {
		const result = sanitizeEnvSecrets(
			{ PATH: "/bin", TOKEN: "secret" },
			{ allowList: [] },
		);
		// Empty allowList should fall through to default deny-list mode
		assert.equal(result.PATH, "/bin");
		assert.equal(result.TOKEN, undefined);
	});
});
