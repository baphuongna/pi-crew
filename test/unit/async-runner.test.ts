import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { getBackgroundRunnerCommand, resolveJitiRegisterPath, resolveTypeScriptLoader, nodeSupportsStripTypes } from "../../src/runtime/async-runner.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

test("background runner uses the jiti runtime loader for installed TypeScript", () => {
	const command = getBackgroundRunnerCommand("/tmp/node_modules/pi-crew/src/runtime/background-runner.ts", "/tmp/project", "run_123", "/tmp/node_modules/pi-crew/node_modules/jiti/lib/jiti-register.mjs");
	assert.equal(command.loader, "jiti");
	// Memory limit is prepended first
	assert.equal(command.args[0], "--max-old-space-size=512");
	// V8 fatal-error report is ON by default (3 flags after memory limit).
	assert.equal(command.args[1], "--report-on-fatalerror");
	assert.equal(command.args[2], "--report-compact");
	assert.match(command.args[3] ?? "", /^--report-directory=/);
	// trace-uncaught + import + jiti loader follow.
	assert.ok(command.args.includes("--trace-uncaught"), "expected --trace-uncaught in args");
	const importIdx = command.args.indexOf("--import");
	assert.ok(importIdx > 0, "expected --import in args");
	assert.match(command.args[importIdx + 1] ?? "", /jiti-register\.mjs$/);
	assert.ok(command.args.includes("/tmp/node_modules/pi-crew/src/runtime/background-runner.ts"));
	assert.deepEqual(command.args.slice(-4), ["--cwd", "/tmp/project", "--run-id", "run_123"]);
});

test("background runner resolves hoisted jiti loader path", () => {
	const root = path.join("tmp", "workspace", "node_modules", "pi-crew");
	const hoisted = path.resolve(path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	assert.equal(resolveJitiRegisterPath(root, (candidate) => candidate === hoisted), hoisted);
});

test("background runner resolves local-source jiti loader in parent node_modules", () => {
	const root = path.join(os.tmpdir(), "pi-crew-local");
	const local = path.resolve(path.join(os.tmpdir(), "pi-crew-local", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	assert.equal(resolveJitiRegisterPath(root, (candidate) => candidate === local), local);
});

test("background runner command fails fast when no loader is available", () => {
	assert.throws(() => getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", false), /jiti loader not found/);
});

test("nodeSupportsStripTypes accepts Node >= 22.6", () => {
	assert.equal(nodeSupportsStripTypes("v22.6.0"), true);
	assert.equal(nodeSupportsStripTypes("v22.14.0"), true);
	assert.equal(nodeSupportsStripTypes("v23.0.0"), true);
	assert.equal(nodeSupportsStripTypes("v22.5.1"), false);
	assert.equal(nodeSupportsStripTypes("v20.15.0"), false);
	assert.equal(nodeSupportsStripTypes("v18.20.0"), false);
	assert.equal(nodeSupportsStripTypes("not-a-version"), false);
});

test("resolveTypeScriptLoader prefers jiti when available", () => {
	const root = path.join("tmp", "workspace", "pi-crew");
	const jitiPath = path.resolve(path.join("tmp", "workspace", "node_modules", "jiti", "lib", "jiti-register.mjs"));
	const loader = resolveTypeScriptLoader({
		packageRoot: root,
		exists: (candidate) => candidate === jitiPath,
		nodeVersion: "v22.14.0",
	});
	assert.deepEqual(loader, { kind: "jiti", path: jitiPath });
});

test("resolveTypeScriptLoader falls back to strip-types when jiti is missing and Node >= 22.6", () => {
	const loader = resolveTypeScriptLoader({
		packageRoot: "/nonexistent",
		exists: () => false,
		nodeVersion: "v22.14.0",
	});
	assert.deepEqual(loader, { kind: "strip-types" });
});

test("resolveTypeScriptLoader returns undefined when jiti missing and Node < 22.6", () => {
	const loader = resolveTypeScriptLoader({
		packageRoot: "/nonexistent",
		exists: () => false,
		nodeVersion: "v20.15.0",
	});
	assert.equal(loader, undefined);
});

test("getBackgroundRunnerCommand emits --experimental-strip-types args for strip-types loader", () => {
	const command = getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", { kind: "strip-types" });
	assert.equal(command.loader, "strip-types");
	assert.equal(command.args[0], "--max-old-space-size=512");
	// Report flags (default ON) sit between the memory limit and the loader flag.
	assert.ok(command.args.includes("--experimental-strip-types"), "expected --experimental-strip-types in args");
	assert.ok(command.args.includes("/tmp/runner.ts"));
	assert.deepEqual(command.args.slice(-4), ["--cwd", "/tmp/project", "--run-id", "run_123"]);
});

test("getBackgroundRunnerCommand accepts loader-spec input directly", () => {
	const jitiPath = "/tmp/x/node_modules/jiti/lib/jiti-register.mjs";
	const command = getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", { kind: "jiti", path: jitiPath });
	assert.equal(command.loader, "jiti");
	assert.equal(command.args[0], "--max-old-space-size=512");
	// --import <jiti> pair: find --import then check the following arg.
	const importIdx = command.args.indexOf("--import");
	assert.ok(importIdx > 0, "expected --import in args");
	assert.match(command.args[importIdx + 1] ?? "", /jiti-register\.mjs$/);
});

test("getBackgroundRunnerCommand emits V8 fatal-error report flags by default (ON)", () => {
	// Ensure env is clean so the default-ON behavior is exercised.
	const savedCrew = process.env.PI_CREW_BG_REPORT_ON_FATAL;
	const savedTeams = process.env.PI_TEAMS_BG_REPORT_ON_FATAL;
	delete process.env.PI_CREW_BG_REPORT_ON_FATAL;
	delete process.env.PI_TEAMS_BG_REPORT_ON_FATAL;
	try {
		const command = getBackgroundRunnerCommand(
			"/tmp/runner.ts",
			"/tmp/project",
			"run_123",
			{ kind: "strip-types" },
			"/custom/state/root",
		);
		assert.ok(command.args.includes("--report-on-fatalerror"), "expected --report-on-fatalerror by default");
		assert.ok(command.args.includes("--report-compact"), "expected --report-compact by default");
		assert.ok(
			command.args.includes("--report-directory=/custom/state/root"),
			"expected --report-directory to equal the stateRoot argument",
		);
	} finally {
		if (savedCrew !== undefined) process.env.PI_CREW_BG_REPORT_ON_FATAL = savedCrew;
		if (savedTeams !== undefined) process.env.PI_TEAMS_BG_REPORT_ON_FATAL = savedTeams;
	}
});

test("getBackgroundRunnerCommand disables V8 report flags when PI_CREW_BG_REPORT_ON_FATAL=0", () => {
	const savedCrew = process.env.PI_CREW_BG_REPORT_ON_FATAL;
	process.env.PI_CREW_BG_REPORT_ON_FATAL = "0";
	try {
		const command = getBackgroundRunnerCommand("/tmp/runner.ts", "/tmp/project", "run_123", { kind: "strip-types" });
		assert.ok(!command.args.includes("--report-on-fatalerror"), "did not expect --report-on-fatalerror when opted out");
		assert.ok(!command.args.some((a) => a.startsWith("--report-directory=")));
	} finally {
		if (savedCrew === undefined) delete process.env.PI_CREW_BG_REPORT_ON_FATAL;
		else process.env.PI_CREW_BG_REPORT_ON_FATAL = savedCrew;
	}
});
