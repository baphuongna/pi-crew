import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function collectTypeScriptFiles(root: string): string[] {
	const entries = fs.readdirSync(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTypeScriptFiles(fullPath));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(fullPath);
		}
	}
	return files;
}

function fileHasTeamContextImportFromTeamTool(filePath: string): boolean {
	const content = fs.readFileSync(filePath, "utf-8");
	// Split by lines and check each line individually
	const lines = content.split("\n");
	// Match import statements from team-tool.ts (not team-tool/context.ts or team-tool/something.ts)
	const importRegex = /from\s+["'][^"']*\/team-tool\.ts["']/;
	for (const line of lines) {
		if (importRegex.test(line) && line.includes("TeamContext")) {
			return true;
		}
	}
	return false;
}

test("team-tool actions use direct TeamContext imports from team-tool/context.ts", () => {
	const cwd = process.cwd();
	const offenders: string[] = [];
	for (const file of collectTypeScriptFiles(path.join(cwd, "src"))) {
		if (path.relative(cwd, file) === "src/extension/team-tool.ts") continue;
		if (fileHasTeamContextImportFromTeamTool(file)) offenders.push(path.relative(cwd, file));
	}
	for (const file of collectTypeScriptFiles(path.join(cwd, "test"))) {
		if (fileHasTeamContextImportFromTeamTool(file)) offenders.push(path.relative(cwd, file));
	}
	assert.equal(
		offenders.length,
		0,
		`TeamContext should be imported directly from team-tool/context.ts, but found imports from team-tool.ts in: ${offenders.join(", ")}`,
	);
});
