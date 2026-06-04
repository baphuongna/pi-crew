import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowSandbox, normalizeCodeForValidation } from "../../src/runtime/sandbox.ts";

describe("C1: Sandbox constructor chain escape protection", () => {
	it("should block [].constructor.constructor('return process')() via forbidden pattern", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		// The exploit code that would bypass keyword-based validation without the constructor pattern
		assert.throws(
			() => sandbox.execute(`[].constructor.constructor("return process")()`),
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				// Should be caught by the /\bconstructor\b/ forbidden pattern
				return msg.includes("constructor") || msg.includes("Forbidden pattern");
			},
		);
	});

	it("should block constructor keyword in source code", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		assert.throws(
			() => sandbox.execute(`const x = [].constructor;`),
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				return msg.includes("constructor") || msg.includes("Forbidden pattern");
			},
		);
	});

	it("should block ({}).constructor.constructor escape", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		assert.throws(
			() => sandbox.execute(`({}).constructor.constructor("return globalThis")()`),
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				return msg.includes("constructor") || msg.includes("Forbidden pattern");
			},
		);
	});

	it("should still allow normal sandboxed code execution", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		const result = sandbox.execute(`return 1 + 1`);
		assert.equal(result, 2);
	});

	it("should block Function constructor via unicode escape", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		// Unicode-escaped constructor access: \u0063 = 'c', \u006f = 'o'
		assert.throws(
			() => sandbox.execute(`[][\u0063\u006fnstructor][\u0063\u006fnstructor]("return process")()`),
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				return msg.includes("constructor") || msg.includes("Forbidden pattern");
			},
		);
	});

	it("normalizeCodeForValidation decodes unicode escapes", () => {
		const normalized = normalizeCodeForValidation(`\\u0063onstructor`);
		assert.ok(normalized.includes("constructor"), `Expected normalized to contain 'constructor', got: ${normalized}`);
	});

	it("should block constructor access on Object literals", () => {
		const sandbox = new WorkflowSandbox({ timeout: 5000 });
		assert.throws(
			() => sandbox.execute(`var F = ({}).constructor; F("return process")()`),
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				return msg.includes("constructor") || msg.includes("Forbidden pattern");
			},
		);
	});
});
