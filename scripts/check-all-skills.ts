#!/usr/bin/env node

/**
 * Check All Skills Script
 *
 * Runs verify-skill.ts against all skills and produces a summary report.
 *
 * Usage:
 *   node scripts/check-all-skills.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface SkillSummary {
	name: string;
	path: string;
	status: "pass" | "fail" | "warning";
	warnings: string[];
	errors: string[];
}

interface Report {
	total: number;
	passed: number;
	failed: number;
	warningsOnly: number;
	skills: SkillSummary[];
	timestamp: string;
}

const SKILLS_DIR = path.join(process.cwd(), "skills");

/**
 * Get all skill directories
 */
function getSkillDirs(): string[] {
	if (!fs.existsSync(SKILLS_DIR)) {
		console.error("Skills directory not found: " + SKILLS_DIR);
		return [];
	}

	const dirs: string[] = [];
	const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isDirectory()) {
			const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
			if (fs.existsSync(skillPath)) {
				dirs.push(entry.name);
			}
		}
	}

	return dirs.sort();
}

/**
 * Run verify-skill.ts for a single skill
 */
function verifySingleSkill(skillName: string): {
	passed: boolean;
	warnings: string[];
	errors: string[];
} {
	const skillPath = path.join(SKILLS_DIR, skillName, "SKILL.md");

	const result = spawnSync("node", ["scripts/verify-skill.ts", skillPath], {
		cwd: process.cwd(),
		encoding: "utf-8",
	});

	const output = result.stdout + result.stderr;
	const warnings: string[] = [];
	const errors: string[] = [];

	// Parse output
	const warningMatches = output.match(/[^\n]*⚠️[^\n]*/g);
	const errorMatches = output.match(/[^\n]+FAIL[^\n]+/g);

	if (warningMatches) {
		warnings.push(...warningMatches.map((w) => w.trim()));
	}
	if (errorMatches) {
		errors.push(...errorMatches.map((e) => e.trim()));
	}

	const passed = result.status === 0;

	return { passed, warnings, errors };
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(report: Report): string {
	const lines: string[] = [];

	lines.push("# Skill Verification Report");
	lines.push("");
	lines.push("Generated: " + report.timestamp);
	lines.push("");

	// Summary table
	lines.push("## Summary");
	lines.push("");
	lines.push("| Status | Count |");
	lines.push("|--------|-------|");
	lines.push("| PASS | " + report.passed + " |");
	lines.push("| FAIL | " + report.failed + " |");
	lines.push("| Warnings | " + report.warningsOnly + " |");
	lines.push("| **Total** | **" + report.total + "** |");
	lines.push("");

	// Skill list by status
	lines.push("## Skills by Status");
	lines.push("");

	// Passed skills
	const passedSkills = report.skills.filter((s) => s.status === "pass");
	if (passedSkills.length > 0) {
		lines.push("### Passing Skills");
		lines.push("");
		for (const skill of passedSkills) {
			lines.push("- " + skill.name);
		}
		lines.push("");
	}

	// Failed skills
	const failedSkills = report.skills.filter((s) => s.status === "fail");
	if (failedSkills.length > 0) {
		lines.push("### Failing Skills");
		lines.push("");
		for (const skill of failedSkills) {
			lines.push("- **" + skill.name + "**");
			for (const error of skill.errors) {
				lines.push("  - " + error);
			}
		}
		lines.push("");
	}

	// Warning skills
	const warningSkills = report.skills.filter((s) => s.status === "warning");
	if (warningSkills.length > 0) {
		lines.push("### Skills with Warnings");
		lines.push("");
		for (const skill of warningSkills) {
			lines.push("- **" + skill.name + "**");
			for (const warning of skill.warnings) {
				lines.push("  - " + warning);
			}
		}
		lines.push("");
	}

	// Recommendations
	lines.push("## Recommendations");
	lines.push("");
	if (failedSkills.length > 0) {
		lines.push("1. Fix " + failedSkills.length + " failing skills to have proper RED/GREEN gates");
		lines.push("2. Add trigger sections (When to Activate) if missing");
		lines.push("3. Add anti-patterns sections to prevent common mistakes");
		lines.push("");
	}
	if (warningSkills.length > 0) {
		lines.push("4. Review " + warningSkills.length + " skills with warnings for improvements");
	}

	return lines.join("\n");
}

/**
 * Generate JSON report
 */
function generateJsonReport(report: Report): string {
	return JSON.stringify(report, null, 2);
}

/**
 * Main entry point
 */
async function main() {
	console.log("Checking all skills...\n");

	const skillNames = getSkillDirs();
	console.log("Found " + skillNames.length + " skills\n");

	const report: Report = {
		total: skillNames.length,
		passed: 0,
		failed: 0,
		warningsOnly: 0,
		skills: [],
		timestamp: new Date().toISOString(),
	};

	for (const skillName of skillNames) {
		process.stdout.write(".");

		const result = verifySingleSkill(skillName);

		let status: "pass" | "fail" | "warning" = "pass";
		if (!result.passed && result.errors.length > 0) {
			status = "fail";
			report.failed++;
		} else if (result.warnings.length > 0) {
			status = "warning";
			report.warningsOnly++;
		} else {
			report.passed++;
		}

		report.skills.push({
			name: skillName,
			path: path.join("skills", skillName, "SKILL.md"),
			status,
			warnings: result.warnings,
			errors: result.errors,
		});
	}

	console.log("\n\n");

	// Print summary
	console.log("=== Skill Verification Summary ===");
	console.log("Total: " + report.total);
	console.log("Passed: " + report.passed);
	console.log("Failed: " + report.failed);
	console.log("Warnings only: " + report.warningsOnly);
	console.log("");

	// List failed skills
	if (report.failed > 0) {
		console.log("Failing skills:");
		for (const skill of report.skills.filter((s) => s.status === "fail")) {
			console.log("  - " + skill.name);
			for (const error of skill.errors) {
				console.log("    " + error);
			}
		}
		console.log("");
	}

	// List skills with warnings
	if (report.warningsOnly > 0) {
		console.log("Skills with warnings:");
		for (const skill of report.skills.filter((s) => s.status === "warning")) {
			console.log("  - " + skill.name);
			for (const warning of skill.warnings) {
				console.log("    " + warning);
			}
		}
		console.log("");
	}

	// Write reports
	const reportDir = path.join(process.cwd(), "reports");
	if (!fs.existsSync(reportDir)) {
		fs.mkdirSync(reportDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const mdReportPath = path.join(reportDir, "skill-verification-" + timestamp + ".md");
	const jsonReportPath = path.join(reportDir, "skill-verification-" + timestamp + ".json");
	const latestMdPath = path.join(reportDir, "skill-verification-latest.md");
	const latestJsonPath = path.join(reportDir, "skill-verification-latest.json");

	fs.writeFileSync(mdReportPath, generateMarkdownReport(report));
	fs.writeFileSync(jsonReportPath, generateJsonReport(report));
	fs.writeFileSync(latestMdPath, generateMarkdownReport(report));
	fs.writeFileSync(latestJsonPath, generateJsonReport(report));

	console.log("Reports written to:");
	console.log("  - " + mdReportPath);
	console.log("  - " + jsonReportPath);
	console.log("  - " + latestMdPath + " (latest)");
	console.log("  - " + latestJsonPath + " (latest)");

	// Exit with appropriate code
	if (report.failed > 0) {
		process.exit(1);
	} else if (report.warningsOnly > 0) {
		process.exit(2);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
