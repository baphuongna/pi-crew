/**
 * Tests for plan-orchestrate.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildAgentChain,
	buildChainData,
	formatPlanOverview,
	orchestratePlan,
	parsePlanDocument,
	parsePlanDocumentSimple,
	TAG_TO_CHAIN,
} from "../../../../src/extension/plan-orchestrate.ts";

// ─── TAG_TO_CHAIN ────────────────────────────────────────────────────────────

test("TAG_TO_CHAIN maps all expected tags to agent chains", () => {
	assert.deepStrictEqual(TAG_TO_CHAIN.design, ["planner", "architect"]);
	assert.deepStrictEqual(TAG_TO_CHAIN.impl, ["tdd-guide", "lang-reviewer"]);
	assert.deepStrictEqual(TAG_TO_CHAIN.security, ["security-reviewer", "lang-reviewer"]);
	assert.deepStrictEqual(TAG_TO_CHAIN.build, ["build-error-resolver"]);
	assert.deepStrictEqual(TAG_TO_CHAIN.test, ["test-engineer", "verifier"]);
	assert.deepStrictEqual(TAG_TO_CHAIN.review, ["reviewer"]);
});

// ─── parsePlanDocument ────────────────────────────────────────────────────────

test("parsePlanDocument parses tagged sections from a plan document", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan.md");
	fs.writeFileSync(
		tempFile,
		`# Design Phase
<!-- tag: design -->
Design the authentication system with OAuth2 and JWT tokens.

# Implementation
<!-- tag: impl -->
Implement the JWT authentication flow with refresh tokens.

# Testing
<!-- tag: test -->
Write unit tests for the auth middleware.
`,
	);

	const steps = parsePlanDocument(tempFile);

	assert.strictEqual(steps.length, 3);
	assert.strictEqual(steps[0].tag, "design");
	assert.deepStrictEqual(steps[0].chain, ["planner", "architect"]);
	assert.strictEqual(steps[0].stepId, "step-01-design");
	assert.strictEqual(steps[0].prompt, "Design the authentication system with OAuth2 and JWT tokens.");
	assert.strictEqual(steps[0].heading, "Design Phase");

	assert.strictEqual(steps[1].tag, "impl");
	assert.deepStrictEqual(steps[1].chain, ["tdd-guide", "lang-reviewer"]);
	assert.strictEqual(steps[1].stepId, "step-02-impl");

	assert.strictEqual(steps[2].tag, "test");
	assert.deepStrictEqual(steps[2].chain, ["test-engineer", "verifier"]);
	assert.strictEqual(steps[2].stepId, "step-03-test");

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parsePlanDocument handles multiple sections with same tag", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan2.md");
	fs.writeFileSync(
		tempFile,
		`# First Design
<!-- tag: design -->
First design section.

# Second Design
<!-- tag: design -->
Second design section.
`,
	);

	const steps = parsePlanDocument(tempFile);

	assert.strictEqual(steps.length, 2);
	assert.strictEqual(steps[0].stepId, "step-01-design");
	assert.strictEqual(steps[1].stepId, "step-02-design");

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parsePlanDocument throws when file not found", () => {
	assert.throws(() => parsePlanDocument("/nonexistent/plan.md"), /Plan document not found/);
});

test("parsePlanDocument handles unknown tags gracefully", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan3.md");
	fs.writeFileSync(
		tempFile,
		`# Unknown Tag Section
<!-- tag: unknown -->
Content with unknown tag.
`,
	);

	const steps = parsePlanDocument(tempFile);

	assert.strictEqual(steps.length, 1);
	assert.strictEqual(steps[0].tag, "unknown");
	assert.deepStrictEqual(steps[0].chain, []);

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parsePlanDocument handles multiline prompts", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan4.md");
	fs.writeFileSync(
		tempFile,
		`# Complex Design
<!-- tag: design -->
First paragraph of the design goal.
Second paragraph with more details.
Third paragraph for completeness.
`,
	);

	const steps = parsePlanDocument(tempFile);

	assert.strictEqual(steps.length, 1);
	assert.ok(steps[0].prompt.includes("First paragraph"));
	assert.ok(steps[0].prompt.includes("Second paragraph"));
	assert.ok(steps[0].prompt.includes("Third paragraph"));

	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── parsePlanDocumentSimple ─────────────────────────────────────────────────

test("parsePlanDocumentSimple parses sections using simple tag-based splitting", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan-simple.md");
	fs.writeFileSync(
		tempFile,
		`Some intro text.

<!-- tag: design -->
Design the system architecture.

<!-- tag: impl -->
Implement the core features.

<!-- tag: review -->
Review the implementation.
`,
	);

	const steps = parsePlanDocumentSimple(tempFile);

	assert.strictEqual(steps.length, 3);
	assert.strictEqual(steps[0].tag, "design");
	assert.strictEqual(steps[1].tag, "impl");
	assert.strictEqual(steps[2].tag, "review");

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parsePlanDocumentSimple handles sections with heading before tag", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan-simple2.md");
	fs.writeFileSync(
		tempFile,
		`# Implementation Phase
<!-- tag: impl -->
Write the code here.
`,
	);

	const steps = parsePlanDocumentSimple(tempFile);

	assert.strictEqual(steps.length, 1);
	assert.strictEqual(steps[0].tag, "impl");
	assert.strictEqual(steps[0].heading, "Implementation Phase");

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("parsePlanDocumentSimple returns empty array for plan with no tags", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "plan-empty.md");
	fs.writeFileSync(tempFile, "No tagged sections in this plan.");

	const steps = parsePlanDocumentSimple(tempFile);

	assert.strictEqual(steps.length, 0);

	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── buildAgentChain ─────────────────────────────────────────────────────────

test("buildAgentChain builds command strings for steps", () => {
	const steps = [
		{
			stepId: "step-01-design",
			tag: "design",
			chain: ["planner", "architect"],
			prompt: "Design the auth system",
		},
		{
			stepId: "step-02-impl",
			tag: "impl",
			chain: ["tdd-guide", "lang-reviewer"],
			prompt: "Implement JWT auth",
		},
	];

	const commands = buildAgentChain(steps);

	assert.strictEqual(commands.length, 2);
	assert.strictEqual(commands[0], "team action='run' agent='planner,architect' goal='Design the auth system'");
	assert.strictEqual(commands[1], "team action='run' agent='tdd-guide,lang-reviewer' goal='Implement JWT auth'");
});

test("buildAgentChain escapes single quotes in prompts", () => {
	const steps = [
		{
			stepId: "step-01-design",
			tag: "design",
			chain: ["planner"],
			prompt: "Design the system's architecture",
		},
	];

	const commands = buildAgentChain(steps);

	assert.strictEqual(commands[0], "team action='run' agent='planner' goal='Design the system'\\''s architecture'");
});

// ─── buildChainData ──────────────────────────────────────────────────────────

test("buildChainData returns structured data with commands", () => {
	const steps = [
		{
			stepId: "step-01-design",
			tag: "design",
			chain: ["planner"],
			prompt: "Design the system",
		},
	];

	const chainData = buildChainData(steps);

	assert.strictEqual(chainData.length, 1);
	assert.strictEqual(chainData[0].step, steps[0]);
	assert.strictEqual(chainData[0].commands.length, 1);
});

// ─── formatPlanOverview ─────────────────────────────────────────────────────

test("formatPlanOverview formats overview with step count and breakdown", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "overview-plan.md");
	fs.writeFileSync(
		tempFile,
		`# Design
<!-- tag: design -->
Design the system.

# Implementation
<!-- tag: impl -->
Implement the feature.
`,
	);

	const overview = formatPlanOverview(tempFile);

	assert.ok(overview.includes("Plan Orchestration: 2 step(s)"));
	assert.ok(overview.includes("design: 1 step(s)"));
	assert.ok(overview.includes("impl: 1 step(s)"));
	assert.ok(overview.includes("step-01-design"));

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("formatPlanOverview indicates when no tags found", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "no-tags.md");
	fs.writeFileSync(tempFile, "No tagged sections here.");

	const overview = formatPlanOverview(tempFile);

	assert.ok(overview.includes("No tagged sections"));

	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── orchestratePlan ─────────────────────────────────────────────────────────

test("orchestratePlan returns steps, chain, and overview", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "orchestrate-plan.md");
	fs.writeFileSync(
		tempFile,
		`# Security Review
<!-- tag: security -->
Review the authentication implementation for vulnerabilities.
`,
	);

	const result = await orchestratePlan({ planPath: tempFile });

	assert.strictEqual(result.steps.length, 1);
	assert.strictEqual(result.steps[0].tag, "security");
	assert.strictEqual(result.chain.length, 1);
	assert.ok(result.chain[0].includes("security-reviewer"));
	assert.ok(result.overview.includes("Security Review"));

	fs.rmSync(tempDir, { recursive: true, force: true });
});

test("orchestratePlan throws when no tags found", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-orchestrate-"));
	const tempFile = path.join(tempDir, "no-tags-orchestrate.md");
	fs.writeFileSync(tempFile, "Plain content without tags.");

	await assert.rejects(orchestratePlan({ planPath: tempFile }), {
		message: /No tagged sections found/,
	});

	fs.rmSync(tempDir, { recursive: true, force: true });
});
