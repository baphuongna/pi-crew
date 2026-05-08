/**
 * Output Contract Eval Harness — three-arm evaluation.
 *
 * Measures format compliance, token efficiency, parse accuracy,
 * and compression impact for structured output contracts.
 *
 * Arms:
 * - __baseline__: Raw model output (verbose, no contract)
 * - __terse__: "Answer concisely" prompt
 * - contract: Structured output contract in system prompt
 *
 * Honest delta = contract vs terse (NOT contract vs baseline).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	validateWorkerOutput,
	parseReviewerFindings,
	parseExplorerResults,
	validateCompressionPreservation,
} from "../../src/runtime/output-validator.ts";
import { compressProse } from "../../src/runtime/prose-compressor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

interface ArmResult {
	arm: string;
	totalSamples: number;
	formatCompliance: number;
	structurePreservation: number;
	overallValid: number;
	avgTokens: number;
	parseAccuracy: number;
}

function evaluateArm(
	role: string,
	outputs: Array<{ text: string; expectedValid: boolean }>,
	armLabel: string,
): ArmResult {
	let formatOk = 0;
	let structureOk = 0;
	let overallOk = 0;
	let totalTokens = 0;
	let parseHits = 0;
	let parseTargets = 0;

	for (const output of outputs) {
		const v = validateWorkerOutput(role, output.text);
		if (v.formatMatch) formatOk++;
		if (v.structurePreserved) structureOk++;
		if (v.valid === output.expectedValid) overallOk++;
		totalTokens += estimateTokens(output.text);

		if ((role === "reviewer" || role === "security-reviewer") && output.expectedValid && output.text !== "No issues.") {
			parseTargets++;
			if (parseReviewerFindings(output.text).length > 0) parseHits++;
		}
		if (role === "explorer" && output.expectedValid && !output.text.startsWith("No match")) {
			parseTargets++;
			if (parseExplorerResults(output.text).length > 0) parseHits++;
		}
	}

	return {
		arm: armLabel,
		totalSamples: outputs.length,
		formatCompliance: Math.round((formatOk / outputs.length) * 100),
		structurePreservation: Math.round((structureOk / outputs.length) * 100),
		overallValid: Math.round((overallOk / outputs.length) * 100),
		avgTokens: Math.round(totalTokens / outputs.length),
		parseAccuracy: parseTargets > 0 ? Math.round((parseHits / parseTargets) * 100) : -1,
	};
}

// ---------------------------------------------------------------------------
// Explorer eval
// ---------------------------------------------------------------------------

describe("output-contract-eval: explorer", () => {
	const contractOutputs = [
		{ text: "src/auth.ts:42 — `validateToken` — JWT expiry check\nsrc/auth.ts:87 — `hashPassword` — bcrypt hash\nrefs: src/api.ts:15, src/api.ts:30\ntotals: 2 defs, 2 refs.", expectedValid: true },
		{ text: "No match.", expectedValid: true },
		{ text: "Defs:\n- src/utils.ts:10 — `debounce` — delay wrapper\nSites: src/search.ts:3\ntotals: 1 defs, 1 sites.", expectedValid: true },
	];
	const baselineOutputs = [
		{ text: "I'll help you find the definitions. After searching through the codebase, I found that the validateToken function is defined at line 42 in src/auth.ts. It handles JWT expiry checking.", expectedValid: false },
		{ text: "Found validateToken in src/auth.ts and hashPassword in the same file. Also referenced in api.ts.", expectedValid: false },
	];
	const terseOutputs = [
		{ text: "validateToken @ src/auth.ts:42, hashPassword @ src/auth.ts:87. Refs: api.ts:15, api.ts:30.", expectedValid: false },
	];

	it("contract arm: 100% format compliance", () => {
		const result = evaluateArm("explorer", contractOutputs, "contract");
		assert.equal(result.formatCompliance, 100, `Got ${result.formatCompliance}%`);
		assert.equal(result.overallValid, 100);
	});

	it("contract arm: parse accuracy >= 95%", () => {
		const result = evaluateArm("explorer", contractOutputs, "contract");
		assert.ok(result.parseAccuracy >= 95, `Parse accuracy: ${result.parseAccuracy}%`);
	});

	it("baseline arm: format compliance < 30%", () => {
		const result = evaluateArm("explorer", baselineOutputs, "__baseline__");
		assert.ok(result.formatCompliance < 30, `Got ${result.formatCompliance}%`);
	});

	it("contract arm saves >= 30% tokens vs baseline", () => {
		const contract = evaluateArm("explorer", contractOutputs, "contract");
		const baseline = evaluateArm("explorer", baselineOutputs, "__baseline__");
		const savings = Math.round(((baseline.avgTokens - contract.avgTokens) / baseline.avgTokens) * 100);
		assert.ok(savings >= 30, `Savings: ${savings}% (contract=${contract.avgTokens}, baseline=${baseline.avgTokens})`);
	});

	it("honest delta: contract beats terse", () => {
		const contract = evaluateArm("explorer", contractOutputs, "contract");
		const terse = evaluateArm("explorer", terseOutputs, "__terse__");
		assert.ok(contract.formatCompliance > terse.formatCompliance, `Contract ${contract.formatCompliance}% vs terse ${terse.formatCompliance}%`);
	});
});

// ---------------------------------------------------------------------------
// Executor eval
// ---------------------------------------------------------------------------

describe("output-contract-eval: executor", () => {
	const contractOutputs = [
		{ text: "src/auth.ts:42-48 — Fixed token expiry off-by-one.\nverified: re-read OK.", expectedValid: true },
		{ text: "too-big. split: 3 one-line tasks.", expectedValid: true },
		{ text: "needs-confirm. Changes billing logic in src/payment.ts:100-115.", expectedValid: true },
		{ text: "ambiguous. 3 possible targets match the description.", expectedValid: true },
	];
	const baselineOutputs = [
		{ text: "I fixed the token expiry bug by changing the comparison operator from < to <= on line 42 of src/auth.ts. The change is minimal and I've verified it works correctly.", expectedValid: false },
	];

	it("contract arm: 100% format compliance", () => {
		const result = evaluateArm("executor", contractOutputs, "contract");
		assert.equal(result.formatCompliance, 100);
	});

	it("baseline arm: format compliance < 20%", () => {
		const result = evaluateArm("executor", baselineOutputs, "__baseline__");
		assert.ok(result.formatCompliance < 20, `Got ${result.formatCompliance}%`);
	});

	it("contract saves >= 40% tokens vs baseline", () => {
		const contract = evaluateArm("executor", contractOutputs, "contract");
		const baseline = evaluateArm("executor", baselineOutputs, "__baseline__");
		const savings = Math.round(((baseline.avgTokens - contract.avgTokens) / baseline.avgTokens) * 100);
		assert.ok(savings >= 40, `Savings: ${savings}%`);
	});
});

// ---------------------------------------------------------------------------
// Reviewer eval
// ---------------------------------------------------------------------------

describe("output-contract-eval: reviewer", () => {
	const contractOutputs = [
		{ text: "src/auth.ts:42: 🔴 bug: token expiry uses < not <=. Fix: use <=.\nsrc/utils.ts:7: 🟡 risk: pool not closed on error. Fix: add try/finally.\ntotals: 1 bug, 1 risk.", expectedValid: true },
		{ text: "No issues.", expectedValid: true },
	];
	const baselineOutputs = [
		{ text: "I found a few issues in the code. The token expiry check on line 42 of auth.ts is using a less-than comparison instead of less-than-or-equal, which could cause tokens to be accepted one second later than intended.", expectedValid: false },
	];

	it("contract arm: 100% format compliance", () => {
		const result = evaluateArm("reviewer", contractOutputs, "contract");
		assert.equal(result.formatCompliance, 100);
	});

	it("contract arm: parse accuracy 100%", () => {
		const result = evaluateArm("reviewer", contractOutputs, "contract");
		assert.equal(result.parseAccuracy, 100, `Parse accuracy: ${result.parseAccuracy}%`);
	});

	it("baseline arm: format compliance = 0%", () => {
		const result = evaluateArm("reviewer", baselineOutputs, "__baseline__");
		assert.equal(result.formatCompliance, 0);
	});

	it("contract saves >= 50% tokens vs baseline", () => {
		const contract = evaluateArm("reviewer", contractOutputs, "contract");
		const baseline = evaluateArm("reviewer", baselineOutputs, "__baseline__");
		const savings = Math.round(((baseline.avgTokens - contract.avgTokens) / baseline.avgTokens) * 100);
		assert.ok(savings >= 50, `Savings: ${savings}%`);
	});
});

// ---------------------------------------------------------------------------
// Verifier eval
// ---------------------------------------------------------------------------

describe("output-contract-eval: verifier", () => {
	const contractOutputs = [
		{ text: "PASS: typecheck — tsc --noEmit clean.\nPASS: lint — biome check passed.\nPASS: tests — 1044/0/3 pass/fail/skipped.", expectedValid: true },
		{ text: "FAIL: test suite — 3 tests failed. Expected 0 failures.", expectedValid: true },
	];
	const baselineOutputs = [
		{ text: "I ran the verification commands and everything looks good. The TypeScript compiler reported no errors, the linter passed, and all 1044 tests passed successfully.", expectedValid: false },
	];

	it("contract arm: 100% format compliance", () => {
		const result = evaluateArm("verifier", contractOutputs, "contract");
		assert.equal(result.formatCompliance, 100);
	});

	it("baseline arm: format compliance = 0%", () => {
		const result = evaluateArm("verifier", baselineOutputs, "__baseline__");
		assert.equal(result.formatCompliance, 0);
	});
});

// ---------------------------------------------------------------------------
// Compression impact eval
// ---------------------------------------------------------------------------

describe("output-contract-eval: compression", () => {
	const samplesWithCode = [
		"## Implementation\n\nHere is the code:\n\n```typescript\nconst x: number = 42;\nconsole.log(x);\n```\n\nAnd a URL: https://example.com/api",
		"Use the `useState` hook with the `useEffect` dependency.\nVersion requires 18.2.0 or later.",
	];

	it("preserves code blocks after compression", () => {
		for (const sample of samplesWithCode) {
			const compressed = compressProse(sample);
			const issues = validateCompressionPreservation(sample, compressed.compressed);
			assert.equal(issues.length, 0, `Issues: ${issues.join(", ")}`);
		}
	});

	it("achieves >= 15% savings on verbose text", () => {
		const verbose = "I'll just basically help you fix the really very simple bug. Perhaps we could potentially use a different approach. Basically, just update the file and verify the changes.";
		const compressed = compressProse(verbose);
		assert.ok(compressed.savingsPercent >= 15, `Savings: ${compressed.savingsPercent}%`);
	});

	it("achieves >= 30% savings on baseline output vs contract", () => {
		const baseline = "I found a few issues in the code. The token expiry check on line 42 of auth.ts is using a less-than comparison instead of less-than-or-equal, which could cause tokens to be accepted one second later than intended. Also, the connection pool in utils.ts isn't properly closed when an error occurs.";
		const contract = "src/auth.ts:42: 🔴 bug: token expiry uses < not <=. Fix: use <=.\nsrc/utils.ts:7: 🟡 risk: pool not closed on error. Fix: add try/finally.";
		const baselineTokens = estimateTokens(baseline);
		const contractTokens = estimateTokens(contract);
		const savings = Math.round(((baselineTokens - contractTokens) / baselineTokens) * 100);
		assert.ok(savings >= 30, `Savings: ${savings}% (baseline=${baselineTokens}, contract=${contractTokens})`);
	});
});

// ---------------------------------------------------------------------------
// Regex lastIndex leak test
// ---------------------------------------------------------------------------

describe("output-contract-eval: regex safety", () => {
	it("validateWorkerOutput: no state leak across sequential calls", () => {
		// Call with explorer contract output, then call again — must not change result
		const v1 = validateWorkerOutput("explorer", "src/auth.ts:42 — `validateToken` — JWT check");
		const v2 = validateWorkerOutput("explorer", "src/auth.ts:42 — `validateToken` — JWT check");
		assert.equal(v1.formatMatch, v2.formatMatch);
		assert.equal(v1.valid, v2.valid);
	});

	it("validateCompressionPreservation: no state leak across calls", () => {
		const original = "```\ncode\n```\nURL: https://example.com";
		const compressed = "```\ncode\n```\nURL: https://example.com";
		const issues1 = validateCompressionPreservation(original, compressed);
		const issues2 = validateCompressionPreservation(original, compressed);
		assert.deepEqual(issues1, issues2);
	});
});
