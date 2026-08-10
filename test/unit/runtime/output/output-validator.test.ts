import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseExplorerResults,
	parseReviewerFindings,
	validateCompressionPreservation,
	validateWorkerOutput,
} from "../../../../src/runtime/output/output-validator.ts";

describe("output-validator", () => {
	describe("validateWorkerOutput", () => {
		it("rejects empty output", () => {
			const result = validateWorkerOutput("executor", "");
			assert.equal(result.valid, false);
			assert.equal(result.formatMatch, false);
		});

		it("rejects whitespace-only output", () => {
			const result = validateWorkerOutput("executor", "   \n  ");
			assert.equal(result.valid, false);
		});

		it("accepts valid executor output", () => {
			const output = "src/main.ts:42-48 — Fixed token validation.\nverified: re-read OK.";
			const result = validateWorkerOutput("executor", output);
			assert.equal(result.formatMatch, true);
			assert.equal(result.valid, true);
		});

		it("accepts executor refusal tokens", () => {
			const result = validateWorkerOutput("executor", "too-big. split: 3 one-line tasks.");
			assert.equal(result.formatMatch, true);
		});

		it("accepts valid explorer output", () => {
			const output = "Defs:\n- src/auth.ts:42 — `validateToken` — JWT expiry check\n2 defs.";
			const result = validateWorkerOutput("explorer", output);
			assert.equal(result.formatMatch, true);
		});

		it("accepts 'No match.' from explorer", () => {
			const result = validateWorkerOutput("explorer", "No match.");
			assert.equal(result.formatMatch, true);
		});

		it("accepts valid reviewer output", () => {
			const output = "src/auth.ts:42: 🔴 bug: token expiry uses < not <=. Fix: use <=.";
			const result = validateWorkerOutput("reviewer", output);
			assert.equal(result.formatMatch, true);
		});

		it("accepts 'No issues.' from reviewer", () => {
			const result = validateWorkerOutput("reviewer", "No issues.");
			assert.equal(result.formatMatch, true);
		});

		it("accepts valid verifier output", () => {
			const result = validateWorkerOutput("verifier", "PASS: typecheck — tsc --noEmit clean.");
			assert.equal(result.formatMatch, true);
		});

		it("accepts FAIL from verifier", () => {
			const result = validateWorkerOutput("verifier", "FAIL: test suite — 3 tests failed. Expected 0 failures.");
			assert.equal(result.formatMatch, true);
		});

		it("accepts any output for roles without contract", () => {
			const result = validateWorkerOutput("planner", "This is free-form planner output.");
			assert.equal(result.valid, true);
		});

		it("detects unclosed code block", () => {
			const output = "```typescript\nconst x = 1;";
			const result = validateWorkerOutput("planner", output);
			assert.equal(result.structurePreserved, false);
			assert.ok(result.issues.some((i) => i.includes("Unclosed")));
		});

		it("detects URL with trailing punctuation", () => {
			const output = "See https://example.com/api.,";
			const result = validateWorkerOutput("planner", output);
			assert.equal(result.structurePreserved, false);
		});
	});

	describe("accepts markdown handoff output", () => {
		const handoff = "## Handoff\n\n### Summary\n- did X\n\n## Follow-ups\n- item";

		for (const role of ["explorer", "executor", "reviewer", "security-reviewer", "verifier"]) {
			it(`accepts markdown handoff for ${role}`, () => {
				const result = validateWorkerOutput(role, handoff);
				assert.equal(result.formatMatch, true, `formatMatch should be true for ${role}`);
				assert.equal(result.valid, true, `valid should be true for ${role}`);
			});
		}

		it("rejects garbage prose without markdown structure", () => {
			// Free prose with no markdown marker must still fail for roles
			// whose strict pattern also fails (e.g. reviewer).
			const result = validateWorkerOutput("reviewer", "lorem ipsum dolor sit amet consectetur");
			assert.equal(result.formatMatch, false);
		});
	});

	describe("parseReviewerFindings", () => {
		it("parses multiple findings", () => {
			const output = [
				"src/auth.ts:42: 🔴 bug: token expiry off-by-one.",
				"src/utils.ts:7: 🟡 risk: pool not closed on error.",
				"src/main.ts:100: 🔵 nit: inconsistent naming.",
			].join("\n");
			const findings = parseReviewerFindings(output);
			assert.equal(findings.length, 3);
			assert.equal(findings[0].file, "src/auth.ts");
			assert.equal(findings[0].line, 42);
			assert.equal(findings[0].severity, "bug");
			assert.equal(findings[1].severity, "risk");
			assert.equal(findings[2].severity, "nit");
		});

		it("returns empty for non-matching output", () => {
			const findings = parseReviewerFindings("No issues.");
			assert.equal(findings.length, 0);
		});
	});

	describe("parseExplorerResults", () => {
		it("parses explorer results with symbols", () => {
			const output = "src/auth.ts:42 — `validateToken` — JWT expiry check\nsrc/utils.ts:10 — `hashPassword` — bcrypt hash";
			const results = parseExplorerResults(output);
			assert.equal(results.length, 2);
			assert.equal(results[0].file, "src/auth.ts");
			assert.equal(results[0].symbol, "validateToken");
			assert.equal(results[0].note, "JWT expiry check");
		});

		it("returns empty for No match.", () => {
			const results = parseExplorerResults("No match.");
			assert.equal(results.length, 0);
		});
	});

	describe("validateCompressionPreservation", () => {
		it("passes when structure is preserved", () => {
			const original = "## Title\n\nCheck the `code` and https://example.com.\n\n```\nconst x = 1;\n```\n";
			const issues = validateCompressionPreservation(original, original);
			assert.equal(issues.length, 0);
		});

		it("detects lost code block", () => {
			const original = "Text\n```\nconst x = 1;\n```\n";
			const compressed = "Text\n";
			const issues = validateCompressionPreservation(original, compressed);
			assert.ok(issues.some((i) => i.includes("Code block count")));
		});

		it("detects lost URL", () => {
			const original = "See https://example.com/api for docs.";
			const compressed = "See for docs.";
			const issues = validateCompressionPreservation(original, compressed);
			assert.ok(issues.some((i) => i.includes("URL lost")));
		});

		it("detects lost inline code", () => {
			const original = "Use the `useState` hook.";
			const compressed = "Use the hook.";
			const issues = validateCompressionPreservation(original, compressed);
			assert.ok(issues.some((i) => i.includes("Inline code lost")));
		});

		it("detects lost heading", () => {
			const original = "## Title\n## Subtitle\nContent.";
			const compressed = "## Title\nContent.";
			const issues = validateCompressionPreservation(original, compressed);
			assert.ok(issues.some((i) => i.includes("Heading count")));
		});
	});
});
