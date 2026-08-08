/**
 * Scratchpad spike — transform unit tests (pure, no subprocess).
 *
 * Proves pattern 04 (transform) + 05 (incremental bindings) on the Node port:
 * TypeScript is stripped, top-level declarations become assignments at their
 * statement site (so bindings reach the namespace even when a later statement
 * throws), and a trailing expression is captured as the cell result. The
 * "no DCE" assertion is load-bearing — esbuild's transform must NOT drop the
 * side-effect-free trailing expression the result capture depends on.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { transformCell } from "../../../src/runtime/scratchpad/transform.ts";

test("strips types and converts a const declaration to an assignment", () => {
	const out = transformCell("const data:[number,number]=[1,2]; data[0]+data[1]");
	assert.deepEqual(out.declaredNames, ["data"]);
	assert.match(out.body, /data = \[1, ?2\];/);
	assert.match(out.body, /setResult\(\(data\[0\] \+ data\[1\]\)\)/);
});

test("trailing expression is captured (no dead-code elimination)", () => {
	// A side-effect-free trailing expression is exactly what esbuild-style DCE
	// would drop; the cell result depends on it surviving.
	const out = transformCell("const x=1; x+1");
	assert.match(out.body, /x = 1;/);
	assert.match(out.body, /setResult\(\(x \+ 1\)\)/);
});

test("let without an initializer binds undefined at its statement site", () => {
	const out = transformCell("let y;");
	assert.match(out.body, /y = undefined;/);
	assert.deepEqual(out.declaredNames, ["y"]);
});

test("destructuring patterns collect their names", () => {
	const out = transformCell("const {a, b} = obj;");
	assert.deepEqual(out.declaredNames, ["a", "b"]);
	assert.match(out.body, /\(.*a.*b.*= obj\)/);
});

test("function declarations become named assignments (self-reference kept)", () => {
	const out = transformCell("function helper(x){ return x*2; }");
	assert.deepEqual(out.declaredNames, ["helper"]);
	assert.match(out.body, /helper = function helper/);
});

test("export statements are rejected", () => {
	assert.throws(() => transformCell("export const x = 1;"), SyntaxError);
	assert.throws(() => transformCell("export default 42;"), SyntaxError);
	assert.throws(() => transformCell("export * from './m.ts';"), SyntaxError);
});

test("a custom ctx name is honoured", () => {
	const out = transformCell("1 + 1", { ctxName: "__myCtx" });
	assert.match(out.body, /__myCtx\.setResult\(\(1 \+ 1\)\)/);
});
