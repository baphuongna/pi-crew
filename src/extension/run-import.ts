import * as fs from "node:fs";
import * as path from "node:path";
import { assertRunBundle } from "./run-bundle-schema.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";

export interface ImportedRunBundleInfo {
	runId: string;
	importedAt: string;
	bundlePath: string;
	summaryPath: string;
}

function importRoot(cwd: string, scope: "project" | "user"): string {
	const base = scope === "project" ? projectCrewRoot(cwd) : userCrewRoot();
	return path.join(base, DEFAULT_PATHS.state.importsSubdir);
}

export function importRunBundle(cwd: string, bundlePath: string, scope: "project" | "user" = "project"): ImportedRunBundleInfo {
	const resolvedPath = path.isAbsolute(bundlePath) ? bundlePath : path.resolve(cwd, bundlePath);
	const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as unknown;
	assertRunBundle(raw);
	const runId = raw.manifest.runId;
	const importedAt = new Date().toISOString();
	const root = path.join(importRoot(cwd, scope), runId);
	fs.mkdirSync(root, { recursive: true });
	const targetJson = path.join(root, "run-export.json");
	const targetSummary = path.join(root, "README.md");
	fs.writeFileSync(targetJson, `${JSON.stringify({ ...raw, importedAt, importedFrom: resolvedPath }, null, 2)}\n`, "utf-8");
	fs.writeFileSync(targetSummary, [
		`# Imported pi-crew run ${runId}`,
		"",
		`Imported: ${importedAt}`,
		`Source: ${resolvedPath}`,
		`Original export: ${raw.exportedAt}`,
		`Status: ${raw.manifest.status}`,
		`Team: ${raw.manifest.team}`,
		`Workflow: ${raw.manifest.workflow ?? "(none)"}`,
		`Goal: ${raw.manifest.goal}`,
		"",
		"## Tasks",
		...raw.tasks.map((task) => `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.error ? ` - ${task.error}` : ""}`),
		"",
	].join("\n"), "utf-8");
	return { runId, importedAt, bundlePath: targetJson, summaryPath: targetSummary };
}
