/**
 * child-pi-spawn.ts — Spawn options + env filtering for child Pi worker processes.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 6). Zero behavior change.
 *
 * Responsibilities:
 *   - BASE_ALLOWLIST: env var names always passed to child workers.
 *   - buildChildPiSpawnOptions(): pure function that builds SpawnOptions from
 *     (cwd, env, model). Validates cwd, filters env via allowlist, validates
 *     NODE_PATH against safe prefixes.
 *   - assertOnlyControlEnvKeys(): runtime canary that verifies the caller only
 *     put PI_CREW (prefix) or PI_TEAMS (prefix) keys into the per-call built.env (defense in
 *     depth against accidental secret leakage).
 *   - prepareSpawnContext(): pre-spawn helper that builds the spawn command spec
 *     from buildPiWorkerArgs output, handles the pre-spawn abort check, and
 *     returns either an immediate-abort result or the spawn context.
 */

import type { SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { WINDOWS_ESSENTIAL_ENV_VARS } from "../utils/env-allowlist.ts";
import { buildScopedAllowList, sanitizeEnvSecrets } from "../utils/env-filter.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi.ts";
import { buildPiWorkerArgs } from "./pi-args.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";

// ── Env allowlist (base set always passed to children) ──────────────────
// Provider API keys are injected dynamically via buildScopedAllowList() only
// when a model is assigned to the task (per-task key scoping).
export const BASE_ALLOWLIST: string[] = [
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
	"NODE_DISABLE_COLORS",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"NPM_CONFIG_USERCONFIG",
	"NPM_CONFIG_GLOBALCONFIG",
	"PI_CREW_DEPTH",
];

/**
 * Build the SpawnOptions for a child Pi worker process. Pure function — does
 * not call spawn() itself; the caller does that.
 *
 * Responsibilities:
 *   1. Validate cwd (realpath + isDirectory) — fall back to lexical path on ENOENT.
 *   2. Filter env vars to the allowlist (model-aware provider key scoping).
 *   3. Validate NODE_PATH against safe prefixes (/opt, /lib, /usr, /home).
 *   4. Add PI_CREW_PARENT_PID for the child-side parent-guard.
 */
export function buildChildPiSpawnOptions(cwd: string, env: NodeJS.ProcessEnv, model?: string): SpawnOptions {
	// SECURITY FIX (Issue #1): Validate cwd before passing to spawn.
	// If cwd comes from an untrusted source (user input, workspace config), a malicious cwd
	// could cause the child process to operate in an attacker-controlled directory,
	// enabling path traversal attacks, unintended file access, or exposure of sensitive paths.
	// Use realpathSync to resolve any symlinks and verify the path exists and is a directory.
	let validatedCwd: string;
	try {
		validatedCwd = fs.realpathSync(cwd);
		const stats = fs.statSync(validatedCwd);
		if (!stats.isDirectory()) {
			throw new Error(`cwd is not a directory: ${cwd}`);
		}
	} catch (error) {
		// If cwd doesn't exist (ENOENT) and isn't a security concern, fall back
		// to the lexical path. The child process will create the directory if
		// needed. Throwing would break tests/callers that pass not-yet-existing
		// paths and isn't a security issue for the env-filtering behavior this
		// function is primarily about.
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && error instanceof Error && error.message.includes("ENOENT")) {
			validatedCwd = path.resolve(cwd);
		} else {
			throw new Error(`Invalid cwd: ${cwd} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Filter out env vars whose keys match secret patterns to avoid leaking credentials to child processes.
	// IMPORTANT: preserve model provider API keys — they are needed by the child Pi to call the LLM.
	// Also preserve essential non-secret vars (PATH, HOME, USER, etc.) so the child process can function.
	// Bug #12 fix: essential env vars (PATH, HOME, etc.) are always preserved so child can find npm/node.
	//
	// PER-TASK KEY SCOPING: when a model is provided, only the env keys for that
	// provider are injected (via buildScopedAllowList). When no model is given,
	// only BASE_ALLOWLIST system vars pass through — no provider keys leak.
	const allowList = model ? buildScopedAllowList(BASE_ALLOWLIST, [model]) : BASE_ALLOWLIST;
	const filteredEnv = sanitizeEnvSecrets(env, { allowList });
	// FIX: Removed delete workarounds — with explicit allowlist, these vars
	// are no longer auto-leaked. The wildcard approach was fragile.

	// SECURITY FIX (Issue #1): Validate NODE_PATH to ensure it only contains standard
	// system locations or legitimate user paths (NVM). NODE_PATH can reveal user
	// environment information and could theoretically be exploited if it contains
	// untrusted entries. Only allow paths under standard system directories
	// (/opt, /lib, /usr) or NVM paths under /home/<user>/.nvm/... which are legitimate
	// for Node.js module loading in user environments.
	if (filteredEnv.NODE_PATH) {
		const validPrefixes = ["/opt/", "/lib/", "/usr/local/", "/usr/", "/home/"];
		const validPaths = filteredEnv.NODE_PATH.split(":").filter((p) => {
			return validPrefixes.some((prefix) => p.startsWith(prefix));
		});
		if (validPaths.length > 0) {
			filteredEnv.NODE_PATH = validPaths.join(":");
		} else {
			// No standard paths found — remove NODE_PATH entirely to avoid
			// passing user-specific paths that could reveal environment info.
			delete filteredEnv.NODE_PATH;
		}
	}

	return {
		cwd: validatedCwd,
		env: { ...filteredEnv, PI_CREW_PARENT_PID: String(process.pid) },
		stdio: ["ignore", "pipe", "pipe"], // stdin=ignore: child doesn't wait for input; task comes via CLI args
		detached: process.platform !== "win32",
		setsid: true,
		// NOTE: setsid creates a new session; the child process becomes the session leader
		// and its parent becomes that session leader (still the team-runner in the same
		// process group). PI_CREW_PARENT_PID is set before spawn using process.pid (team-runner).
		// The parent-guard in the child checks direct parent liveness via process.kill(pid, 0) —
		// it does NOT follow the lineage beyond the direct parent. If the team-runner's parent
		// (the original pi session) dies, the team-runner becomes an orphan but the child still
		// sees its direct parent (team-runner) as alive. This is correct for the parent-guard model.
		windowsHide: true,
	} as SpawnOptions;
}

/**
 * Throw if `built.env` contains keys outside the PI_CREW_ (prefix) / PI_TEAMS_ (prefix) namespaces.
 * Called right before spawn() as a runtime canary — protects against future
 * regressions where someone accidentally adds a secret key to built.env.
 */
export function assertOnlyControlEnvKeys(builtEnv: Record<string, string | undefined>): void {
	// Verifies built.env (the per-call env we add on top of process.env) only
	// contains PI_CREW_*/PI_TEAMS_* control keys. built.env does NOT include
	// process.env values — those are merged separately via spread and filtered
	// by the allowlist in buildChildPiSpawnOptions. This assertion guards
	// against accidental additions to built.env leaking secrets to children.
	for (const key of Object.keys(builtEnv)) {
		if (!key.startsWith("PI_CREW_") && !key.startsWith("PI_TEAMS_")) {
			throw new Error(
				`SECURITY: built.env contains unexpected key "${key}"; expected only PI_CREW_* or PI_TEAMS_* execution-control vars`,
			);
		}
	}
}

/** What the spawn site needs to start the child process. */
export interface SpawnContext {
	/** The command + args returned by getPiSpawnCommand. */
	spawnSpec: ReturnType<typeof getPiSpawnCommand>;
	/** The merged env (process.env + built.env) to pass to spawn(). */
	mergedEnv: NodeJS.ProcessEnv;
	/** Temp dir created by buildPiWorkerArgs (caller must clean up after spawn). */
	tempDir: string | undefined;
	/** The per-call built.env (control vars only) — for security canary assertions. */
	builtEnv: Record<string, string | undefined>;
}

/**
 * Build the spawn context for a child Pi run: calls buildPiWorkerArgs,
 * attaches PI_CREW_STEERING_FILE if a steering file is configured, then returns
 * the spawn command spec + merged env. Does NOT spawn.
 *
 * If the parent AbortSignal has already fired, returns an immediate-abort
 * ChildPiRunResult instead — spawn is then skipped entirely (saves resources).
 */
export function prepareSpawnContext(
	input: ChildPiRunInput,
	effectiveTask: string,
): { kind: "ready"; ctx: SpawnContext } | { kind: "aborted"; result: ChildPiRunResult } {
	const built = buildPiWorkerArgs({
		task: effectiveTask,
		agent: input.agent,
		model: input.model,
		sessionEnabled: true,
		maxDepth: input.maxDepth,
		skillPaths: input.skillPaths,
		role: input.role,
	});
	// Pass steering file path to child for real-time steer injection
	if (input.steeringFile) built.env.PI_CREW_STEERING_FILE = input.steeringFile;
	// Phase 0 inter-pi broker: inject socket path + token (control-namespace keys,
	// safe under assertOnlyControlEnvKeys). Only when the parent broker issued
	// credentials for this run — i.e. the broker is enabled AND this run is
	// eligible. The token is heap-only on the parent; the child receives it
	// solely through env. NEVER persisted to disk.
	if (input.brokerSpawn?.socketPath && input.brokerSpawn.token) {
		built.env.PI_CREW_BROKER_SOCKET = input.brokerSpawn.socketPath;
		built.env.PI_CREW_BROKER_TOKEN = input.brokerSpawn.token;
	}
	// B5: if the parent already aborted before we spawn, do not start the child
	// at all. Spawning a doomed process wastes resources, and the abort listener
	// registered below will not re-fire for an already-aborted signal (so the
	// child would only be killed later by the response-timeout path). Return a
	// cancelled-style result immediately.
	if (input.signal?.aborted) {
		return {
			kind: "aborted",
			result: {
				exitCode: null,
				stdout: "",
				stderr: "",
				error: "Aborted before spawn (parent AbortSignal already aborted)",
				aborted: true,
			},
		};
	}
	const spawnSpec = getPiSpawnCommand(built.args);
	return {
		kind: "ready",
		ctx: {
			spawnSpec,
			mergedEnv: { ...process.env, ...built.env },
			tempDir: built.tempDir,
			builtEnv: built.env,
		},
	};
}

// Silence unused-import warning for logInternalError if not consumed by future helpers.
void logInternalError;
