/**
 * Unit tests for deterministic-ast.ts (round-13 P0-2).
 *
 * Verifies that:
 *   - Date.now() / Math.random() / new Date() are rejected at script-load time
 *   - String literals / template literals / comments mentioning those names are accepted
 *   - Other Date.* and Math.* methods are accepted (only `now` and `random` are blocked)
 *   - Nested expressions and computed properties are walked correctly
 *   - Parse errors are silently deferred to jiti (no double-report)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertDeterministicScript, DeterminismError, isDeterminismCheckEnabled } from "../../src/runtime/deterministic-ast.ts";

test("rejects Date.now() call", () => {
	assert.throws(() => assertDeterministicScript(`const t = Date.now();`), DeterminismError);
});

test("rejects Math.random() call", () => {
	assert.throws(() => assertDeterministicScript(`const r = Math.random();`), DeterminismError);
});

test("rejects new Date() expression", () => {
	assert.throws(() => assertDeterministicScript(`const d = new Date();`), DeterminismError);
});

test("rejects new Date() with arguments", () => {
	assert.throws(() => assertDeterministicScript(`const d = new Date(2024, 0, 1);`), DeterminismError);
});

test("accepts Date.now() as a string literal", () => {
	assertDeterministicScript(`const label = "Date.now() is forbidden";`);
});

test("accepts Math.random in a template literal", () => {
	assertDeterministicScript(`const label = ` + "`Math.random would be nice`" + `;`);
});

test("accepts comments mentioning Date.now", () => {
	assertDeterministicScript(`// We don't call Date.now() here.\nconst x = 1;`);
});

test("accepts block comments mentioning Math.random", () => {
	assertDeterministicScript(`/* Math.random() is blocked at runtime */\nconst x = 1;`);
});

test("accepts Date.parse() (only now is blocked)", () => {
	assertDeterministicScript(`const ts = Date.parse("2024-01-01");`);
});

test("accepts Date.UTC() (only now is blocked)", () => {
	assertDeterministicScript(`const ts = Date.UTC(2024, 0, 1);`);
});

test("accepts Math.floor() (only random is blocked)", () => {
	assertDeterministicScript(`const r = Math.floor(3.14);`);
});

test("accepts Math.max/min/abs/ceil/round (only random is blocked)", () => {
	assertDeterministicScript(`
const a = Math.max(1, 2);
const b = Math.min(1, 2);
const c = Math.abs(-1);
const d = Math.ceil(3.14);
const e = Math.round(3.5);
`);
});

test("walks nested Date.now() inside an arrow function", () => {
	assert.throws(() => assertDeterministicScript(`
const f = () => {
  return Date.now();
};
`), DeterminismError);
});

test("walks Date.now() inside a try/catch", () => {
	assert.throws(() => assertDeterministicScript(`
try {
  const t = Date.now();
} catch (e) {
  console.error(e);
}
`), DeterminismError);
});

test("walks Date.now() inside an if block", () => {
	assert.throws(() => assertDeterministicScript(`
if (cond) {
  const t = Date.now();
}
`), DeterminismError);
});

test("rejects Math.random() inside a function declaration", () => {
	assert.throws(() => assertDeterministicScript(`
function roll() {
  return Math.random();
}
`), DeterminismError);
});

test("accepts Date.now assigned via destructuring rename", () => {
	// `[now]` would still be a CallExpression — we test that the property name
	// is checked regardless of how the result is bound.
	assert.throws(() => assertDeterministicScript(`
const [now] = [Date.now()];
`), DeterminismError);
});

test("accepts nested Math.max with no .random", () => {
	assertDeterministicScript(`
const r = Math.max(1, Math.min(2, Math.abs(-3)));
`);
});

test("parses TypeScript async/await without error", () => {
	assertDeterministicScript(`
export default async function run(ctx) {
  const t = await ctx.agent({ prompt: "hello" });
  ctx.setResult("/tmp/r.md");
}
`);
});

test("returns silently on parse error (delegated to jiti)", () => {
	// The script has a syntax error (missing closing brace). Our walker should
	// NOT throw DeterminismError — instead it returns silently and jiti
	// produces a clearer parse error downstream.
	assert.doesNotThrow(() => assertDeterministicScript(`const x = {a: 1,`));
});

test("accepts scripts that do not call any non-deterministic APIs", () => {
	assertDeterministicScript(`
export default async function run(ctx) {
  const r = await ctx.agent({ prompt: "hi" });
  ctx.setResult("/tmp/r.md");
}
`);
});

test("accepts deterministic function from crypto.randomBytes (not blocked)", () => {
	// We only block Date.now/Math.random/new Date. Other randomness sources
	// are permitted by policy — workflows that need randomness must import
	// crypto.randomBytes explicitly. (PI_CREW_DWF_SKIP_DETERMINISM_CHECK can
	// be set to disable even these guards.)
	assertDeterministicScript(`
import { randomBytes } from "node:crypto";
const r = randomBytes(16);
`);
});

test("isDeterminismCheckEnabled: defaults to true", () => {
	const saved = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	try {
		delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		assert.equal(isDeterminismCheckEnabled(), true);
	} finally {
		if (saved !== undefined) process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = saved;
	}
});

test("isDeterminismCheckEnabled: returns false when env=1", () => {
	const saved = process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
	try {
		process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = "1";
		assert.equal(isDeterminismCheckEnabled(), false);
	} finally {
		if (saved === undefined) delete process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK;
		else process.env.PI_CREW_DWF_SKIP_DETERMINISM_CHECK = saved;
	}
});

test("accepts Date.now as property name in an object literal", () => {
	// { now: Date.now() } is rejected — we still detect the call.
	assert.throws(() => assertDeterministicScript(`
const obj = { now: Date.now() };
`), DeterminismError);
});

test("accepts Date.now as a property KEY (computed string literal)", () => {
	assertDeterministicScript(`
const key = "now";
const obj = { [key]: 1 };
`);
});

test("rejects Date.now via member-expression bracket access with string literal", () => {
	// Date["now"]() is detected via staticStringOf resolving the bracket
	// property to the string "now". This is the correct security behavior:
	// we want to block all equivalent forms of Date.now().
	assert.throws(() => assertDeterministicScript(`
const t = Date["now"]();
`), DeterminismError);
});