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

	it("FIX #5: does NOT treat token-count keys as secrets", () => {
		// These contain 'token' and matched '_token' in isSecretKey's keyword
		// scan, causing ALL LLM usage counts to be redacted to '***' in
		// events.jsonl. They are observable metrics, not credentials.
		const tokenKeys = [
			"prompt_tokens",
			"completion_tokens",
			"total_tokens",
			"cached_tokens",
			"reasoning_tokens",
			"cached_read_tokens",
			"cached_write_tokens",
			"input_tokens",
			"output_tokens",
		];
		for (const key of tokenKeys) {
			assert.equal(isSecretKey(key), false, `${key} must NOT be classified as a secret`);
			assert.equal(isSecretKey(key.toUpperCase()), false, `${key.toUpperCase()} (uppercase) must NOT be classified as a secret`);
		}
	});

	it("FIX #5: redactSecrets preserves token-count values", () => {
		// Token counts must survive redactSecrets so events.jsonl retains
		// observable usage data while real secrets are still redacted.
		const input = {
			prompt_tokens: 1500,
			completion_tokens: 320,
			total_tokens: 1820,
			cached_tokens: 900,
			reasoning_tokens: 50,
			api_key: "sk-live-abc123",
			password: "hunter2",
		};
		const result = redactSecrets(input) as Record<string, unknown>;
		assert.equal(result.prompt_tokens, 1500, "prompt_tokens value must be preserved");
		assert.equal(result.completion_tokens, 320, "completion_tokens value must be preserved");
		assert.equal(result.total_tokens, 1820, "total_tokens value must be preserved");
		assert.equal(result.cached_tokens, 900, "cached_tokens value must be preserved");
		assert.equal(result.reasoning_tokens, 50, "reasoning_tokens value must be preserved");
		assert.equal(result.api_key, "***", "api_key must still be redacted");
		assert.equal(result.password, "***", "password must still be redacted");
	});

	it("FIX #5: redactJsonLine preserves token counts in JSON event lines", () => {
		const jsonLine = JSON.stringify({
			event: "usage",
			prompt_tokens: 1500,
			completion_tokens: 320,
			total_tokens: 1820,
		});
		const result = redactJsonLine(jsonLine);
		const parsed = JSON.parse(result) as Record<string, unknown>;
		assert.equal(parsed.prompt_tokens, 1500);
		assert.equal(parsed.completion_tokens, 320);
		assert.equal(parsed.total_tokens, 1820);
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

describe("redactAuthHeader — L3/L5 regression (security review)", () => {
	it("L3: redacts EVERY occurrence across multiple lines (was first-only)", () => {
		const input = "line1\nAuthorization: Basic sec-one\nmid line\nauthorization: Basic sec-two";
		const result = redactSecretString(input);
		assert.ok(!result.includes("sec-one"), "first occurrence value must be redacted");
		assert.ok(!result.includes("sec-two"), "second occurrence value must be redacted (L3)");
	});

	it("L5: redacts Proxy-Authorization (non-Bearer) — boundary includes '-'", () => {
		const result = redactSecretString("Proxy-Authorization: Basic c2VjcmV0");
		assert.ok(!result.includes("c2VjcmV0"), "Proxy-Authorization Basic credential must be redacted (L5)");
		assert.ok(result.includes("***"));
	});

	it("L5: redacts X-Authorization (non-Bearer)", () => {
		const result = redactSecretString("X-Authorization: Basic c2VjcmV0");
		assert.ok(!result.includes("c2VjcmV0"), "X-Authorization Basic credential must be redacted (L5)");
	});

	it("L5: redacts tab-indented Authorization header — boundary includes '\\t'", () => {
		const result = redactSecretString("\tauthorization: Basic sec-tab");
		assert.ok(!result.includes("sec-tab"), "tab-indented Authorization must be redacted (L5)");
	});

	it("regression: still does NOT redact Bearer values here (delegated to redactBearerTokens)", () => {
		const result = redactAuthHeader("authorization: Bearer tok_12345678");
		assert.ok(result.includes("Bearer"), "Bearer keyword must be preserved for redactBearerTokens");
	});
});

describe("redactBearerTokens — L5 regression", () => {
	it("L5: redacts Bearer token preceded by '-' (Proxy-Authorization: Bearer ...)", () => {
		const result = redactBearerTokens("Proxy-Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234");
		assert.ok(!result.includes("abcdefghijklmnopqrstuvwxyz1234"), "Bearer token after hyphen-boundary must be redacted (L5)");
		assert.ok(result.includes("***"));
	});
});
