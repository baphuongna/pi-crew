import { spawn, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendEvent } from "../state/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";


export type FileExists = (filePath: string) => boolean;

const requireFromHere = createRequire(import.meta.url);

// Node introduced --experimental-strip-types in v22.6.0
const STRIP_TYPES_MIN_MAJOR = 22;
const STRIP_TYPES_MIN_MINOR = 6;

export type LoaderSpec =
	| { kind: "jiti"; path: string }
	| { kind: "strip-types" };

type LoaderInput = LoaderSpec | string | false | undefined;

function packageRootFromRuntime(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function jitiRegisterPathFromPackageJson(packageJsonPath: string): string {
	return path.join(path.dirname(packageJsonPath), "lib", "jiti-register.mjs");
}

export function resolveJitiRegisterPath(packageRoot = packageRootFromRuntime(), exists: FileExists = fs.existsSync): string | undefined {
	// Walk upward from packageRoot looking for node_modules/jiti/lib/jiti-register.mjs
	let current = path.resolve(packageRoot);
	const root = path.parse(current).root;
	while (true) {
		const candidate = path.join(current, "node_modules", "jiti", "lib", "jiti-register.mjs");
		if (exists(candidate)) return candidate;
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	// Fallback: require resolution (handles global installs or isolated stores)
	try {
		const fromRequire = jitiRegisterPathFromPackageJson(requireFromHere.resolve("jiti/package.json"));
		if (exists(fromRequire)) return fromRequire;
	} catch {
		// Fall through.
	}
	return undefined;
}

export function nodeSupportsStripTypes(version = process.version): boolean {
	const match = /^v?(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > STRIP_TYPES_MIN_MAJOR) return true;
	if (major === STRIP_TYPES_MIN_MAJOR && minor >= STRIP_TYPES_MIN_MINOR) return true;
	return false;
}

export interface ResolveLoaderOptions {
	packageRoot?: string;
	exists?: FileExists;
	nodeVersion?: string;
}

export function resolveTypeScriptLoader(opts: ResolveLoaderOptions = {}): LoaderSpec | undefined {
	const jitiPath = resolveJitiRegisterPath(opts.packageRoot, opts.exists);
	if (jitiPath) return { kind: "jiti", path: jitiPath };
	if (nodeSupportsStripTypes(opts.nodeVersion)) return { kind: "strip-types" };
	return undefined;
}

function normalizeLoaderInput(input: LoaderInput): LoaderSpec | undefined {
	if (input === undefined || input === null || input === false || input === "") return undefined;
	if (typeof input === "string") return { kind: "jiti", path: input };
	return input;
}

function buildLoaderUnavailableMessage(searchedFrom: string): string {
	return [
		"pi-crew background runner cannot start: jiti loader not found and Node --experimental-strip-types fallback unavailable.",
		`  - Searched for node_modules/jiti walking upward from: ${searchedFrom}`,
		`  - Node --experimental-strip-types requires >= 22.6 (current: ${process.version})`,
		"  - Fix: run 'npm install' in the pi-crew directory, reinstall via 'pi install npm:pi-crew', or upgrade Node.js to >= 22.6.",
	].join("\n");
}

export function getBackgroundRunnerCommand(
	runnerPath: string,
	cwd: string,
	runId: string,
	loaderInput: LoaderInput = resolveTypeScriptLoader(),
): { args: string[]; loader: "jiti" | "strip-types" } {
	const loader = normalizeLoaderInput(loaderInput);
	if (!loader) throw new Error(buildLoaderUnavailableMessage(packageRootFromRuntime()));
	if (loader.kind === "jiti") {
		return {
			args: ["--import", pathToFileURL(loader.path).href, runnerPath, "--cwd", cwd, "--run-id", runId],
			loader: "jiti",
		};
	}
	return {
		args: ["--experimental-strip-types", runnerPath, "--cwd", cwd, "--run-id", runId],
		loader: "strip-types",
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
		env: { ...process.env, PI_CREW_PARENT_PID: String(process.pid) },
		windowsHide: true,
	};
}

export function spawnBackgroundTeamRun(manifest: TeamRunManifest): SpawnBackgroundTeamRunResult {
	const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "background-runner.ts");
	const logPath = path.join(manifest.stateRoot, "background.log");
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	const logFd = fs.openSync(logPath, "a");
	try {
		const loader = resolveTypeScriptLoader();
		if (!loader) {
			const message = buildLoaderUnavailableMessage(packageRootFromRuntime());
			appendEvent(manifest.eventsPath, { type: "async.failed", runId: manifest.runId, message });
			throw new Error(message);
		}
		const command = getBackgroundRunnerCommand(runnerPath, manifest.cwd, manifest.runId, loader);
		fs.appendFileSync(logPath, `[pi-crew] background loader=${command.loader}\n`, "utf-8");
		const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
		child.unref();

		return { pid: child.pid, logPath };
	} finally {
		fs.closeSync(logFd);
	}
}
