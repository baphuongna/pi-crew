import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { DEFAULT_PATHS } from "../config/defaults.ts";

export interface ImportedRunIndexEntry {
	runId: string;
	scope: "project" | "user";
	bundlePath: string;
	summaryPath: string;
	importedAt?: string;
	status?: string;
	team?: string;
	workflow?: string;
	goal?: string;
}

function readEntry(root: string, scope: "project" | "user", runId: string): ImportedRunIndexEntry | undefined {
	const bundlePath = path.join(root, runId, "run-export.json");
	const summaryPath = path.join(root, runId, "README.md");
	if (!fs.existsSync(bundlePath)) return undefined;
	try {
		const raw = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as Record<string, unknown>;
		const manifest = raw.manifest && typeof raw.manifest === "object" && !Array.isArray(raw.manifest) ? raw.manifest as Record<string, unknown> : {};
		return {
			runId,
			scope,
			bundlePath,
			summaryPath,
			importedAt: typeof raw.importedAt === "string" ? raw.importedAt : undefined,
			status: typeof manifest.status === "string" ? manifest.status : undefined,
			team: typeof manifest.team === "string" ? manifest.team : undefined,
			workflow: typeof manifest.workflow === "string" ? manifest.workflow : undefined,
			goal: typeof manifest.goal === "string" ? manifest.goal : undefined,
		};
	} catch {
		return { runId, scope, bundlePath, summaryPath };
	}
}

function collect(root: string, scope: "project" | "user"): ImportedRunIndexEntry[] {
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root)
		.map((entry) => readEntry(root, scope, entry))
		.filter((entry): entry is ImportedRunIndexEntry => entry !== undefined);
}

export function listImportedRuns(cwd: string): ImportedRunIndexEntry[] {
	const projectRoot = path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.importsSubdir);
	const userRoot = path.join(userCrewRoot(), DEFAULT_PATHS.state.importsSubdir);
	return [...collect(userRoot, "user"), ...collect(projectRoot, "project")]
		.sort((a, b) => (b.importedAt ?? "").localeCompare(a.importedAt ?? ""));
}
