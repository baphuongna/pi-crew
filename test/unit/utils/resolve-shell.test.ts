import assert from "node:assert/strict";
import test from "node:test";
import { resolveShellForScript } from "../../../src/utils/resolve-shell.ts";

test("resolveShellForScript uses bash for .sh scripts", () => {
	const result = resolveShellForScript("/tmp/check.sh");
	assert.match(result.command, /bash/);
	assert.deepEqual(result.args, ["/tmp/check.sh"]);
});

test("resolveShellForScript uses powershell for .ps1 on Windows", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	const result = resolveShellForScript("C:\\tmp\\check.ps1");
	assert.equal(result.command, "powershell");
	assert.deepEqual(result.args, ["-File", "C:\\tmp\\check.ps1"]);
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

test("resolveShellForScript uses cmd.exe for .cmd on Windows", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "win32" });
	const result = resolveShellForScript("C:\\tmp\\check.cmd");
	assert.equal(result.command, process.env.ComSpec ?? "cmd.exe");
	assert.deepEqual(result.args, ["/d", "/s", "/c", "C:\\tmp\\check.cmd"]);
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});
