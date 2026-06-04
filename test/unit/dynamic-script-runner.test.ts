import test from "node:test";
import assert from "node:assert/strict";
import {
	DynamicScriptRunner,
	createScriptRunner,
	FORBIDDEN_GLOBALS,
	__test_executeUnchecked,
	type ScriptValidationResult,
	type ScriptExecutionResult,
} from "../../src/runtime/dynamic-script-runner.ts";

test("DynamicScriptRunner validates safe code", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("const x = 1; return x + 2;");
	assert.equal(result.valid, true);
	assert.equal(result.errors.length, 0);
});

test("DynamicScriptRunner allows Date (not dangerous)", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("Date.now()");
	assert.equal(result.valid, true);
});

test("DynamicScriptRunner rejects Math.random", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("Math.random()");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("Math.random")));
});

test("DynamicScriptRunner rejects require", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("require('fs')");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("require")));
});

test("DynamicScriptRunner rejects eval", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("eval('1 + 1')");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.type === "forbidden_syntax"));
});

test("DynamicScriptRunner rejects Function constructor", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new Function('return 1')");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.type === "forbidden_syntax"));
});

test("DynamicScriptRunner rejects process.exit", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("process.exit(0)");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("process.exit")));
});

test("DynamicScriptRunner rejects parse errors", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("const x = ");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.type === "parse_error"));
});

test("DynamicScriptRunner executes simple arithmetic", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 1; const y = 2; return x + y;");
	assert.equal(result.success, true);
	assert.equal(result.value, 3);
});

test("DynamicScriptRunner executes with async/await", async () => {
	const runner = new DynamicScriptRunner();
	const result = await runner.executeAsync("const x = await Promise.resolve(5); return x * 2;");
	assert.equal(result.success, true);
	assert.equal(result.value, 10);
});

test("DynamicScriptRunner executes JSON operations", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const obj = {a: 1, b: 2}; return JSON.stringify(obj);");
	assert.equal(result.success, true);
	assert.equal(result.value, '{"a":1,"b":2}');
});

test("DynamicScriptRunner executes array operations", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const arr = [1, 2, 3]; return arr.map(x => x * 2);");
	assert.equal(result.success, true);
	// Use JSON comparison since VM arrays may have different constructors
	assert.equal(JSON.stringify(result.value), JSON.stringify([2, 4, 6]));
});

test("DynamicScriptRunner handles runtime errors", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("throw new Error('test error')");
	assert.equal(result.success, false);
	assert.ok(result.error?.includes("test error"));
});

test("DynamicScriptRunner respects timeout", () => {
	const runner = new DynamicScriptRunner({ timeout: 100 });
	const result = runner.execute("while(true) {}", { timeout: 100 });
	assert.equal(result.success, false);
	assert.ok(result.error?.includes("timed out") || result.error?.includes("Script timed out"));
});

test("DynamicScriptRunner provides warnings for potentially unsafe patterns", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("with (obj) {} new Promise((resolve) => resolve());");
	assert.equal(result.valid, true); // Should still be valid
	assert.ok(result.warnings.length > 0); // But with warnings
});

test("DynamicScriptRunner rejects import", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("import { x } from 'y';");
	assert.equal(result.valid, false);
	// import is a parse error in non-module VM context, not a forbidden_global
	assert.ok(result.errors.some((e) => e.type === "parse_error"));
});

test("DynamicScriptRunner rejects module.exports", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("module.exports = {}");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("module")));
});

test("DynamicScriptRunner rejects __dirname", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("return __dirname");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("__dirname")));
});

test("DynamicScriptRunner rejects __filename", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("return __filename");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("__filename")));
});

test("DynamicScriptRunner rejects global", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("return global");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("global")));
});

test("DynamicScriptRunner rejects WebAssembly", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new WebAssembly.Module()");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("WebAssembly")));
});

test("DynamicScriptRunner rejects fetch", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("fetch('http://example.com')");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("fetch")));
});

test("DynamicScriptRunner rejects XMLHttpRequest", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new XMLHttpRequest()");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("XMLHttpRequest")));
});

test("DynamicScriptRunner rejects Proxy", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new Proxy({}, {})");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("Proxy")));
});

test("DynamicScriptRunner rejects Reflect", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("Reflect.apply()");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.message.includes("Reflect")));
});

test("DynamicScriptRunner rejects AsyncFunction constructor", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new AsyncFunction()");
	assert.equal(result.valid, false);
	assert.ok(result.errors.some((e) => e.type === "forbidden_syntax"));
});

test("DynamicScriptRunner provides execution time", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 1; return x;");
	assert.ok(result.executionTime >= 0);
});

test("DynamicScriptRunner includes validation in execution result", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 1; return x;");
	assert.ok(result.validation);
	assert.equal(result.validation.valid, true);
});

test("DynamicScriptRunner returns validation errors in execution result", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("eval('1 + 1')");
	assert.equal(result.success, false);
	assert.ok(result.error);
	assert.ok(result.validation.errors.length > 0);
});

test("DynamicScriptRunner executeUnchecked bypasses validation", () => {
	const runner = new DynamicScriptRunner();
	// executeUnchecked bypasses validation, even for dangerous code
	const result = __test_executeUnchecked!(runner, "eval('1 + 1')");
	// Note: executeUnchecked doesn't validate, so it should succeed
	// (the sandbox still restricts execution, but validation is skipped)
	assert.equal(result.success, true);
});

test("DynamicScriptRunner getForbiddenGlobals returns list", () => {
	const runner = new DynamicScriptRunner();
	const globals = runner.getForbiddenGlobals();
	assert.ok(Array.isArray(globals));
	assert.ok(globals.length > 0);
	assert.ok(globals.includes("Math.random"));
	assert.ok(!globals.includes("Date"), "Date should not be forbidden");
});

test("createScriptRunner factory function", () => {
	const runner = createScriptRunner({ timeout: 5000 });
	assert.ok(runner instanceof DynamicScriptRunner);
});

test("DynamicScriptRunner with custom timeout option", () => {
	const runner = new DynamicScriptRunner({ timeout: 5000 });
	const result = runner.execute("const x = 1; return x;");
	assert.equal(result.success, true);
});

test("DynamicScriptRunner allows await in async code", async () => {
	const runner = new DynamicScriptRunner();
	const result = await runner.executeAsync("const x = await Promise.resolve(42); return x;");
	assert.equal(result.success, true);
	assert.equal(result.value, 42);
});

test("DynamicScriptRunner async execution handles errors", async () => {
	const runner = new DynamicScriptRunner();
	const result = await runner.executeAsync("throw new Error('async error')");
	assert.equal(result.success, false);
	assert.ok(result.error?.includes("async error"));
});

test("FORBIDDEN_GLOBALS is a readonly array", () => {
	assert.ok(Array.isArray(FORBIDDEN_GLOBALS));
	assert.ok(Object.isFrozen(FORBIDDEN_GLOBALS));
});

test("DynamicScriptRunner executes object operations", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const obj = {a: 1}; obj.b = 2; return Object.keys(obj);");
	assert.equal(result.success, true);
	assert.deepEqual(result.value, ["a", "b"]);
});

test("DynamicScriptRunner executes Map operations", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const m = new Map(); m.set('a', 1); return m.get('a');");
	assert.equal(result.success, true);
	assert.equal(result.value, 1);
});

test("DynamicScriptRunner executes Set operations", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const s = new Set([1, 2, 3]); return s.has(2);");
	assert.equal(result.success, true);
	assert.equal(result.value, true);
});

test("DynamicScriptRunner executes RegExp", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const r = /test/; return r.test('testing');");
	assert.equal(result.success, true);
	assert.equal(result.value, true);
});

test("DynamicScriptRunner executes parseInt/parseFloat", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return parseInt('42') + parseFloat('3.14');");
	assert.equal(result.success, true);
	assert.equal(result.value, 45.14);
});

test("DynamicScriptRunner executes encodeURI/decodeURI", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return decodeURI(encodeURI('hello world'));");
	assert.equal(result.success, true);
	assert.equal(result.value, "hello world");
});

test("DynamicScriptRunner executes String/Number/Boolean", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return String(123) + Number('456') + Boolean(1);");
	assert.equal(result.success, true);
	assert.equal(result.value, "123456true");
});

test("DynamicScriptRunner executes Math static methods", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return Math.max(1, 5) + Math.min(2, 3);"); // 5 + 2 = 7
	assert.equal(result.success, true);
	assert.equal(result.value, 7);
});

test("DynamicScriptRunner executes Promise.resolve", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return Promise.resolve(5).then(x => x * 2);");
	assert.ok(result.value instanceof Promise);
});

test("DynamicScriptRunner warns about Promise constructor", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("new Promise((resolve) => resolve(1))");
	assert.equal(result.valid, true);
	assert.ok(result.warnings.some((w) => w.message.includes("Promise constructor")));
});

test("DynamicScriptRunner rejects nested function declarations with warnings", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.validate("function outer() { function inner() {} }");
	assert.equal(result.valid, true);
	assert.ok(result.warnings.length > 0);
});

test("DynamicScriptRunner executes template literals", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 5; return `count: ${x}`;");
	assert.equal(result.success, true);
	assert.equal(result.value, "count: 5");
});

test("DynamicScriptRunner executes destructuring", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const {a, b} = {a: 1, b: 2}; return a + b;");
	assert.equal(result.success, true);
	assert.equal(result.value, 3);
});

test("DynamicScriptRunner executes spread operator", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const a = [1, 2]; const b = [...a, 3]; return b;");
	assert.equal(result.success, true);
	assert.equal(JSON.stringify(result.value), JSON.stringify([1, 2, 3]));
});

test("DynamicScriptRunner executes arrow functions", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const fn = (x) => x * 2; return fn(5);");
	assert.equal(result.success, true);
	assert.equal(result.value, 10);
});

test("DynamicScriptRunner executes classes", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("class Test { constructor() { this.x = 1; } } return new Test().x;");
	assert.equal(result.success, true);
	assert.equal(result.value, 1);
});

test("DynamicScriptRunner executes Symbol", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return Symbol('test').toString();");
	assert.equal(result.success, true);
	assert.equal(result.value, "Symbol(test)");
});

test("DynamicScriptRunner executes TypedArray", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const buf = new Uint8Array([1, 2, 3]); return buf.length;");
	assert.equal(result.success, true);
	assert.equal(result.value, 3);
});

test("DynamicScriptRunner executes ArrayBuffer", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const buf = new ArrayBuffer(10); return buf.byteLength;");
	assert.equal(result.success, true);
	assert.equal(result.value, 10);
});

test("DynamicScriptRunner handles undefined and null", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return { undefined: undefined, null: null };");
	assert.equal(result.success, true);
	const value = result.value as Record<string, unknown>;
	assert.equal(value["undefined"], undefined);
	assert.equal(value["null"], null);
});

test("DynamicScriptRunner executes conditional expressions", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 5; return x > 3 ? 'yes' : 'no';");
	assert.equal(result.success, true);
	assert.equal(result.value, "yes");
});

test("DynamicScriptRunner executes switch statements", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("const x = 2; switch(x) { case 1: return 'one'; case 2: return 'two'; default: return 'other'; }");
	assert.equal(result.success, true);
	assert.equal(result.value, "two");
});

test("DynamicScriptRunner executes for loops", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("let sum = 0; for(let i = 1; i <= 5; i++) sum += i; return sum;");
	assert.equal(result.success, true);
	assert.equal(result.value, 15);
});

test("DynamicScriptRunner executes while loops", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("let i = 0; while(i < 3) i++; return i;");
	assert.equal(result.success, true);
	assert.equal(result.value, 3);
});

test("DynamicScriptRunner executes try-catch", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("try { throw1; } catch(e) { return 'caught'; }");
	assert.equal(result.success, true);
	assert.equal(result.value, "caught");
});

test("DynamicScriptRunner executes NaN and Infinity checks", () => {
	const runner = new DynamicScriptRunner();
	const result = runner.execute("return [isNaN(NaN), isFinite(Infinity), parseInt('abc')];");
	assert.equal(result.success, true);
	const value = result.value as unknown[];
	assert.equal(value[0], true); // isNaN(NaN)
	assert.equal(value[1], false); // isFinite(Infinity)
	assert.ok(Number.isNaN(value[2] as number)); // parseInt('abc')
});
