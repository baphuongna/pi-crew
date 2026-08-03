import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDangerous } from "../../../src/tools/safe-bash.ts";

describe("safe-bash ANSI escape stripping", () => {
	it("strips ANSI color codes from commands before pattern matching", () => {
		// A command that looks dangerous only after ANSI stripping
		const cmd = "ls\x1b[31m; rm -rf /\x1b[0m";
		const result = isDangerous(cmd);
		assert.ok(result, "should detect dangerous rm after ANSI stripping");
	});

	it("strips control characters from commands", () => {
		// Null byte, bell, vertical tab etc.
		const cmd = "ls\x00; rm -rf /";
		const result = isDangerous(cmd);
		assert.ok(result, "should detect dangerous rm after control char stripping");
	});

	it("allows safe commands with ANSI escapes", () => {
		const cmd = "echo\x1b[32m hello\x1b[0m";
		const result = isDangerous(cmd);
		assert.equal(result, null, "safe commands with ANSI should pass");
	});

	it("strips multiple ANSI sequences", () => {
		const cmd = "\x1b[1;34mgit\x1b[0m \x1b[32mstatus\x1b[0m";
		const result = isDangerous(cmd);
		assert.equal(result, null, "git status with ANSI should pass");
	});

	it("handles ANSI escape in sudo detection", () => {
		const cmd = "\x1b[31msudo\x1b[0m apt-get install something";
		const result = isDangerous(cmd);
		assert.ok(result, "should detect sudo after ANSI stripping");
	});

	it("strips control chars in the \\x00-\\x08 range", () => {
		const cmd = "echo\x01\x02\x03 test";
		const result = isDangerous(cmd);
		assert.equal(result, null, "control chars should be stripped, leaving safe command");
	});
});
