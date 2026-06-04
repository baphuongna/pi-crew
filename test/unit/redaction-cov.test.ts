import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isSecretKey,
	redactAuthHeader,
	redactBearerTokens,
	redactSecretString,
	redactSecrets,
	redactJsonLine,
} from "../../src/utils/redaction.ts";

describe("isSecretKey", () => {
	it("matches common exact secret key names", () => {
		assert.equal(isSecretKey("token"), true);
		assert.equal(isSecretKey("password"), true);
		assert.equal(isSecretKey("secret"), true);
		assert.equal(isSecretKey("apikey"), true);
		assert.equal(isSecretKey("authorization"), true);
		assert.equal(isSecretKey("credential"), true);
	});

	it("matches case-insensitively", () => {
		assert.equal(isSecretKey("TOKEN"), true);
		assert.equal(isSecretKey("Password"), true);
		assert.equal(isSecretKey("SECRET"), true);
	});

	it("matches prefixed keys with underscores/dots/hyphens", () => {
		assert.equal(isSecretKey("MY_API_KEY"), true);
		assert.equal(isSecretKey("AWS_SECRET"), true);
		assert.equal(isSecretKey("db.password"), true);
		assert.equal(isSecretKey("app-token"), true);
	});

	it("does not match non-secret keys", () => {
		assert.equal(isSecretKey("PATH"), false);
		assert.equal(isSecretKey("HOME"), false);
		assert.equal(isSecretKey("USER"), false);
		assert.equal(isSecretKey("PORT"), false);
	});

	it("does not match empty string", () => {
		assert.equal(isSecretKey(""), false);
	});

	it("matches keys with private_key pattern", () => {
		assert.equal(isSecretKey("MY_PRIVATE_KEY"), true);
		assert.equal(isSecretKey("ssh-privatekey"), true);
	});
});

describe("redactAuthHeader", () => {
	it("adds redaction marker to Authorization header with non-Bearer value", () => {
		const result = redactAuthHeader('authorization: Basic abc123');
		assert.ok(result.includes("***"));
	});

	it("does not redact Bearer tokens (handled separately)", () => {
		const result = redactAuthHeader('authorization: Bearer tok_12345678');
		// Bearer tokens are handled by redactBearerTokens, not here
		assert.ok(result.includes("Bearer"));
	});

	it("returns unchanged line when no authorization header", () => {
		const line = "content-type: application/json";
		assert.equal(redactAuthHeader(line), line);
	});

	it("handles Authorization at start of line", () => {
		const result = redactAuthHeader("authorization: Basic secret123");
		assert.ok(result.includes("***"));
	});
});

describe("redactBearerTokens", () => {
	it("redacts Bearer tokens with sufficient length", () => {
		const result = redactBearerTokens('Bearer abcdefghijklmnop');
		assert.ok(result.includes("Bearer "));
		assert.ok(result.includes("***"));
		assert.ok(!result.includes("abcdefghijklmn"));
	});

	it("does not redact short tokens (< 8 chars)", () => {
		const result = redactBearerTokens("Bearer abc");
		assert.ok(result.includes("abc"));
	});

	it("returns unchanged text without Bearer", () => {
		const line = "no bearer token here";
		assert.equal(redactBearerTokens(line), line);
	});

	it("handles multiple Bearer tokens in one line", () => {
		const result = redactBearerTokens("auth: Bearer abcdefghijklmnop and Bearer zyxwvutsrqponmlk");
		assert.ok(!result.includes("abcdefghijklmn"));
		assert.ok(!result.includes("zyxwvutsrqponm"));
	});
});

describe("redactSecretString", () => {
	it("redacts PEM private keys", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKx1\n-----END RSA PRIVATE KEY-----";
		const result = redactSecretString(pem);
		assert.ok(result.includes("***"));
		assert.ok(!result.includes("MIIBOgIBAAJBAKx1"));
	});

	it("redacts inline key=value patterns", () => {
		const result = redactSecretString("token=abc123def");
		assert.ok(result.includes("***"));
		assert.ok(!result.includes("abc123def"));
	});

	it("preserves non-secret content", () => {
		const line = "hello world foo=bar";
		assert.ok(redactSecretString(line).includes("hello world"));
	});
});

describe("redactSecrets", () => {
	it("redacts secret values by key name", () => {
		const result = redactSecrets({ password: "hunter2", name: "Alice" });
		assert.equal((result as Record<string, unknown>).password, "***");
		assert.equal((result as Record<string, unknown>).name, "Alice");
	});

	it("redacts strings containing secrets", () => {
		const result = redactSecrets("token=secretvalue12345");
		assert.ok(typeof result === "string");
		assert.ok((result as string).includes("***"));
	});

	it("passes through non-secret primitives", () => {
		assert.equal(redactSecrets(42), 42);
		assert.equal(redactSecrets(true), true);
		assert.equal(redactSecrets(null), null);
	});

	it("recursively redacts arrays", () => {
		const result = redactSecrets(["token=abcdef123456", "normal"]);
		assert.ok(Array.isArray(result));
		assert.ok((result as string[])[0].includes("***"));
		assert.equal((result as string[])[1], "normal");
	});

	it("recursively redacts nested objects", () => {
		const result = redactSecrets({ outer: { password: "secret" } });
		assert.equal((result as { outer: { password: string } }).outer.password, "***");
	});

	it("handles undefined value", () => {
		assert.equal(redactSecrets(undefined), undefined);
	});
});

describe("redactJsonLine", () => {
	it("redacts secrets in JSON string", () => {
		const json = JSON.stringify({ password: "hunter2", user: "bob" });
		const result = redactJsonLine(json);
		const parsed = JSON.parse(result);
		assert.equal(parsed.password, "***");
		assert.equal(parsed.user, "bob");
	});

	it("handles non-JSON strings via redactSecretString fallback", () => {
		const result = redactJsonLine("token=abcdef1234567890");
		assert.ok(result.includes("***"));
	});

	it("handles malformed JSON gracefully", () => {
		const result = redactJsonLine("{invalid json");
		assert.ok(typeof result === "string");
	});
});
