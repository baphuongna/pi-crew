import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TeamRunManifest } from "../state/types.ts";

export function getBackgroundRunnerCommand(runnerPath: string, cwd: string, runId: string): { args: string[]; loader: "jiti" } {
	const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const jitiRegisterPath = path.join(packageRoot, "node_modules", "jiti", "lib", "jiti-register.mjs");
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
	const command = getBackgroundRunnerCommand(runnerPath, manifest.cwd, manifest.runId);
	fs.appendFileSync(logPath, `[pi-crew] background loader=${command.loader}\n`, "utf-8");
	const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
	child.unref();
	fs.closeSync(logFd);
	return { pid: child.pid, logPath };
}
