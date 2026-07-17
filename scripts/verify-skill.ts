#!/usr/bin/env node
/**
 * Skill Verification Script
 *
 * Verifies that a skill has proper gate enforcement (RED/GREEN gates or pi-crew format).
 * Supports both:
 *   - Classic RED/GREEN gate format: ## RED Gate, ## GREEN Gate
 *   - pi-crew format: ## Refuse Gate, ## Enforcement, checkbox lists
 *
 * Usage:
 *   node scripts/verify-skill.ts skills/systematic-debugging/SKILL.md   # single skill
 *   node scripts/verify-skill.ts skills/                                   # batch mode
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

// ============================================================
// PATTERN DEFINITIONS
// ============================================================

// Trigger/activation patterns
const TRIGGER_PATTERNS = [
	/^#+\s*(When (to|should) Activate|Trigger|Conditions?|Use When|Apply When|Activation Criteria)/im,
	/(?:^|\n)##\s*(When (to|should) Activate|Trigger|Conditions?|Use When|Apply When|Activation Criteria)/im,
	/(?:^|\n)##\s*Activation/im,
	/^#+\s*Triggers?\s*\n/im,
	/^Use this skill (when|whenever|if)/im,
	/^Triggers?:/im,
	/description:.*Triggers?:/i,
];

// Anti-pattern patterns
const ANTI_PATTERN_PATTERNS = [
	/(?:^|\n)##\s*Anti-?patterns?\s*\n/im,
	/(?:^|\n)##\s*What (NOT|not) (to|to do)|Don't|DO NOT/im,
	/(?:^|\n)##\s*Pitfalls?\s*\n/im,
	/(?:^|\n)##\s*Common Mistakes?\s*\n/im,
	/(?:^|\n)##\s*Avoid\s*\n/im,
];

// Classic RED/GREEN gate patterns
const CLASSIC_GATE_PATTERNS = [
	/(?:^|\n)##\s*(RED|GREEN)[\s_-]*(GATE|Gates?)\s*\n/im,
	/(?:^|\n)###\s*(RED|GREEN)[\s_-]*(GATE|Gates?)\s*\n/im,
	/(?:^|\n)(RED|GREEN)[\s_-]*(GATE|Gates?):/im,
];

// pi-crew specific gate patterns
const PI_CREW_REFUSE_GATE_PATTERNS = [
	/(?:^|\n)##\s*Refuse\s*Gate[^\n]*\n/i,
	/(?:^|\n)###\s*Refuse\s*Gate[^\n]*\n/i,
	/(?:^|\n)##\s*STOP[\s_-]*gate[^\n]*\n/i,
	/(?:^|\n)###\s*STOP[\s_-]*gate[^\n]*\n/i,
];

const PI_CREW_ENFORCEMENT_PATTERNS = [
	/(?:^|\n)##\s*Enforcement[^\n]*\n/i,
	/(?:^|\n)###\s*Enforcement[^\n]*\n/i,
	/(?:^|\n)##\s*Gate[^\n]*\n/i,
	/(?:^|\n)###\s*Gate[^\n]*\n/i,
];

const PI_CREW_PROCEED_PATTERNS = [
	/(?:^|\n)##\s*Proceed\s*Gate[^\n]*\n/i,
	/(?:^|\n)###\s*Proceed\s*Gate[^\n]*\n/i,
	/(?:^|\n)##\s*(GREEN|Go)[\s_-]*(GATE|Gates?)[^\n]*\n/i,
];

// Checkbox list pattern (can indicate enforceable gates)
const CHECKBOX_PATTERN = /(?:^|\n)(\s*)-\s*\[([ xX])\]/g;

// Pass/fail patterns
const PASS_FAIL_PATTERNS = [
	/(?:^|\n)###\s*(PASS|FAIL|RED|GREEN)/im,
	/(?:^|\n)\|\s*(PASS|FAIL|RED|GREEN)\s*\|/im,
	/(?:^|\n)_\(PASS\)|_\(FAIL\)/im,
	/(?:^|\n)\*\*PASS\*\*|\*\*FAIL\*\*/im,
	/(?:^|\n)(?:✓|✗|✅|❌)\s*(PASS|FAIL|pass|fail)/im,
];

// ============================================================
// PATTERN MATCHING FUNCTIONS
// ============================================================

function hasTriggerSection(content: string): boolean {
	return TRIGGER_PATTERNS.some((pattern) => pattern.test(content));
}

function hasAntiPatternSection(content: string): boolean {
	return ANTI_PATTERN_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Extract gates from classic RED/GREEN format
 */
function extractClassicGates(content: string): Gate[] {
	const gates: Gate[] = [];

	for (const pattern of CLASSIC_GATE_PATTERNS) {
		const re = new RegExp(pattern.source, "gi");
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const typeMatch = m[0].match(/(RED|GREEN)/i);
			if (typeMatch) {
				const type = typeMatch[1].toLowerCase() as "red" | "green";
				gates.push({
					type,
					condition: "classic gate",
					check: "see section",
					failMessage: "",
				});
			}
		}
	}

	return gates;
}

/**
 * Extract gates from pi-crew format (Refuse Gate, Enforcement, etc.)
 */
function extractPiCrewGates(content: string): Gate[] {
	const gates: Gate[] = [];

	// Check for Refuse Gate (RED gate equivalent)
	for (const pattern of PI_CREW_REFUSE_GATE_PATTERNS) {
		if (pattern.test(content)) {
			gates.push({
				type: "red",
				condition: "Refuse Gate (pi-crew format)",
				check: "checklist items",
				failMessage: "Stop and state what's missing",
			});
			break;
		}
	}

	// Check for Enforcement sections (could be RED or GREEN)
	for (const pattern of PI_CREW_ENFORCEMENT_PATTERNS) {
		const match = content.match(pattern);
		if (match) {
			const sectionTitle = match[0].trim();
			// Determine if this looks like a RED or GREEN gate based on context
			const isRedGate = /refuse|stop|block|prevent/i.test(sectionTitle);
			gates.push({
				type: isRedGate ? "red" : "green",
				condition: sectionTitle,
				check: "checklist or criteria",
				failMessage: isRedGate ? "Do not proceed" : "Verify before proceeding",
			});
			break;
		}
	}

	// Check for Proceed/Go gates (GREEN gate equivalent)
	for (const pattern of PI_CREW_PROCEED_PATTERNS) {
		if (pattern.test(content)) {
			gates.push({
				type: "green",
				condition: "Proceed Gate (pi-crew format)",
				check: "pre-conditions met",
				failMessage: "Wait until conditions are met",
			});
			break;
		}
	}

	return gates;
}

/**
 * Extract gates from checkbox lists (pi-crew enforcement pattern)
 * Looks for checkbox lists that represent gate conditions
 */
function extractCheckboxGates(content: string): Gate[] {
	const gates: Gate[] = [];

	// Find all checkbox items
	const checkboxMatches = content.match(/(?:^|\n)(\s*)-\s*\[([ xX])\]/g);

	if (checkboxMatches && checkboxMatches.length >= 2) {
		// Check if checkboxes are in a gate-like section
		const gateSections = [...PI_CREW_REFUSE_GATE_PATTERNS, ...PI_CREW_ENFORCEMENT_PATTERNS, ...PI_CREW_PROCEED_PATTERNS];

		for (const sectionPattern of gateSections) {
			if (sectionPattern.test(content)) {
				// Found checkbox items in a gate section
				gates.push({
					type: /proceed|green|go/i.test(sectionPattern.source) ? "green" : "red",
					condition: `${checkboxMatches.length} checklist items`,
					check: "checkbox items are checked",
					failMessage: "All items must be satisfied",
				});
				return gates;
			}
		}

		// Checkboxes found but not in a named gate section - still count if substantial
		if (checkboxMatches.length >= 3) {
			gates.push({
				type: "red",
				condition: `${checkboxMatches.length} unchecked items`,
				check: "see checklist",
				failMessage: "Verify all conditions",
			});
		}
	}

	return gates;
}

/**
 * Extract gates from pass/fail patterns
 */
function extractPassFailGates(content: string): Gate[] {
	const gates: Gate[] = [];

	for (const pattern of PASS_FAIL_PATTERNS) {
		const re = new RegExp(pattern.source, "gi");
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const match = m[0];
			gates.push({
				type: /pass|green/i.test(match) ? "green" : "red",
				condition: "explicit criteria",
				check: "see text",
				failMessage: "",
			});
		}
	}

	return gates;
}

/**
 * Extract all gates from content
 */
function extractGates(content: string): Gate[] {
	const gates: Gate[] = [];

	// Try all extraction methods
	gates.push(...extractClassicGates(content));
	gates.push(...extractPiCrewGates(content));
	gates.push(...extractCheckboxGates(content));
	gates.push(...extractPassFailGates(content));

	// Deduplicate by condition
	const seen = new Set<string>();
	return gates.filter((gate) => {
		const key = `${gate.type}:${gate.condition}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Determine if skill is purely descriptive without enforcement
 */
function isDescriptiveOnly(content: string): boolean {
	const descriptiveIndicators = [
		/best\s+practices?\s*(only|only\s+descriptive)?/i,
		/recommendations?\s+only/i,
		/guidelines?\s+only/i,
		/no\s+(enforcement|validation|checks?)/i,
		/purely\s+descriptive/i,
		/descriptive\s+only/i,
		/\[\s*TODO.*enforce/i,
	];

	const hasDescriptiveOnly = descriptiveIndicators.some((pattern) => pattern.test(content));

	// Check for "should" vs "must" ratio
	const shouldCount = (content.match(/\bshould\b/gi) || []).length;
	const mustCount = (content.match(/\bmust\b/gi) || []).length;
	const shallCount = (content.match(/\bshall\b/gi) || []).length;

	return hasDescriptiveOnly || (shouldCount > 10 && mustCount === 0 && shallCount === 0);
}

// ============================================================
// VERIFICATION FUNCTION
// ============================================================

function verifySkill(skillPath: string): VerificationResult {
	const result: VerificationResult = {
		skillPath,
		skillName: path.basename(path.dirname(skillPath)),
		hasTriggerSection: false,
		hasGates: false,
		gates: [],
		hasAntiPatterns: false,
		hasEnforceableGates: false,
		isDescriptiveOnly: false,
		errors: [],
		warnings: [],
		passed: false,
	};

	try {
		const content = fs.readFileSync(skillPath, "utf-8");

		// Check YAML frontmatter for required fields
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (frontmatterMatch) {
			const frontmatter = frontmatterMatch[1];
			if (!/^origin:/m.test(frontmatter)) {
				result.errors.push("Missing 'origin' field in YAML frontmatter");
			}
			if (!/^name:/m.test(frontmatter)) {
				result.errors.push("Missing 'name' field in YAML frontmatter");
			}
			if (!/^description:/m.test(frontmatter)) {
				result.errors.push("Missing 'description' field in YAML frontmatter");
			}
		} else {
			result.errors.push("No YAML frontmatter found");
		}

		// Check for trigger section
		result.hasTriggerSection = hasTriggerSection(content);
		if (!result.hasTriggerSection) {
			result.warnings.push("No trigger section found (When to Activate, Trigger, etc.)");
		}

		// Check for anti-patterns
		result.hasAntiPatterns = hasAntiPatternSection(content);
		if (!result.hasAntiPatterns) {
			result.warnings.push("No anti-patterns section found");
		}

		// Extract gates
		result.gates = extractGates(content);
		result.hasGates = result.gates.length > 0;

		if (!result.hasGates) {
			result.errors.push("No gate found (RED/GREEN/Refuse/Enforcement)");
		}

		// Check if purely descriptive
		result.isDescriptiveOnly = isDescriptiveOnly(content);
		if (result.isDescriptiveOnly) {
			result.warnings.push("Skill appears to be purely descriptive without enforcement");
		}

		// Determine if has enforceable gates
		result.hasEnforceableGates = result.hasGates && !result.isDescriptiveOnly;

		// Determine pass/fail
		result.passed = result.hasTriggerSection && result.hasEnforceableGates;
	} catch (err) {
		result.errors.push(`Failed to read skill: ${err}`);
	}

	return result;
}

// ============================================================
// OUTPUT FORMATTING
// ============================================================

function formatResult(result: VerificationResult): string {
	const lines: string[] = [];

	lines.push(`=== Skill: ${result.skillName} ===`);

	if (result.hasTriggerSection) {
		lines.push("✅ Has trigger section");
	} else {
		lines.push("⚠️  No trigger section found");
	}

	if (result.hasGates) {
		for (const gate of result.gates.slice(0, 3)) {
			const label = gate.type.toUpperCase();
			const check = gate.check !== "see section" && gate.check !== "see text" ? ` (check: ${gate.check})` : "";
			lines.push(`✅ Has ${label} gate: "${gate.condition}"${check}`);
		}
		if (result.gates.length > 3) {
			lines.push(`   ... and ${result.gates.length - 3} more gates`);
		}
	} else {
		lines.push("⚠️  No gate found - only descriptive text");
	}

	if (result.hasAntiPatterns) {
		lines.push("✅ Has anti-patterns");
	} else {
		lines.push("⚠️  No anti-patterns section");
	}

	if (result.warnings.length > 0) {
		for (const warning of result.warnings) {
			lines.push(`⚠️  ${warning}`);
		}
	}

	if (result.errors.length > 0) {
		for (const error of result.errors) {
			lines.push(`❌ ${error}`);
		}
	}

	if (result.passed) {
		lines.push("✅ PASS - Skill has enforceable gates");
	} else {
		lines.push("❌ FAIL - Skill lacks enforceable gates");
	}

	return lines.join("\n");
}

// ============================================================
// FILE DISCOVERY
// ============================================================

function getAllSkillFiles(dirPath: string): string[] {
	const skills: string[] = [];

	if (!fs.existsSync(dirPath)) {
		return skills;
	}

	const entries = fs.readdirSync(dirPath, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			const skillFile = path.join(fullPath, "SKILL.md");
			if (fs.existsSync(skillFile)) {
				skills.push(skillFile);
			} else {
				// Skip subdirectories - skills should be flat in the skills/ folder
			}
		}
	}

	return skills;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0) {
		console.error("Usage: node scripts/verify-skill.ts <skill-path> [skill-path2 ...]");
		console.error("       node scripts/verify-skill.ts skills/   # batch mode");
		process.exit(1);
	}

	const results: VerificationResult[] = [];

	// Handle batch mode
	if (args.length === 1 && fs.statSync(args[0]).isDirectory()) {
		const skillFiles = getAllSkillFiles(args[0]);
		console.log(`Checking ${skillFiles.length} skills in batch mode...\n`);

		for (const skillFile of skillFiles) {
			const result = verifySkill(skillFile);
			results.push(result);
			console.log(formatResult(result));
			console.log("");
		}
	} else {
		// Single or multiple skill files
		for (const arg of args) {
			if (!fs.existsSync(arg)) {
				console.error(`Error: File not found: ${arg}`);
				continue;
			}

			if (fs.statSync(arg).isDirectory()) {
				const skillFiles = getAllSkillFiles(arg);
				for (const skillFile of skillFiles) {
					const result = verifySkill(skillFile);
					results.push(result);
					console.log(formatResult(result));
					console.log("");
				}
			} else if (arg.endsWith("SKILL.md") || arg.endsWith(".md")) {
				const result = verifySkill(arg);
				results.push(result);
				console.log(formatResult(result));
				console.log("");
			}
		}
	}

	// Summary
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed && r.errors.length > 0).length;
	const warningsOnly = results.filter((r) => r.passed || (r.warnings.length > 0 && r.errors.length === 0)).length;

	console.log("=== Summary ===");
	console.log(`Total: ${results.length}`);
	console.log(`Passed: ${passed}`);
	console.log(`Failed: ${failed}`);
	console.log(`Warnings only: ${warningsOnly}`);

	// List failing skills
	if (failed > 0) {
		console.log("\nFailing skills:");
		for (const r of results.filter((r) => !r.passed && r.errors.length > 0)) {
			console.log(`  - ${r.skillName}`);
			for (const err of r.errors) {
				console.log(`      ${err}`);
			}
		}
	}

	// Determine exit code
	let exitCode = 0;
	if (failed > 0) {
		exitCode = 1;
	} else if (warningsOnly > 0 && passed > 0) {
		exitCode = 2;
	}

	process.exit(exitCode);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
