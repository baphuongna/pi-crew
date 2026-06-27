import { spawn, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { appendEvent } from "../state/event-log.ts";
import { sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { resolvePeerDepDir, PEER_DEP_DIR_ENV } from "./peer-dep.ts";
import {
	registerWorker,
	unregisterWorker,
} from "./orphan-worker-registry.ts";
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
		const pkgPath = requireFromHere.resolve("jiti/package.json");
		const candidates = [
			jitiRegisterPathFromPackageJson(pkgPath),
			path.join(path.dirname(pkgPath), "register.mjs"),
			path.join(path.dirname(pkgPath), "dist", "register.mjs"),
		];
		for (const c of candidates) if (exists(c)) return c;
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
	/**
	 * Directory to write the V8 fatal-error report into. Defaults to
	 * path.dirname(runnerPath). Pass the run stateRoot so the report lands
	 * next to background.log for easy diagnosis.
	 */
	reportDirectory?: string,
): { args: string[]; loader: "jiti" | "strip-types" } {
	const loader = normalizeLoaderInput(loaderInput);
	if (!loader) throw new Error(buildLoaderUnavailableMessage(packageRootFromRuntime()));
	// Limit V8 heap to 512MB for the background runner to avoid triggering the
	// Linux OOM killer. The runner itself is lightweight — it delegates work to
	// child Pi processes — so 512MB is generous. Without this limit, Node.js
	// defaults to ~1.5GB on 64-bit systems, which combined with jiti compilation
	// and child processes can exhaust system memory.
	const memoryLimit = "--max-old-space-size=512";
	// V8 diagnostic report on fatal error. A native heap-OOM abort or segfault
	// bypasses the JS process.on('exit') handler and console overrides
	// entirely — only a V8 report file survives such crashes. This is ON by
	// default precisely so silent runner deaths (like the explore→code-review
	// transition crash) leave a native stack/heap/environment trace. Users who
	// don't want report files can opt out with PI_CREW_BG_REPORT_ON_FATAL=0.
	const reportOn = !(process.env.PI_CREW_BG_REPORT_ON_FATAL === "0" || process.env.PI_TEAMS_BG_REPORT_ON_FATAL === "0");
	const reportDir = reportDirectory ?? path.dirname(runnerPath);
	const reportFlags = reportOn
		? ["--report-on-fatalerror", "--report-compact", `--report-directory=${reportDir}`]
		: [];
	if (loader.kind === "jiti") {
		return {
			args: [memoryLimit, ...reportFlags, "--trace-uncaught", "--import", pathToFileURL(loader.path).href, runnerPath, "--cwd", cwd, "--run-id", runId],
			loader: "jiti",
		};
	}
	return {
		args: [memoryLimit, ...reportFlags, "--experimental-strip-types", runnerPath, "--cwd", cwd, "--run-id", runId],
		loader: "strip-types",
	};
}

export interface SpawnBackgroundTeamRunResult {
	pid?: number;
	logPath: string;
}

/**
 * Env vars explicitly forwarded to the detached background runner.
 *
 * Provider API keys (MINIMAX/OPENAI/ANTHROPIC/...) are INTENTIONALLY OMITTED
 * (security review M1): the background runner only spawns child Pi workers,
 * which read keys from the Pi config file (not env). Passing keys via env
 * leaks them into V8 fatal-error reports (--report-on-fatalerror writes the
 * `environmentVariables` section unredacted). Matches child-pi.ts policy.
 * Exported so the invariant is unit-testable (test/unit/async-runner.test.ts).
 */
export const BACKGROUND_RUNNER_ENV_ALLOWLIST: string[] = [
	// Essential non-secret vars
	"PATH",
	"HOME",
	"USER",
	"SHELL",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	// Windows essentials — see WINDOWS_ESSENTIAL_ENV_VARS (src/utils/env-allowlist.ts).
	...WINDOWS_ESSENTIAL_ENV_VARS,
	"NVM_BIN",
	"NVM_DIR",
	"NVM_INC",
	"NODE_PATH",
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	// PI_CREW_PARENT_PID is needed for parent-guard (liveness check).
	"PI_CREW_DEPTH",
	"PI_CREW_MAX_DEPTH",
	"PI_CREW_INHERIT_PROJECT_CONTEXT",
	"PI_CREW_INHERIT_SKILLS",
	"PI_CREW_PARENT_PID",
	"PI_TEAMS_DEPTH",
	"PI_TEAMS_MAX_DEPTH",
	"PI_TEAMS_INHERIT_PROJECT_CONTEXT",
	"PI_TEAMS_INHERIT_SKILLS",
	"PI_TEAMS_PI_BIN",
	"PI_TEAMS_MOCK_CHILD_PI",
	"PI_CREW_ALLOW_MOCK",
	// Phase 1.5: worker-thread atomic writer opt-in (RFC 15).
	"PI_CREW_WORKER_ATOMIC_WRITER",
	"PI_TEAMS_WORKER_ATOMIC_WRITER",
	// Phase 1.5 #1: verification env sanitization opt-in (RFC 13 §6).
	"PI_CREW_VERIFICATION_SANITIZE_ENV",
	"PI_TEAMS_VERIFICATION_SANITIZE_ENV",
	"PI_CREW_VERIFICATION_PRESERVE_ENV",
	"PI_TEAMS_VERIFICATION_PRESERVE_ENV",
	// Phase 1.5 #2: verification git-worktree sandbox opt-in (RFC 16).
	"PI_CREW_VERIFICATION_WORKTREE",
	"PI_TEAMS_VERIFICATION_WORKTREE",
	// Phase 1.5 #3: V8 diagnostic report on fatal error (RFC 17 — investigation).
	"PI_CREW_BG_REPORT_ON_FATAL",
	"PI_TEAMS_BG_REPORT_ON_FATAL",
];

export async function spawnBackgroundTeamRun(manifest: TeamRunManifest): Promise<SpawnBackgroundTeamRunResult> {
	const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "background-runner.ts");
	const logPath = path.join(manifest.stateRoot, "background.log");
	fs.mkdirSync(manifest.stateRoot, { recursive: true });

	// SECURITY FIX: Use sanitizeEnvSecrets with same allow-list as child-pi.ts
	// to prevent leaking all env vars (including secrets) to detached background runner.
	// Previously, destructuring only removed PI_CREW_PARENT_PID but kept everything else.
	const filteredEnv = sanitizeEnvSecrets(process.env, {
		allowList: BACKGROUND_RUNNER_ENV_ALLOWLIST,
	});
	// FIX: removed delete workarounds — with explicit allowlist, these vars
	// are no longer auto-leaked. Matches child-pi.ts.

	// FIX (split-scope install): pass the resolved peer-dep dir to the child so
	// it can resolve @earendil-works/pi-coding-agent WITHOUT the ~200ms
	// `npm root -g` probe. No-op when pi-crew and pi are co-located. See
	// src/runtime/peer-dep.ts.
	const peerDepDir = resolvePeerDepDir();
	const childEnv = peerDepDir
		? { ...filteredEnv, [PEER_DEP_DIR_ENV]: peerDepDir }
		: filteredEnv;

	const loader = resolveTypeScriptLoader();
	if (!loader) {
		const message = buildLoaderUnavailableMessage(packageRootFromRuntime());
		appendEvent(manifest.eventsPath, { type: "async.failed", runId: manifest.runId, message });
		throw new Error(message);
	}
	// Pass manifest.stateRoot as report-directory so V8 fatal reports land
	// next to background.log (same dir) for easy post-mortem diagnosis.
	const command = getBackgroundRunnerCommand(runnerPath, manifest.cwd, manifest.runId, loader, manifest.stateRoot);
	fs.appendFileSync(logPath, `[pi-crew] background loader=${command.loader}\n`, "utf-8");

	// Spawn the background runner as a fully detached process with its own session.
	// BUG #17 FIX: setsid:true + detached:true creates a process that:
	//   1. Has its own session (SID = PID) — immune to terminal/SIGTERM signals
	//   2. Is detached (unref'd) — parent exit doesn't affect it
	//   3. Has its own process group (PGID = PID) — process group kills don't reach it
	//
	// IMPORTANT: session_shutdown handlers must NOT kill async runners.
	// See register.ts cleanupRuntime — the kill loop was commented out.
	// Type assertion for setsid is necessary because Node.js types don't include it
	// in SpawnOptions on all platforms, but it's supported on Unix systems.
	// Use explicit cast through unknown to satisfy TypeScript's strict type checking.
	const spawnOpts = {
		cwd: manifest.cwd,
		detached: true,
		setsid: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: childEnv,
		windowsHide: true,
	} as unknown as Parameters<typeof spawn>[2];
	const child = spawn(process.execPath, command.args, spawnOpts);
	// Round 27 (BUG 3) history: the piped stdout/stderr were previously destroyed
	// immediately to avoid a pipe-buffer deadlock (child writes >64KB with nobody
	// draining → hang). BUT destroying stderr ALSO swallowed native crash
	// messages: a V8 heap-OOM abort() or segfault writes its diagnostic directly
	// to the process stderr fd, which was the (now-destroyed) pipe read-end, so
	// the bytes vanished — making runner deaths completely silent. This caused
	// the explore→code-review transition crash to leave zero trace.
	//
	// FIX: keep stdout destroyed (unused — runner redirects its own console to
	// a file), but DRAIN stderr asynchronously into background.log with a
	// "[child stderr]" prefix. Buffer is capped to avoid unbounded memory if a
	// noisy child streams megabytes; excess is dropped with a truncation marker.
	child.stdout?.destroy();
	const STDERR_CAPTURE_LIMIT = 256 * 1024;
	const stderrChunks: Buffer[] = [];
	let stderrLen = 0;
	let stderrTruncated = false;
	const flushStderr = (): void => {
		if (stderrChunks.length === 0) return;
		let body: string;
		try {
			body = Buffer.concat(stderrChunks).toString("utf-8");
		} catch {
			stderrChunks.length = 0;
			return;
		}
		stderrChunks.length = 0;
		try {
			fs.appendFileSync(logPath, `[child stderr] ${body}${body.endsWith("\n") ? "" : "\n"}`, "utf-8");
		} catch {
			/* best-effort */
		}
	};
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderrLen + chunk.length > STDERR_CAPTURE_LIMIT) {
			if (!stderrTruncated) {
				stderrTruncated = true;
				try {
					fs.appendFileSync(logPath, `[child stderr truncated at ${STDERR_CAPTURE_LIMIT} bytes]\n`, "utf-8");
				} catch {
					/* best-effort */
				}
			}
			return;
		}
		stderrChunks.push(chunk);
		stderrLen += chunk.length;
	});
	child.stderr?.on("end", flushStderr);
	child.stderr?.on("close", flushStderr);
	child.on("error", (error: Error) => {
		logInternalError("async-runner.spawn", error, `pid=${child.pid ?? "unknown"}`);
	});
	child.unref();

	// Track this worker in the orphan registry so it can be killed on
	// session_start of a future session if the parent pi process is killed.
	if (child.pid) {
		registerWorker(
			child.pid,
			manifest.ownerSessionId ?? "unknown",
			manifest.runId,
			process.pid, // parentPid — used by cleanup to verify session is dead
		);
		// Best-effort: unregister when child exits. Background-runner writes
		// the marker file before it dies, so we unregister on the next
		// cleanup tick. But the child "exit" event won't fire because we
		// unref'd and the stdio is piped + ignored.
	}

	return { pid: child.pid, logPath };
}

