import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiSpawnCommand } from "../../src/runtime/pi-spawn.ts";

test("getPiSpawnCommand preserves requested args", () => {
	const spec = getPiSpawnCommand(["--version"]);
	assert.ok(spec.command.length > 0);
	assert.ok(spec.args.includes("--version"));
});

test("PI_TEAMS_PI_BIN accepts symlink targets in npm-style lib/node_modules", () => {
	const previousBin = process.env.PI_TEAMS_PI_BIN;
	const previousPrefix = process.env.npm_config_prefix;
	const tempPrefix = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prefix-"));
	const binDir = path.join(tempPrefix, "bin");
	const libDir = path.join(tempPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	const targetScript = path.join(libDir, "cli.js");
	const shimPath = path.join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");
	try {
		fs.mkdirSync(binDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });
		fs.writeFileSync(targetScript, "console.log('ok');\n", "utf-8");
		fs.symlinkSync(targetScript, shimPath);
		process.env.npm_config_prefix = tempPrefix;
		process.env.PI_TEAMS_PI_BIN = shimPath;
		const command = getPiSpawnCommand(["--version"]);
		assert.equal(command.command, shimPath);
		assert.deepEqual(command.args, ["--version"]);
	} finally {
		if (previousBin === undefined) delete process.env.PI_TEAMS_PI_BIN;
		else process.env.PI_TEAMS_PI_BIN = previousBin;
		if (previousPrefix === undefined) delete process.env.npm_config_prefix;
		else process.env.npm_config_prefix = previousPrefix;
		fs.rmSync(tempPrefix, { recursive: true, force: true });
	}
});
