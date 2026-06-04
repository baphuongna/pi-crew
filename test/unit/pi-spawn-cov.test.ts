import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPiSpawnCommand } from "../../src/runtime/pi-spawn.ts";
import type { PiSpawnCommand } from "../../src/runtime/pi-spawn.ts";

// ── getPiSpawnCommand ──

describe("getPiSpawnCommand", () => {
	it("returns a command object with 'command' and 'args' properties", () => {
		const result = getPiSpawnCommand(["--help"]);
		assert.ok(result);
		assert.ok(typeof result.command === "string");
		assert.ok(Array.isArray(result.args));
	});

	it("passes through provided arguments", () => {
		const result = getPiSpawnCommand(["--mode", "json", "-p", "hello"]);
		assert.ok(result.args.includes("--mode"));
		assert.ok(result.args.includes("json"));
		assert.ok(result.args.includes("-p"));
		assert.ok(result.args.includes("hello"));
	});

	it("returns a usable node invocation when script is resolved", () => {
		const result = getPiSpawnCommand(["--version"]);
		// Should be either node <script> or pi directly
		assert.ok(
			result.command === "pi" || result.command === process.execPath,
			`Expected 'pi' or node execPath, got '${result.command}'`,
		);
	});

	it("handles empty args array", () => {
		const result = getPiSpawnCommand([]);
		// args may include a resolved script path, but no user-provided args
		assert.ok(Array.isArray(result.args));
		// The command should be usable
		assert.ok(result.command.length > 0);
	});

	it("works without explicit PI_TEAMS_PI_BIN env", () => {
		// Just ensure it doesn't crash
		const result = getPiSpawnCommand(["--help"]);
		assert.ok(result.command.length > 0);
	});
});
