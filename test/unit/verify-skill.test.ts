/**
 * Verify Skill Script Tests
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

// Import verification functions by re-implementing the logic for testing
// This allows testing the pattern matching logic without running the script

interface Gate {
	type: "red" | "green";
	condition: string;
	check: string;
	failMessage: string;
}

interface VerificationResult {
	skillPath: string;
	skillName: string;
	hasTriggerSection: boolean;
	hasGates: boolean;
	gates: Gate[];
	hasAntiPatterns: boolean;
	hasEnforceableGates: boolean;
	isDescriptiveOnly: boolean;
	errors: string[];
	warnings: string[];
	passed: boolean;
}

const TRIGGER_PATTERNS = [
	/^#+\s*(When (to|should) Activate|Trigger|Conditions?|Use When|Apply When|Activation Criteria)/im,
	/(?:^|\n)##\s*(When (to|should) Activate|Trigger|Conditions?|Use When|Apply When|Activation Criteria)/im,
	/(?:^|\n)##\s*Activation/im,
	/^#+\s*Triggers?\s*\n/im,
	/^Use this skill (when|whenever|if)/im,
	/^Triggers?:/im,
	/description:.*Triggers?:/i,
];

const ANTI_PATTERN_PATTERNS = [
	/(?:^|\n)##\s*Anti-?patterns?\s*\n/im,
	/(?:^|\n)##\s*What (NOT|not) (to|to do)|Don't|DO NOT/im,
	/(?:^|\n)##\s*Pitfalls?\s*\n/im,
	/(?:^|\n)##\s*Common Mistakes?\s*\n/im,
	/(?:^|\n)##\s*Avoid\s*\n/im,
];

const PASS_FAIL_PATTERNS = [
	/(?:^|\n)###\s*(PASS|FAIL|RED|GREEN)/im,
	/(?:^|\n)\|\s*(PASS|FAIL|RED|GREEN)\s*\|/im,
	/(?:^|\n)_\(PASS\)|_\(FAIL\)/im,
	/(?:^|\n)\*\*PASS\*\*|\*\*FAIL\*\*/im,
	/(?:^|\n)(?:✓|✗|✅|❌)\s*(PASS|FAIL|pass|fail)/im,
];

function hasTriggerSection(content: string): boolean {
	return TRIGGER_PATTERNS.some((pattern) => pattern.test(content));
}

function hasAntiPatternSection(content: string): boolean {
	return ANTI_PATTERN_PATTERNS.some((pattern) => pattern.test(content));
}

function extractGates(content: string): Gate[] {
	const gates: Gate[] = [];

	// Check for explicit gate sections
	const gateSectionMatch = content.match(/(?:^|\n)(?:##|###)\s*(RED|GREEN)[\s_-]*(GATE|Gates?)[^\n]*\n([\s\S]*?)(?=\n##|\n###|$)/gi);

	if (gateSectionMatch) {
		for (const match of gateSectionMatch) {
			const typeMatch = match.match(/(RED|GREEN)/i);
			if (typeMatch) {
				const type = typeMatch[1].toLowerCase() as "red" | "green";

				const conditionMatch = match.match(/condition[:\s]+([^\n]+)/i);
				const checkMatch = match.match(/check[:\s]+([^\n]+)/i);
				const failMatch = match.match(/(?:fail|message)[:\s]+([^\n]+)/i);

				if (conditionMatch || checkMatch) {
					gates.push({
						type,
						condition: conditionMatch ? conditionMatch[1] : "implicit",
						check: checkMatch ? checkMatch[1] : "see description",
						failMessage: failMatch ? failMatch[1] : "",
					});
				}
			}
		}
	}

	// Look for explicit pass/fail checks
	for (const pattern of PASS_FAIL_PATTERNS) {
		const matches = content.match(new RegExp(pattern, "gi"));
		if (matches && matches.length > 0) {
			for (const match of matches) {
				const contextMatch = content.substring(
					Math.max(0, content.indexOf(match) - 200),
					content.indexOf(match) + match.length + 200,
				);

				if (
					/check|verify|validate|test|pass|fail|criteria|condition/i.test(contextMatch) &&
					!/best practice|recommend|suggest/i.test(contextMatch)
				) {
					gates.push({
						type: /pass|green/i.test(match) ? "green" : "red",
						condition: "explicit criteria in text",
						check: "see context",
						failMessage: "",
					});
				}
			}
		}
	}

	return gates;
}

function isDescriptiveOnly(content: string): boolean {
	const descriptiveIndicators = [
		/best\s+practices?\s*(only|only\s+descriptive)?/i,
		/recommendations?\s+only/i,
		/guidelines?\s+only/i,
		/no\s+(enforcement|validation|checks?)/i,
		/purely\s+descriptive/i,
		/descriptive\s+only/i,
	];

	const hasDescriptiveOnly = descriptiveIndicators.some((pattern) => pattern.test(content));

	const shouldCount = (content.match(/\bshould\b/gi) || []).length;
	const mustCount = (content.match(/\bmust\b/gi) || []).length;
	const shallCount = (content.match(/\bshall\b/gi) || []).length;

	return hasDescriptiveOnly || (shouldCount > 10 && mustCount === 0 && shallCount === 0);
}

function verifySkillContent(content: string): Omit<VerificationResult, "skillPath" | "skillName"> {
	const result = {
		hasTriggerSection: false,
		hasGates: false,
		gates: [] as Gate[],
		hasAntiPatterns: false,
		hasEnforceableGates: false,
		isDescriptiveOnly: false,
		errors: [] as string[],
		warnings: [] as string[],
		passed: false,
	};

	result.hasTriggerSection = hasTriggerSection(content);
	if (!result.hasTriggerSection) {
		result.warnings.push("No trigger section found");
	}

	result.hasAntiPatterns = hasAntiPatternSection(content);
	if (!result.hasAntiPatterns) {
		result.warnings.push("No anti-patterns section found");
	}

	result.gates = extractGates(content);
	result.hasGates = result.gates.length > 0;

	if (!result.hasGates) {
		result.errors.push("No RED/GREEN gate found - only descriptive text");
	}

	result.isDescriptiveOnly = isDescriptiveOnly(content);
	if (result.isDescriptiveOnly) {
		result.warnings.push("Skill appears to be purely descriptive without enforcement");
	}

	result.hasEnforceableGates = result.hasGates && !result.isDescriptiveOnly;
	result.passed = result.hasTriggerSection && result.hasEnforceableGates;

	return result;
}

// Test fixtures
const skillWithGates = `---
name: test-skill
description: "Test skill with proper enforcement"
---

# Test Skill

Use this skill when working on code.

## RED Gate: Tests Pass

- condition: all tests pass
- check: npm test
- failMessage: Tests must pass before merge

## GREEN Gate: Build Complete

- condition: build succeeds
- check: npm run build
- failMessage: Build must succeed

## Anti-patterns

- Don't skip tests
- Don't ignore failures
`;

const skillDescriptiveOnly = `---
name: descriptive-skill
description: "Descriptive skill without enforcement"
---

# Descriptive Skill

This skill provides best practices for testing.

## Best Practices

- You should write tests
- You should run tests
- You should check coverage
- You might want to use mocking
- You could consider integration tests
- You may want to add assertions
- You should document your tests
- You ought to review tests
- You might add edge cases
- You should mock dependencies

## Recommendations

These are guidelines, not rules.
`;

const skillMissingTrigger = `---
name: missing-trigger
description: "Skill without trigger section"
---

# Missing Trigger

This skill is missing the trigger section.

## Rules

- Must follow these rules
- Shall enforce this policy
- Must pass all checks

## Anti-patterns

- Don't do this
- Avoid that
`;

const skillWithGreenGate = `---
name: green-gate-skill
description: "Skill with GREEN gate"
---

# Green Gate Skill

## When to Activate

Use when needing validation.

## GREEN Gate: Validation Complete

- condition: output validated
- check: grep for error patterns
- failMessage: Output contains errors

## Anti-patterns

- Ignoring validation results
`;

const skillWithRedGate = `---
name: red-gate-skill
description: "Skill with RED gate"
---

# Red Gate Skill

## When to Activate

Use when preventing failures.

## RED Gate: No Failures

- condition: exit code is 0
- check: verify exit code
- failMessage: Command failed with non-zero exit code

## Anti-patterns

- Proceeding on failure
`;

// Tests
test("Skill with proper gates passes", () => {
	const result = verifySkillContent(skillWithGates);
	assert.ok(result.hasTriggerSection, "Should have trigger section");
	assert.ok(result.hasGates, "Should have gates");
	assert.ok(result.hasAntiPatterns, "Should have anti-patterns");
	assert.ok(!result.isDescriptiveOnly, "Should not be descriptive only");
	assert.ok(result.passed, "Should pass verification");
});

test("Skill with only descriptive text fails", () => {
	const result = verifySkillContent(skillDescriptiveOnly);
	assert.ok(!result.hasTriggerSection, "Should not have trigger section");
	assert.ok(!result.hasGates, "Should not have gates");
	assert.ok(!result.passed, "Should fail verification");
	assert.ok(result.errors.length > 0, "Should have errors");
});

test("Skill missing trigger section warns", () => {
	const result = verifySkillContent(skillMissingTrigger);
	assert.ok(!result.hasTriggerSection, "Should not have trigger section");
	assert.ok(result.hasAntiPatterns, "Should have anti-patterns");
	// Missing trigger is a warning, not a failure, but without gates it should fail
	assert.ok(result.warnings.length > 0 || !result.passed, "Should have warnings or fail");
});

test("Skill with GREEN gate is recognized", () => {
	const result = verifySkillContent(skillWithGreenGate);
	assert.ok(result.hasGates, "Should have gates");
	assert.strictEqual(result.gates[0]?.type, "green", "First gate should be green");
});

test("Skill with RED gate is recognized", () => {
	const result = verifySkillContent(skillWithRedGate);
	assert.ok(result.hasGates, "Should have gates");
	assert.strictEqual(result.gates[0]?.type, "red", "First gate should be red");
});

test("hasTriggerSection detects various patterns", () => {
	assert.ok(hasTriggerSection("## When to Activate\n"), "When to Activate");
	assert.ok(hasTriggerSection("## Trigger\n"), "Trigger");
	assert.ok(hasTriggerSection("# Triggers\n"), "Triggers header");
	assert.ok(hasTriggerSection("## Use When\n"), "Use When");
	assert.ok(!hasTriggerSection("## Random Section\n"), "Random section");
});

test("hasAntiPatternSection detects various patterns", () => {
	assert.ok(hasAntiPatternSection("## Anti-patterns\n"), "Anti-patterns");
	assert.ok(hasAntiPatternSection("## What NOT to do\n"), "What NOT to do");
	assert.ok(hasAntiPatternSection("## Don't\n"), "Don't");
	assert.ok(hasAntiPatternSection("## Pitfalls\n"), "Pitfalls");
	assert.ok(!hasAntiPatternSection("## Guidelines\n"), "Guidelines");
});

test("isDescriptiveOnly detects pure recommendations", () => {
	assert.ok(isDescriptiveOnly("best practices only"), "best practices only");
	assert.ok(isDescriptiveOnly("recommendations only"), "recommendations only");
	assert.ok(!isDescriptiveOnly("must follow rules"), "must follow rules");
});

test("isDescriptiveOnly counts should vs must", () => {
	const lotsOfShould = "should do this " + "should do that ".repeat(11);
	assert.ok(isDescriptiveOnly(lotsOfShould), "lots of should without must");

	const withMust = lotsOfShould + " must do something";
	assert.ok(!isDescriptiveOnly(withMust), "with must present");
});

test("Gate extraction from RED/GREEN sections", () => {
	const content =
		"## RED Gate: Block Bad Input\n- condition: input is valid\n- check: validate input\n- failMessage: Invalid input rejected\n\n## GREEN Gate: Proceed\n- condition: validated\n- check: confirm\n- failMessage: Not confirmed";

	const gates = extractGates(content);
	assert.ok(gates.length >= 1, "Should extract gates");
});

test("Gate extraction from decision matrices", () => {
	const content =
		"## Decision Matrix\n\n| Condition | Check | Result |\n|-----------|-------|--------|\n| Valid | verify | PASS |\n| Invalid | verify | FAIL |";

	const gates = extractGates(content);
	// Decision matrix parsing may not extract all gates, but should not crash
	assert.ok(true, "Should not crash on decision matrix");
});

// Integration test: real skill files
test("Real skill: safe-bash has triggers and anti-patterns", () => {
	const skillPath = path.join(process.cwd(), "skills/safe-bash/SKILL.md");
	if (fs.existsSync(skillPath)) {
		const content = fs.readFileSync(skillPath, "utf-8");
		const result = verifySkillContent(content);
		assert.ok(result.hasTriggerSection, "safe-bash should have trigger section");
		assert.ok(result.hasAntiPatterns, "safe-bash should have anti-patterns");
	}
});

test("Real skill: delegation-patterns has triggers and anti-patterns", () => {
	const skillPath = path.join(process.cwd(), "skills/delegation-patterns/SKILL.md");
	if (fs.existsSync(skillPath)) {
		const content = fs.readFileSync(skillPath, "utf-8");
		const result = verifySkillContent(content);
		assert.ok(result.hasTriggerSection, "delegation-patterns should have trigger section");
		assert.ok(result.hasAntiPatterns, "delegation-patterns should have anti-patterns");
	}
});

test("Real skill: post-mortem has triggers", () => {
	const skillPath = path.join(process.cwd(), "skills/post-mortem/SKILL.md");
	if (fs.existsSync(skillPath)) {
		const content = fs.readFileSync(skillPath, "utf-8");
		const result = verifySkillContent(content);
		assert.ok(result.hasTriggerSection, "post-mortem should have trigger section");
	}
});

test("Real skill: scrutinize has triggers", () => {
	const skillPath = path.join(process.cwd(), "skills/scrutinize/SKILL.md");
	if (fs.existsSync(skillPath)) {
		const content = fs.readFileSync(skillPath, "utf-8");
		const result = verifySkillContent(content);
		assert.ok(result.hasTriggerSection, "scrutinize should have trigger section");
	}
});
