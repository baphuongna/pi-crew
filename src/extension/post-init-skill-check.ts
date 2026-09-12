import { renderSkillInstructions } from "../runtime/skill-instructions.ts";

export type SkillCheckResult = {
	total: number;
	resolved: number;
	missing: string[];
	severity: "ok" | "warn" | "error";
	message: string;
};

export async function runPostInitSkillCheck(cwd: string): Promise<SkillCheckResult> {
	const result = renderSkillInstructions({ cwd, role: "executor" });
	const total = result.names.length;
	const missingMatches = result.block.match(/Skill '([^']+)' was selected but no SKILL\.md file was found/g);
	const missing = missingMatches ? missingMatches.map((m) => m.match(/'([^']+)'/)![1]) : [];
	const resolved = total - missing.length;

	let severity: "ok" | "warn" | "error";
	let message: string;
	if (resolved === total) {
		severity = "ok";
		message = `All ${total} default skills resolved`;
	} else if (resolved === 0) {
		severity = "error";
		message = `0/${total} default skills resolved — likely bundle stale. Run \`npm run build:bundle\`.`;
	} else {
		severity = "warn";
		message = `${resolved}/${total} default skills resolved — degraded: ${missing.join(", ")}`;
	}

	return { total, resolved, missing, severity, message };
}
