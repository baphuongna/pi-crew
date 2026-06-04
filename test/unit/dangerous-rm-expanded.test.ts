/**
 * Expanded dangerous rm pattern tests — verifies that matchesDangerousRm
 * blocks additional patterns beyond the original rm -rf / and rm -rf ~.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isDangerous } from "../../src/tools/safe-bash.ts";

test("blocks rm -rf with absolute paths beyond /", () => {
	assert.ok(isDangerous("rm -rf /etc/passwd"), "rm -rf /etc/passwd");
	assert.ok(isDangerous("rm -rf /var/log"), "rm -rf /var/log");
	assert.ok(isDangerous("rm -rf /usr/local"), "rm -rf /usr/local");
	assert.ok(isDangerous("rm -rf /home/user/data"), "rm -rf /home/user/data");
});

test("blocks rm --recursive --force", () => {
	assert.ok(isDangerous("rm --recursive --force /"), "rm --recursive --force /");
	assert.ok(isDangerous("rm --recursive --force /etc"), "rm --recursive --force /etc");
	assert.ok(isDangerous("rm --force --recursive ~"), "rm --force --recursive ~");
});

test("blocks rm with -R and -F variants", () => {
	assert.ok(isDangerous("rm -Rf /"), "rm -Rf /");
	assert.ok(isDangerous("rm -rF /"), "rm -rF /");
	assert.ok(isDangerous("rm -RF /"), "rm -RF /");
});

test("blocks rm -rf ~/.ssh and ~/.gnupg", () => {
	assert.ok(isDangerous("rm -rf ~/.ssh"), "rm -rf ~/.ssh");
	assert.ok(isDangerous("rm -rf ~/.gnupg"), "rm -rf ~/.gnupg");
});

test("blocks rm -rf with .ssh and .gnupg relative paths", () => {
	assert.ok(isDangerous("rm -rf .ssh/known_hosts"), "rm -rf .ssh/known_hosts");
	assert.ok(isDangerous("rm -rf .gnupg/private-keys"), "rm -rf .gnupg/private-keys");
});

test("still allows safe rm -rf targets", () => {
	assert.ok(!isDangerous("rm -rf node_modules"), "rm -rf node_modules");
	assert.ok(!isDangerous("rm -rf dist"), "rm -rf dist");
	assert.ok(!isDangerous("rm -rf ./cache"), "rm -rf ./cache");
	assert.ok(!isDangerous("rm -rf build"), "rm -rf build");
});

test("blocks rm -rf ~ (home directory)", () => {
	assert.ok(isDangerous("rm -rf ~"), "rm -rf ~");
	assert.ok(isDangerous("rm -rf ~/"), "rm -rf ~/");
	assert.ok(isDangerous("rm -rf ~/Documents"), "rm -rf ~/Documents");
});
