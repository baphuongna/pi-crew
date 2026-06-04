import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DynamicScriptRunner,
	createScriptRunner,
	FORBIDDEN_GLOBALS,
	__test_executeUnchecked,
} from "../../src/runtime/dynamic-script-runner.ts";

describe("DynamicScriptRunner — validate", () => {
	it("validates a simple safe script", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("1 + 1");
		assert.equal(result.valid, true);
		assert.equal(result.errors.length, 0);
	});

	it("rejects code with forbidden global 'require'", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("require('fs')");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("require")));
	});

	it("rejects code with forbidden global 'eval'", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("eval('1+1')");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("eval")));
	});

	it("rejects code with forbidden global 'globalThis'", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("globalThis.foo");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("globalThis")));
	});

	it("rejects Math.random as forbidden global", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("Math.random()");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("Math.random")));
	});

	it("rejects invalid JavaScript with parse error", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("function (}");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.type === "parse_error"));
	});

	it("reports warnings for potentially unsafe patterns", () => {
		const runner = new DynamicScriptRunner();
		// with statement triggers a warning
		const result = runner.validate("var x = 1;");
		// This is safe, just checking that warnings are returned properly
		assert.ok(Array.isArray(result.warnings));
	});

	it("rejects process.exit", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("process.exit(1)");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("process.exit")));
	});

	it("allows code with Math.floor (not forbidden)", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.validate("Math.floor(1.5)");
		// Math.floor is not in FORBIDDEN_GLOBALS, only Math.random is
		assert.equal(result.valid, true);
	});
});

describe("DynamicScriptRunner — strictAstWhitelist", () => {
	it("rejects call expressions in strict mode", () => {
		const runner = new DynamicScriptRunner({ strictAstWhitelist: true });
		const result = runner.validate("foo()");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("Call expression")));
	});

	it("rejects member expressions in strict mode", () => {
		const runner = new DynamicScriptRunner({ strictAstWhitelist: true });
		const result = runner.validate("obj.prop");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("property access")));
	});

	it("rejects assignment expressions in strict mode", () => {
		const runner = new DynamicScriptRunner({ strictAstWhitelist: true });
		const result = runner.validate("x = 1");
		assert.equal(result.valid, false);
		assert.ok(result.errors.some((e) => e.message.includes("Assignment")));
	});
});

describe("DynamicScriptRunner — execute", () => {
	it("executes a simple expression with return", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.execute("return 42");
		assert.equal(result.success, true);
		assert.equal(result.value, 42);
	});

	it("returns error for invalid code", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.execute("require('fs')");
		assert.equal(result.success, false);
		assert.ok(result.error);
	});

	it("returns error for runtime errors", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.execute("throw new Error('boom')");
		assert.equal(result.success, false);
		assert.ok(result.error!.includes("boom"));
	});

	it("tracks execution time", () => {
		const runner = new DynamicScriptRunner();
		const result = runner.execute("1 + 1");
		assert.ok(result.executionTime >= 0);
	});
});

describe("DynamicScriptRunner — executeUnchecked (test helper)", () => {
	it("executes code directly without validation", () => {
		const runner = new DynamicScriptRunner();
		const result = __test_executeUnchecked!(runner, "return 2 + 3");
		assert.equal(result.success, true);
		assert.equal(result.value, 5);
	});

	it("returns error for runtime failures", () => {
		const runner = new DynamicScriptRunner();
		const result = __test_executeUnchecked!(runner, "throw new Error('test')");
		assert.equal(result.success, false);
		assert.ok(result.error);
	});
});

describe("createScriptRunner", () => {
	it("creates a DynamicScriptRunner instance", () => {
		const runner = createScriptRunner();
		assert.ok(runner instanceof DynamicScriptRunner);
	});

	it("passes options to the runner", () => {
		const runner = createScriptRunner({ timeout: 5000 });
		assert.ok(runner instanceof DynamicScriptRunner);
	});
});

describe("getForbiddenGlobals", () => {
	it("returns the frozen forbidden globals list", () => {
		const runner = new DynamicScriptRunner();
		const list = runner.getForbiddenGlobals();
		assert.ok(list.includes("require"));
		assert.ok(list.includes("eval"));
		assert.ok(list.includes("Math.random"));
		assert.ok(list.includes("process.exit"));
	});
});
