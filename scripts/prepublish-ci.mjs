#!/usr/bin/env node
/**
 * prepublish-ci.mjs — `prepublishOnly` wrapper that runs `npm run ci` with a
 * CLEAN crew environment (v0.11.39, bug class "publish from inside a crew
 * worker reports phantom failures").
 *
 * WHY THIS EXISTS
 * ---------------
 * `prepublishOnly` used to be plain `npm run ci`. That is correct on a normal
 * developer shell and on the GitHub runners, but WRONG when the publish is
 * driven from inside a pi-crew worker: the worker harness exports its own
 * control plane into the environment —
 *   PI_CREW_SCRATCHPAD, PI_CREW_TASK_ID, PI_CREW_ATTEMPT, PI_CREW_ARTIFACTS_ROOT,
 *   PI_CREW_DEPTH, PI_CREW_EVENTS_PATH, PI_CREW_BROKER_*, PI_TEAMS_DEPTH, …
 * — and the test suite (correctly) asserts those are ABSENT in child-pi spawns.
 * Running `npm run ci` with them inherited made ~27 tests fail for reasons that
 * have nothing to do with the tree being published (see the recurring
 * "Test env gotcha" entries in .crew/knowledge.md). The failure mode is nasty
 * in both directions: a real regression gets lost in 27 expected failures, and
 * a clean tree can be blocked from publishing.
 *
 * So: this wrapper clones `process.env`, DELETES every key whose name starts
 * with `PI_CREW_` or `PI_TEAMS_`, and spawns `npm run ci` with that scrubbed
 * environment. Inherited stdio keeps the CI log in the publisher's terminal;
 * the child exit code (or a kill signal) propagates to `npm publish`, so a red
 * gate still blocks the release.
 *
 * DELIBERATE EXCEPTION: `PI_CREW_TEST_NO_HOME_ISOLATION` is preserved verbatim.
 * It is an opt-out knob for the test suite's HOME isolation, not run control
 * plane, and some sandboxes (no writable HOME) NEED it set for the suite to run
 * at all. Scrubbing it would turn a working gate into a broken one.
 *
 * NOT scrubbed, on purpose: `npm_config_*`, `npm_execpath`, `PATH`, `HOME`, …
 * npm itself needs them, and the test suite does not assert on them.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Env prefixes owned by the crew runtime — never forwarded into the gate. */
export const CREW_ENV_PREFIXES = ["PI_CREW_", "PI_TEAMS_"];

/**
 * Crew-prefixed keys that must SURVIVE the scrub: test-suite knobs and the
 * battery's own explicit-skip flag (not runtime control plane) that a
 * sandboxed environment may legitimately need.
 *
 * `PI_CREW_BATTERY_SKIP` (2026-10-28, cold-verify fix): when the battery
 * fails on a host without a `pi` binary it tells the caller to set exactly
 * this variable — but the npm path (prepublish-ci → battery) scrubbed it,
 * so the documented escape hatch was dead. Preserve it verbatim; the
 * battery records the skip in its audit trail either way.
 */
export const PRESERVED_CREW_ENV_KEYS = ["PI_CREW_TEST_NO_HOME_ISOLATION", "PI_CREW_BATTERY_SKIP"];

const SELF = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SELF), "..");

/**
 * Return a copy of `env` with every `PI_CREW_*` / `PI_TEAMS_*` key removed,
 * except the explicitly preserved test-suite knobs. Everything else is copied
 * verbatim (npm, PATH, HOME and friends are required by the child).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function scrubCrewEnv(env = process.env) {
	/** @type {NodeJS.ProcessEnv} */
	const clean = {};
	for (const [key, value] of Object.entries(env)) {
		const crewOwned = CREW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
		if (crewOwned && !PRESERVED_CREW_ENV_KEYS.includes(key)) continue;
		clean[key] = value;
	}
	return clean;
}

/**
 * How to invoke npm as a child process.
 *
 * `child_process.spawn` does NOT do PATHEXT resolution on Windows (only
 * exec/execSync via cmd.exe do) — see src/runtime/pi-spawn.ts. So a bare
 * `spawn("npm")` is an ENOENT on win32. Prefer `npm_execpath` (npm sets it for
 * every lifecycle script, including `prepublishOnly`) and run it with the same
 * node binary; fall back to cmd.exe for win32 and to PATH elsewhere.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ command: string, args: string[] }}
 */
export function npmInvocation(env = process.env) {
	const execpath = env.npm_execpath;
	if (execpath && /\.(?:cjs|mjs|js)$/i.test(execpath) && fs.existsSync(execpath)) {
		return { command: process.execPath, args: [execpath] };
	}
	if (process.platform === "win32") {
		const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
		return { command: comspec, args: ["/d", "/s", "/c", "npm"] };
	}
	return { command: "npm", args: [] };
}

/**
 * Spawn `command` with a scrubbed environment and resolve when it exits.
 *
 * `stdio: "inherit"` (default) streams straight to the publisher's terminal —
 * the CI log must stay visible. Any other value pipes stdout/stderr back so
 * tests can assert on the child's view of the environment.
 *
 * @param {{ command: string, args?: string[], env?: NodeJS.ProcessEnv, cwd?: string, stdio?: "inherit" | "pipe" }} options
 * @returns {Promise<{ code: number, signal: NodeJS.Signals | null, stdout: string, stderr: string }>}
 */
export function runWithCleanEnv({ command, args = [], env = process.env, cwd = REPO_ROOT, stdio = "inherit" }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env: scrubCrewEnv(env),
			stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			// Spawn failure (npm not found, EACCES) — non-zero, never a silent 0.
			resolve({ code: 1, signal: null, stdout, stderr: `${stderr}${error.message}\n` });
		});
		child.on("close", (code, signal) => {
			// A killed child has code === null; treat it as failure.
			resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr });
		});
	});
}

/**
 * Run the pre-publish battery (live real-Pi gate — scripts/pre-publish-battery.mjs,
 * wired here since the v0.11.46/0.11.47 silent-worker incident) and THEN
 * `npm run ci` (overridable for tests), both with the scrubbed environment.
 * Battery first: it fails in ~2-4 min (incl. the T7 live smoke) while the
 * full CI gate takes ~15 — fail fast preserves the publisher's attention.
 *
 * @param {{ env?: NodeJS.ProcessEnv, npmArgs?: string[] }} [options]
 * @returns {Promise<number>} exit code to propagate to `npm publish`
 */
export async function main({ env = process.env, npmArgs = ["run", "ci"] } = {}) {
	const battery = await runWithCleanEnv({ command: process.execPath, args: [path.join(path.dirname(SELF), "pre-publish-battery.mjs")], env });
	if (battery.code !== 0) {
		console.error("prepublish-ci: pre-publish BATTERY RED — publish blocked before the CI gate ran.");
		return battery.code;
	}
	const invocation = npmInvocation(env);
	const { code } = await runWithCleanEnv({ command: invocation.command, args: [...invocation.args, ...npmArgs], env });
	return code;
}

/**
 * ENTRY-POINT GUARD (cross-platform): comparing `import.meta.url` against a
 * URL string hand-built by prefixing the file scheme onto argv[1] is true only
 * on POSIX — on Windows (D:\a\repo\scripts\x.mjs) it is never true, so
 * `main()` would silently never run. Same class as the v0.11.38
 * check-slop-rules fix; see test/unit/scripts/main-guard-platform-safety.test.ts
 * (whose scanner is a line regex, so this prose deliberately avoids spelling
 * the antipattern out).
 */
const isEntryPoint = (() => {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
	} catch {
		// Vanished/oddly-shaped path — fall back to a lexical compare so this
		// gate can never silently become a no-op.
		return pathToFileURL(process.argv[1]).href === import.meta.url || path.resolve(process.argv[1]) === path.resolve(SELF);
	}
})();

if (isEntryPoint) {
	main().then(
		(code) => {
			if (code !== 0) process.exitCode = code;
		},
		(error) => {
			console.error(`prepublish-ci: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		},
	);
}
