/**
 * Complementary tests for src/extension/plan-orchestrate.ts
 * Focuses on edge cases: implicit tag detection, buildChainData, empty chains,
 * prompt truncation in overview, and error handling.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildAgentChain,
	buildChainData,
	formatPlanOverview,
	orchestratePlan,
	parsePlanDocument,
	parsePlanDocumentSimple,
	TAG_TO_CHAIN,
} from "../../../../src/extension/plan-orchestrate.ts";

function withTempFile(content: string, fn: (filePath: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orch-cov-"));
	const filePath = path.join(dir, "plan.md");
	fs.writeFileSync(filePath, content);
	try {
		fn(filePath);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ─── parsePlanDocument edge cases ────────────────────────────────────────────

describe("parsePlanDocument skips empty sections", () => {
	it("returns no steps when tag has no content after it", () => {
		withTempFile("# Phase\n<!-- tag: design -->\n\n\n", (filePath) => {
			const steps = parsePlanDocument(filePath);
			assert.equal(steps.length, 0, "empty section after tag should be skipped");
		});
	});
});

describe("parsePlanDocument handles plan with only comments and whitespace", () => {
	it("returns empty for file with tag but only comment lines", () => {
		withTempFile("<!-- tag: design -->\n<!-- another comment -->\n", (filePath) => {
			const steps = parsePlanDocument(filePath);
			assert.equal(steps.length, 0);
		});
	});
});

describe("parsePlanDocument assigns correct step IDs for multiple tags", () => {
	it("pads step number to 2 digits", () => {
		const content = [
			"<!-- tag: design -->",
			"Design step.",
			"<!-- tag: impl -->",
			"Impl step.",
			"<!-- tag: test -->",
			"Test step.",
		].join("\n");
		withTempFile(content, (filePath) => {
			const steps = parsePlanDocument(filePath);
			assert.equal(steps[0].stepId, "step-01-design");
			assert.equal(steps[1].stepId, "step-02-impl");
			assert.equal(steps[2].stepId, "step-03-test");
		});
	});
});

// ─── parsePlanDocumentSimple implicit tag detection ──────────────────────────

describe("parsePlanDocumentSimple detects implicit design tag", () => {
	it("detects 'design' keyword and returns a step", () => {
		withTempFile("We need to design the system architecture carefully.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "design");
		});
	});
});

describe("parsePlanDocumentSimple detects implicit impl tag", () => {
	it("detects 'implement' keyword", () => {
		withTempFile("Please implement the feature.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "impl");
		});
	});
});

describe("parsePlanDocumentSimple detects implicit security tag", () => {
	it("detects 'security' keyword", () => {
		withTempFile("Review the security of this module.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "security");
		});
	});
});

describe("parsePlanDocumentSimple detects implicit build tag", () => {
	it("detects 'build' keyword", () => {
		withTempFile("Fix the build errors in the project.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "build");
		});
	});
});

describe("parsePlanDocumentSimple detects implicit test tag", () => {
	it("detects 'test' keyword", () => {
		withTempFile("Add test coverage for utils.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "test");
		});
	});
});

describe("parsePlanDocumentSimple detects implicit review tag", () => {
	it("detects 'review' keyword", () => {
		withTempFile("Please review the pull request.", (filePath) => {
			const steps = parsePlanDocumentSimple(filePath);
			assert.equal(steps.length, 1);
			assert.equal(steps[0].tag, "review");
		});
	});
});

// ─── buildAgentChain with empty chain ────────────────────────────────────────

describe("buildAgentChain handles empty chain", () => {
	it("generates command with empty agent list", () => {
		const steps = [{ stepId: "s1", tag: "unknown", chain: [], prompt: "Do something" }];
		const commands = buildAgentChain(steps);
		assert.equal(commands.length, 1);
		assert.equal(commands[0], "team action='run' agent='' goal='Do something'");
	});
});

// ─── buildChainData ──────────────────────────────────────────────────────────

describe("buildChainData returns structured data", () => {
	it("includes step and commands for each entry", () => {
		const steps = [
			{
				stepId: "s1",
				tag: "design",
				chain: ["planner"],
				prompt: "Plan it",
			},
			{ stepId: "s2", tag: "impl", chain: ["coder"], prompt: "Code it" },
		];
		const data = buildChainData(steps);
		assert.equal(data.length, 2);
		assert.equal(data[0].step.stepId, "s1");
		assert.equal(data[0].commands.length, 1);
		assert.equal(data[1].step.stepId, "s2");
	});
});

// ─── formatPlanOverview truncation ───────────────────────────────────────────

describe("formatPlanOverview truncates long prompts", () => {
	it("shows ellipsis for prompts longer than 60 chars", () => {
		const longPrompt = "A".repeat(100);
		const content = `# Phase\n<!-- tag: design -->\n${longPrompt}\n`;
		withTempFile(content, (filePath) => {
			const overview = formatPlanOverview(filePath);
			assert.ok(overview.includes("..."));
			assert.ok(!overview.includes("A".repeat(100)), "should truncate long prompt");
		});
	});
});

// ─── orchestratePlan fallback ────────────────────────────────────────────────

describe("orchestratePlan falls back to simple parser", () => {
	it("parses plan with implicit tags when no explicit tags found", async () => {
		withTempFile("Please implement the feature carefully.", async (filePath) => {
			const result = await orchestratePlan({ planPath: filePath });
			assert.ok(result.steps.length >= 1);
			assert.equal(result.steps[0].tag, "impl");
		});
	});
});

// ─── TAG_TO_CHAIN completeness ───────────────────────────────────────────────

describe("TAG_TO_CHAIN has all expected tags", () => {
	it("contains design, impl, security, build, test, review", () => {
		const expectedTags = ["design", "impl", "security", "build", "test", "review"];
		for (const tag of expectedTags) {
			assert.ok(tag in TAG_TO_CHAIN, `missing tag: ${tag}`);
			assert.ok(Array.isArray(TAG_TO_CHAIN[tag]), `tag ${tag} should map to array`);
		}
	});
});
