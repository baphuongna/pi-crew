import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveJitiRegisterPath,
	nodeSupportsStripTypes,
	resolveTypeScriptLoader,
	getBackgroundRunnerCommand,
} from "../../src/runtime/async-runner.ts";

describe("resolveJitiRegisterPath", () => {
	it("returns undefined when jiti is not installed", () => {
		// Using a non-existent directory — no jiti there
		const result = resolveJitiRegisterPath("/nonexistent/path/that/does/not/exist", () => false);
		assert.equal(result, undefined);
	});

	it("returns path when jiti-register.mjs exists", () => {
		const fakePath = "/fake/node_modules/jiti/lib/jiti-register.mjs";
		const result = resolveJitiRegisterPath("/fake", (p) => p === fakePath);
		assert.equal(result, fakePath);
	});

	it("walks upward to find jiti", () => {
		const deepPath = "/a/b/node_modules/jiti/lib/jiti-register.mjs";
		const result = resolveJitiRegisterPath("/a/b/c/d", (p) => p === deepPath);
		assert.equal(result, deepPath);
	});
});

describe("nodeSupportsStripTypes", () => {
	it("returns false for Node 18.x", () => {
		assert.equal(nodeSupportsStripTypes("v18.17.0"), false);
	});

	it("returns false for Node 22.5.x", () => {
		assert.equal(nodeSupportsStripTypes("v22.5.9"), false);
	});

	it("returns true for Node 22.6.0", () => {
		assert.equal(nodeSupportsStripTypes("v22.6.0"), true);
	});

	it("returns true for Node 23.0.0", () => {
		assert.equal(nodeSupportsStripTypes("v23.0.0"), true);
	});

	it("returns false for malformed version strings", () => {
		assert.equal(nodeSupportsStripTypes("not-a-version"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(nodeSupportsStripTypes(""), false);
	});
});

describe("resolveTypeScriptLoader", () => {
	it("returns jiti loader when jiti is found", () => {
		const result = resolveTypeScriptLoader({
			packageRoot: "/fake",
			exists: (p) => p === "/fake/node_modules/jiti/lib/jiti-register.mjs",
		});
		assert.ok(result);
		assert.equal(result!.kind, "jiti");
		assert.ok(result!.path.includes("jiti-register.mjs"));
	});

	it("returns strip-types when Node supports it and no jiti", () => {
		const result = resolveTypeScriptLoader({
			packageRoot: "/nonexistent",
			exists: () => false,
			nodeVersion: "v23.0.0",
		});
		assert.ok(result);
		assert.equal(result!.kind, "strip-types");
	});

	it("returns undefined when neither jiti nor strip-types available", () => {
		const result = resolveTypeScriptLoader({
			packageRoot: "/nonexistent",
			exists: () => false,
			nodeVersion: "v18.0.0",
		});
		assert.equal(result, undefined);
	});
});

describe("getBackgroundRunnerCommand", () => {
	it("returns jiti-based command when jiti loader is provided", () => {
		const result = getBackgroundRunnerCommand(
			"/runner.ts",
			"/project",
			"run1",
			{ kind: "jiti", path: "/path/to/jiti-register.mjs" },
		);
		assert.equal(result.loader, "jiti");
		assert.ok(result.args.some((a) => a.includes("jiti-register.mjs")));
		assert.ok(result.args.some((a) => a === "--import"));
		assert.ok(result.args.includes("/runner.ts"));
		assert.ok(result.args.includes("--cwd"));
		assert.ok(result.args.includes("/project"));
		assert.ok(result.args.includes("--run-id"));
		assert.ok(result.args.includes("run1"));
	});

	it("returns strip-types command when strip-types loader is provided", () => {
		const result = getBackgroundRunnerCommand(
			"/runner.ts",
			"/project",
			"run2",
			{ kind: "strip-types" },
		);
		assert.equal(result.loader, "strip-types");
		assert.ok(result.args.includes("--experimental-strip-types"));
		assert.ok(result.args.includes("/runner.ts"));
	});

	it("includes memory limit flag", () => {
		const result = getBackgroundRunnerCommand(
			"/runner.ts",
			"/project",
			"run3",
			{ kind: "jiti", path: "/jiti.mjs" },
		);
		assert.ok(result.args.some((a) => a === "--max-old-space-size=512"));
	});

	it("returns command when system has jiti and undefined loader is passed", () => {
		// On this system jiti is installed, so passing undefined will resolve to jiti
		const result = getBackgroundRunnerCommand("/runner.ts", "/project", "run4", undefined);
		assert.ok(result.loader === "jiti" || result.loader === "strip-types");
	});

	it("throws when loader is explicitly false", () => {
		assert.throws(
			() => getBackgroundRunnerCommand("/runner.ts", "/project", "run5", false),
			/jiti loader not found/,
		);
	});
});
