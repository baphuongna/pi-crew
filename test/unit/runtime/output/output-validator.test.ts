import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isStderrOnlyResult,
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

	describe("isStderrOnlyResult (bug-026 sub-issue A)", () => {
		const evidenceArtifact = [
			"[oc-go] hidden 40 model(s) from /model by visibility config",
			"[pi-qwen-mm] [core] [stderr] /home/bom/.cache/uv/archive-v0/x/pydantic_settings/sources/utils.py:47: IncompleteFieldDefinitionWarning: Field 'lifespan' has an incomplete definition.",
			"[pi-qwen-mm] [core] [stderr]   warnings.warn(",
			"[pi-qwen-mm] [core] [stderr] 2026-08-15 21:49:02,986 WARNING system tool missing — install: apt install blender",
			"[pi-qwen-mm] [core] [mcp] handshake complete with uvx",
			"[pi-qwen-mm] [core] [stderr] 2026-08-15 21:49:02,994 INFO Processing request of type ListToolsRequest",
			"[pi-qwen-mm] registered 7 tool(s) from 1 capability(ies)",
			"[pi-qwen-mm] disposed 1 MCP client(s)",
		].join("\n");

		it("matches the real corrupted evidence artifact (all log-noise lines)", () => {
			assert.equal(isStderrOnlyResult(evidenceArtifact), true);
		});

		it("matches bracket-tag lines without sub-tags", () => {
			assert.equal(isStderrOnlyResult("[oc-go] hidden 40 model(s)"), true);
			assert.equal(isStderrOnlyResult("[pi-qwen-mm] disposed 1 MCP client(s)"), true);
		});

		it("matches a standalone python warnings.warn line", () => {
			assert.equal(isStderrOnlyResult("  warnings.warn("), true);
			assert.equal(
				isStderrOnlyResult("/pkg/mod.py:47: DeprecationWarning: x\n  warnings.warn("),
				false,
				"bare warning header line is not in the noise set",
			);
		});

		it("matches a standalone timestamped logging line", () => {
			assert.equal(isStderrOnlyResult("2026-08-15 21:49:02,986 WARNING system tool missing"), true);
			assert.equal(isStderrOnlyResult("2026-08-15T21:49:02.986Z INFO request processed"), true);
		});

		it("ignores blank lines between noise lines", () => {
			assert.equal(isStderrOnlyResult("[oc-go] hidden 40 model(s)\n\n[pi-qwen-mm] disposed 1 MCP client(s)\n"), true);
		});

		it("returns false for empty / whitespace-only input (emptiness is the caller's check)", () => {
			assert.equal(isStderrOnlyResult(""), false);
			assert.equal(isStderrOnlyResult("   \n \n"), false);
			assert.equal(isStderrOnlyResult("(no output)"), false);
		});

		it("returns false for legitimate short results", () => {
			assert.equal(isStderrOnlyResult("OK done."), false);
			assert.equal(isStderrOnlyResult("No match."), false);
			assert.equal(isStderrOnlyResult("No issues."), false);
			assert.equal(isStderrOnlyResult("PASS: typecheck — tsc --noEmit clean."), false);
		});

		it("returns false for markdown handoffs and prose", () => {
			assert.equal(isStderrOnlyResult("## Handoff\n\n### Summary\n- did X\n\n## Follow-ups\n- item"), false);
			assert.equal(isStderrOnlyResult("# Result\n\nSome prose paragraphs with `inline code`."), false);
			assert.equal(isStderrOnlyResult("lorem ipsum dolor sit amet"), false);
		});

		it("returns false for explorer file:line result lines", () => {
			assert.equal(isStderrOnlyResult("src/auth.ts:42 — `validateToken` — JWT expiry check"), false);
		});

		it("returns false when a single prose line mixes with log noise", () => {
			assert.equal(isStderrOnlyResult("[pi-qwen-mm] disposed 1 MCP client(s)\nFound 3 sites, see above."), false);
		});

		it("returns false for capitalized bracketed prose (bracket-tag must be a lowercase identifier)", () => {
			assert.equal(isStderrOnlyResult("[Note] this is important context for downstream tasks"), false);
			assert.equal(isStderrOnlyResult("[TODO] finish the remaining sweep"), false);
		});

		it("returns false for markdown lines that merely contain brackets/links", () => {
			assert.equal(isStderrOnlyResult("- see [docs](https://example.com) for details"), false);
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
