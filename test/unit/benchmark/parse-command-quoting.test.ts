import assert from "node:assert/strict";
import test from "node:test";
import { parseAndValidateCommand, tokenizeCommand } from "../../../src/benchmark/benchmark-runner.ts";

/**
 * RM-02 (2026-09-22): parseAndValidateCommand split on whitespace, so a quoted
 * judge argument (`llm-judge --prompt "score 1-10"`) was silently mis-split
 * into `"score` + `1-10"` — wrong argv handed to a real process. Now uses a
 * quote-aware tokenizer that FAILS CLOSED on unterminated quotes.
 *
 * The security posture is preserved: DANGEROUS_ARG_PATTERNS still runs on the
 * RESULTING tokens, so quoting cannot smuggle shell syntax. Mutation: revert to
 * `split(/\s+/)` → the quoted-arg cases go RED.
 */

test("RM-02: double-quoted argument stays one token", () => {
	assert.deepEqual(tokenizeCommand('judge --prompt "score 1-10"'), ["judge", "--prompt", "score 1-10"]);
});

test("RM-02: single-quoted argument stays one token", () => {
	assert.deepEqual(tokenizeCommand("judge --prompt 'score 1-10'"), ["judge", "--prompt", "score 1-10"]);
});

test("RM-02: backslash escape outside quotes", () => {
	assert.deepEqual(tokenizeCommand("judge a\\ b"), ["judge", "a b"]);
});

test("RM-02: unterminated quote fails closed (no silent mis-split)", () => {
	assert.throws(() => tokenizeCommand('judge "unterminated'), /Unterminated/);
	assert.throws(() => tokenizeCommand("judge 'unterminated"), /Unterminated/);
});

test("RM-02: empty / whitespace-only command", () => {
	assert.deepEqual(tokenizeCommand("   "), []);
	assert.throws(() => parseAndValidateCommand("   "), /Empty command/);
});

test("RM-02: parseAndValidateCommand keeps the executable allowlist", () => {
	assert.deepEqual(parseAndValidateCommand('echo "hello world"'), { program: "echo", args: ["hello world"] });
	assert.throws(() => parseAndValidateCommand("curl http://x"), /Command not allowed/);
});

test("RM-02: quoting cannot smuggle shell metacharacters past the blocker", () => {
	// The dangerous text is INSIDE the quotes → token contains `;` → blocked.
	assert.throws(() => parseAndValidateCommand('echo "a; rm -rf /"'), /metacharacters/);
	assert.throws(() => parseAndValidateCommand("echo 'a | b'"), /metacharacters/);
	assert.throws(() => parseAndValidateCommand('echo "$(whoami)"'), /metacharacters/);
});

test("RM-02: required subcommands still enforced with quoting", () => {
	assert.deepEqual(parseAndValidateCommand('npm test -- --grep "some test"'), {
		program: "npm",
		args: ["test", "--", "--grep", "some test"],
	});
	assert.throws(() => parseAndValidateCommand("npm publish"), /must be invoked as/);
});
