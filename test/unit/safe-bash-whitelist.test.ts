/**
 * Safe Bash Whitelist Mode Tests
 *
 * These tests cover the opt-in whitelist mode
 * (PI_CREW_SAFE_BASH_MODE=whitelist) independently of the legacy blacklist in
 * safe-bash.test.ts. isDangerous and its tests are untouched.
 */

import assert from "node:assert";
import test from "node:test";
import { getSafeBashMode, isAllowedWhitelist } from "../../src/tools/safe-bash.ts";

// --- isAllowedWhitelist: allowed commands ---

test("whitelist allows each whitelisted command", () => {
	for (const cmd of [
		"ls",
		"cat",
		"head",
		"tail",
		"wc",
		"grep",
		"find",
		"echo",
		"pwd",
		"date",
		"whoami",
		"uname",
		"df",
		"du",
		"file",
		"stat",
	]) {
		assert.ok(isAllowedWhitelist(cmd), `expected ${cmd} to be allowed`);
	}
});

test("whitelist allows commands with flags and arguments", () => {
	assert.ok(isAllowedWhitelist("ls -la"));
	assert.ok(isAllowedWhitelist("ls -la /tmp"));
	assert.ok(isAllowedWhitelist("grep -r pattern ."));
	assert.ok(isAllowedWhitelist("find . -name '*.ts'"));
	assert.ok(isAllowedWhitelist("echo hello world"));
	assert.ok(isAllowedWhitelist('echo "hello world"'));
	assert.ok(isAllowedWhitelist("wc -l file.txt"));
	assert.ok(isAllowedWhitelist("head -n 10 file.txt"));
	assert.ok(isAllowedWhitelist("du -sh ."));
	assert.ok(isAllowedWhitelist("df -h"));
	assert.ok(isAllowedWhitelist("stat package.json"));
});

// --- isAllowedWhitelist: blocked commands ---

test("whitelist blocks non-whitelisted commands", () => {
	assert.ok(!isAllowedWhitelist("rm -rf /tmp"));
	assert.ok(!isAllowedWhitelist("npm install"));
	assert.ok(!isAllowedWhitelist("node script.js"));
	assert.ok(!isAllowedWhitelist("python -c 'print(1)'"));
	assert.ok(!isAllowedWhitelist("git status"));
	assert.ok(!isAllowedWhitelist("curl http://example.com"));
	assert.ok(!isAllowedWhitelist("chmod 777 /"));
	assert.ok(!isAllowedWhitelist("sudo apt-get update"));
});

// --- shell operators blocked even with an allowed first token ---

test("whitelist blocks pipe operator", () => {
	assert.ok(!isAllowedWhitelist("ls | grep foo"));
	assert.ok(!isAllowedWhitelist("cat file | head"));
});

test("whitelist blocks semicolon chaining", () => {
	assert.ok(!isAllowedWhitelist("ls; rm file"));
	assert.ok(!isAllowedWhitelist("pwd; pwd"));
});

test("whitelist blocks ampersand chaining", () => {
	assert.ok(!isAllowedWhitelist("ls && rm file"));
	assert.ok(!isAllowedWhitelist("ls &"));
});

test("whitelist blocks redirects", () => {
	assert.ok(!isAllowedWhitelist("ls > file"));
	assert.ok(!isAllowedWhitelist("ls >> file"));
	assert.ok(!isAllowedWhitelist("cat file < input"));
});

test("whitelist blocks command substitution $(...)", () => {
	assert.ok(!isAllowedWhitelist("ls $(whoami)"));
	assert.ok(!isAllowedWhitelist("echo $(whoami)"));
});

test("whitelist blocks backtick substitution", () => {
	assert.ok(!isAllowedWhitelist("echo `whoami`"));
});

test("whitelist blocks subshells", () => {
	assert.ok(!isAllowedWhitelist("(ls)"));
	assert.ok(!isAllowedWhitelist("(rm -rf /)"));
});

test("whitelist allows plain variable expansion (no command substitution)", () => {
	assert.ok(isAllowedWhitelist("echo ${HOME}"));
	assert.ok(isAllowedWhitelist("ls $HOME"));
});

// --- quoting and edge cases ---

test("whitelist resolves quoted first token", () => {
	assert.ok(isAllowedWhitelist('"ls" -la'));
	assert.ok(isAllowedWhitelist("'cat' file.txt"));
	assert.ok(!isAllowedWhitelist('"rm" file'));
	assert.ok(!isAllowedWhitelist("'npm' install"));
});

test("whitelist handles unmatched quote without crashing", () => {
	assert.ok(!isAllowedWhitelist('ls"'));
	assert.ok(!isAllowedWhitelist("'cat"));
});

test("whitelist rejects empty and whitespace-only input", () => {
	assert.ok(!isAllowedWhitelist(""));
	assert.ok(!isAllowedWhitelist("   "));
	assert.ok(!isAllowedWhitelist("\t\n"));
});

// --- getSafeBashMode ---

test("getSafeBashMode defaults to blacklist when env unset", () => {
	const saved = process.env.PI_CREW_SAFE_BASH_MODE;
	delete process.env.PI_CREW_SAFE_BASH_MODE;
	try {
		assert.equal(getSafeBashMode(), "blacklist");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_SAFE_BASH_MODE;
		else process.env.PI_CREW_SAFE_BASH_MODE = saved;
	}
});

test("getSafeBashMode returns whitelist when env set", () => {
	const saved = process.env.PI_CREW_SAFE_BASH_MODE;
	process.env.PI_CREW_SAFE_BASH_MODE = "whitelist";
	try {
		assert.equal(getSafeBashMode(), "whitelist");
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_SAFE_BASH_MODE;
		else process.env.PI_CREW_SAFE_BASH_MODE = saved;
	}
});
