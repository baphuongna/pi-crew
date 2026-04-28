import { spawn, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvent } from "../state/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";

export type FileExists = (filePath: string) => boolean;

const requireFromHere = createRequire(import.meta.url);

function packageRootFromRuntime(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function jitiRegisterPathFromPackageJson(packageJsonPath: string): string {
	return path.join(path.dirname(packageJsonPath), "lib", "jiti-register.mjs");
}

export function resolveJitiRegisterPath(packageRoot = packageRootFromRuntime(), exists: FileExists = fs.existsSync): string | undefined {
	const candidates = [
		path.join(packageRoot, "node_modules", "jiti", "lib", "jiti-register.mjs"),
		path.join(packageRoot, "..", "..", "node_modules", "jiti", "lib", "jiti-register.mjs"),
	];
	try {
		candidates.push(jitiRegisterPathFromPackageJson(requireFromHere.resolve("jiti/package.json")));
	} catch {
		// Fall through to explicit candidate checks.
	}
	return [...new Set(candidates)].find((candidate) => exists(candidate));
}

export function getBackgroundRunnerCommand(runnerPath: string, cwd: string, runId: string, jitiRegisterPath: string | false | undefined = resolveJitiRegisterPath()): { args: string[]; loader: "jiti" } {
	if (!jitiRegisterPath) throw new Error("pi-crew background runner cannot start: jiti loader not found. Reinstall pi-crew (`pi install npm:pi-crew`) or ensure node_modules/jiti is present.");
	return {
		args: ["--import", pathToFileURL(jitiRegisterPath).href, runnerPath, "--cwd", cwd, "--run-id", runId],
		loader: "jiti",
	};
}

export interface SpawnBackgroundTeamRunResult {
	pid?: number;
	logPath: string;
}

export function buildBackgroundSpawnOptions(manifest: TeamRunManifest, logFd: number): SpawnOptions {
	return {
		cwd: manifest.cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env },
		windowsHide: true,
	};
}

export function spawnBackgroundTeamRun(manifest: TeamRunManifest): SpawnBackgroundTeamRunResult {
	const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "background-runner.ts");
	const logPath = path.join(manifest.stateRoot, "background.log");
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	const logFd = fs.openSync(logPath, "a");
	try {
		const jitiRegisterPath = resolveJitiRegisterPath();
		if (!jitiRegisterPath) {
			const message = "pi-crew background runner cannot start: jiti loader not found. Reinstall pi-crew (`pi install npm:pi-crew`) or ensure node_modules/jiti is present.";
			appendEvent(manifest.eventsPath, { type: "async.failed", runId: manifest.runId, message });
			throw new Error(message);
		}
		const command = getBackgroundRunnerCommand(runnerPath, manifest.cwd, manifest.runId, jitiRegisterPath);
		fs.appendFileSync(logPath, `[pi-crew] background loader=${command.loader}\n`, "utf-8");
		const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
		child.unref();
		return { pid: child.pid, logPath };
	} finally {
		fs.closeSync(logFd);
	}
}
