/**
 * v0.11.36 OS-boundary sandbox (Linux opt-in, bubblewrap).
 *
 * WHAT IT IS: an optional bwrap (bubblewrap) wrapper around headless child-pi
 * workers that closes the HOST-FILE hole the env layer cannot — a sandboxed
 * worker sees ONLY: the project cwd (read-write — it must edit files), its
 * scoped inference agent dir, explicitly handed-in temp/scratch paths, and
 * the OS runtime (/usr, /etc, /dev, /proc as read-only mounts + tmpfs /tmp,
 * /run). Everything else on the host — ~/.pi/auth.json, ~/.ssh, dotfiles,
 * browser profiles — is simply NOT MOUNTED into the namespace. Fail-closed:
 * a path we forgot to bind yields ENOENT inside the sandbox, never silent
 * host access.
 *
 * WHAT IT IS NOT (honest boundary, pass 1):
 * - Egress isolation: `PI_CREW_SANDBOX_NET=off` unshares the network stack
 *   entirely (nothing reachable — including the loopback inference broker),
 *   which is why net=off is REJECTED while the inference broker is active.
 *   The default `share` profile keeps host networking: a worker with a
 *   broker token can still open outbound connections to the internet.
 * - TUI surface panes and the rpc transport are NOT sandboxed (pass 1): when
 *   the sandbox is enabled both branches are skipped so every worker takes
 *   the sandboxed headless path (fail-closed, never fail-open).
 *
 * FAIL-CLOSED CONTRACT: every misconfiguration throws BEFORE any spawn —
 * unsupported value, non-Linux platform, missing bwrap binary, or the
 * net=off + broker contradiction. A sandbox that cannot start must never
 * silently degrade to an unsandboxed spawn.
 */
import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SANDBOX_ENV = "PI_CREW_SANDBOX";
export const SANDBOX_NET_ENV = "PI_CREW_SANDBOX_NET";

export interface SandboxConfig {
	enabled: boolean;
	mode: "off" | "bwrap";
	/** "share" keeps host networking (inference broker reachable); "off" unshares the net stack entirely. */
	net: "share" | "off";
}

/** Resolve + VALIDATE the sandbox knobs. Throws fail-closed on any misconfiguration (never silently unsandboxed). */
export function resolveSandboxConfig(env: NodeJS.ProcessEnv, opts: { platform: NodeJS.Platform; brokerActive: boolean }): SandboxConfig {
	const raw = (env[SANDBOX_ENV] ?? "").trim();
	if (raw === "" || raw === "0") return { enabled: false, mode: "off", net: "share" };
	if (raw !== "bwrap") {
		throw new Error(
			`${SANDBOX_ENV}: unsupported value '${raw}' (supported: 'bwrap') — fail-closed: refusing to spawn with an unrecognized sandbox mode`,
		);
	}
	const netRaw = (env[SANDBOX_NET_ENV] ?? "share").trim().toLowerCase();
	if (netRaw !== "share" && netRaw !== "off") {
		throw new Error(
			`${SANDBOX_NET_ENV}: unsupported value '${netRaw}' (supported: 'share' | 'off') — fail-closed: refusing to spawn with an unrecognized network profile`,
		);
	}
	if (netRaw === "off" && opts.brokerActive) {
		throw new Error(
			`${SANDBOX_NET_ENV}=off is incompatible with the inference broker: a new network namespace has no loopback route to the 127.0.0.1 broker, so broker-token workers would be keyless AND netless. Either keep ${SANDBOX_NET_ENV}=share or unset ${SANDBOX_ENV}/PI_CREW_INFERENCE_BROKER.`,
		);
	}
	return { enabled: true, mode: "bwrap", net: netRaw };
}

/** Binary/platform gate. Throws when a bwrap sandbox cannot be honored (fail-closed). */
export function assertSandboxAvailable(
	config: SandboxConfig,
	deps: {
		platform: NodeJS.Platform;
		spawnSync: (cmd: string, args: string[], opts?: SpawnSyncOptions) => SpawnSyncReturns<string> | { error: unknown; status: null };
	} = {
		platform: process.platform,
		spawnSync: (cmd, args, opts) => spawnSync(cmd, args, opts) as SpawnSyncReturns<string>,
	},
): void {
	if (!config.enabled) return;
	if (deps.platform !== "linux") {
		throw new Error(
			`${SANDBOX_ENV}=bwrap is Linux-only (bubblewrap user namespaces); current platform is ${deps.platform} — fail-closed: refusing to spawn unsandboxed`,
		);
	}
	const probe = deps.spawnSync("bwrap", ["--version"], { timeout: 5000 });
	if (probe.error || probe.status !== 0) {
		throw new Error(
			`${SANDBOX_ENV}=bwrap requires the 'bwrap' binary (bubblewrap) on PATH — not runnable here (fail-closed: refusing to spawn unsandboxed). Install bubblewrap or unset ${SANDBOX_ENV}.`,
		);
	}
}

export interface SandboxWrapInput {
	/** Project dir — mounted read-write (the worker's whole job is editing it). */
	cwd: string;
	/** "share" keeps host networking (inference broker reachable); "off" unshares the net stack entirely. */
	net: "share" | "off";
	/** Scoped inference agent dir (models.json only) — mounted read-write (pi may write session state under it). */
	agentDir?: string;
	/** Parent-side paths the worker must READ (task.md tempDir, scratchpad snapshot/restore, steering file). */
	roBindPaths?: string[];
	/** Parent-side paths the worker must reach read-write (inter-pi broker socket — connect() needs write permission). */
	rwBindPaths?: string[];
	/** Package-root detector for resource walks (injectable to keep applySandboxToSpawnSpec pure in tests). */
	isPackageRoot?: (dir: string) => boolean;
}

/** Toolchain mounts a wrapped spec needs (deduped):
 * - the runtime bin dir (nvm/homebrew node lives outside /usr),
 * - for the entry script (.js arg 0): its dir + every ancestor `node_modules`
 *   (ESM/CJS resolution walks them for the SDK's external deps),
 * - for every `--extension`/`--skill` value: the value + ancestor dirs up to
 *   and including the nearest package root (extensions import siblings
 *   across their package: prompt-runtime.ts reaches ../config, ../state …).
 */
function toolchainBinds(spec: { command: string; args: string[] }, isPackageRoot: (dir: string) => boolean): string[] {
	const binds = new Set<string>();
	if (path.isAbsolute(spec.command)) binds.add(path.dirname(spec.command));
	const entry = spec.args[0];
	if (entry && path.isAbsolute(entry) && entry.endsWith(".js")) {
		binds.add(path.dirname(entry));
		for (let dir = path.dirname(path.dirname(entry)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
			if (path.basename(dir) === "node_modules") binds.add(dir);
		}
	}
	// --extension / --skill resources: bind the value + ancestors up to the
	// nearest package root (extensions import across their package tree) —
	// but NEVER at or above the user trust boundary. User-global skill roots
	// (~/.pi/agent/skills — the default pi user-skill location) have NO
	// package.json ancestor before $HOME, so an uncapped walk climbed all the
	// way up and emitted `--ro-bind-try $HOME $HOME` (plus `~/.pi/agent`, the
	// auth.json directory), mounting the whole host home — credentials
	// included — read-only inside the sandbox. The walk now stops BELOW the
	// pi agent dir / $HOME, and a value that would mount the home, the agent
	// dir, or any ancestor containing either is SKIPPED entirely (fail-closed
	// ENOENT inside the sandbox — never a HOME bind).
	const home = os.homedir();
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
	// Protect the DEFAULT agent dir too: a PI_CODING_AGENT_DIR override moves
	// the effective dir, but ~/.pi/agent keeps holding real credentials on
	// default installs — fail closed for both locations.
	const trustBoundaries = [home, agentDir, path.join(home, ".pi", "agent")];
	for (let i = 0; i < spec.args.length - 1; i++) {
		const flag = spec.args[i];
		if (flag !== "--extension" && flag !== "--skill") continue;
		const value = spec.args[i + 1];
		if (!value || !path.isAbsolute(value)) continue;
		if (crossesUserTrustBoundary(value, trustBoundaries)) continue;
		binds.add(value);
		for (let dir = path.dirname(value); dir !== path.dirname(dir); dir = path.dirname(dir)) {
			// never climb at/above the user trust boundary: the pi agent dir
			// (auth.json!) and the home dir itself stay unmounted
			if (crossesUserTrustBoundary(dir, trustBoundaries)) break;
			binds.add(dir);
			if (isPackageRoot(dir)) break;
		}
	}
	return [...binds];
}

/**
 * True when binding `dir` would mount a trust boundary itself or any
 * ancestor CONTAINING one (e.g. `dir` == $HOME, ~/.pi, /home, or /) — the
 * caller must skip/break (fail closed) instead of binding. Comparison goes
 * through path.relative, which is case-insensitive on win32.
 */
function crossesUserTrustBoundary(dir: string, boundaries: string[]): boolean {
	for (const boundary of boundaries) {
		const rel = path.relative(dir, boundary);
		// rel === "" → dir IS the boundary; a rel that stays inside dir (no
		// ".." prefix, not absolute) → the boundary lives UNDER dir, so
		// binding dir would mount it.
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

/** Default package-root probe: a directory carrying package.json (extensions import across their package tree). */
function defaultIsPackageRoot(dir: string): boolean {
	try {
		return fs.statSync(path.join(dir, "package.json")).isFile();
	} catch {
		return false;
	}
}

/**
 * Wrap a spawn spec in a bwrap invocation. Unit-testable on every platform
 * (inject isPackageRoot to avoid IO); ordering matters: --tmpfs /tmp precedes
 * any bind under /tmp so parent temp paths surface at their REAL paths.
 */
export function applySandboxToSpawnSpec(
	spec: { command: string; args: string[] },
	wrap: SandboxWrapInput,
): { command: string; args: string[]; envOverrides: Record<string, string> } {
	const args: string[] = [
		"--unshare-all",
		// net=share: re-share host networking AFTER --unshare-all (the
		// inference broker lives on host loopback). net=off leaves the new
		// netns fully isolated — nothing reachable, broker included.
		...(wrap.net === "share" ? ["--share-net"] : []),
		"--die-with-parent",
		"--new-session",
		"--ro-bind",
		"/usr",
		"/usr",
		"--ro-bind-try",
		"/etc",
		"/etc",
		"--ro-bind-try",
		"/bin",
		"/bin",
		"--ro-bind-try",
		"/lib",
		"/lib",
		"--ro-bind-try",
		"/lib64",
		"/lib64",
		"--ro-bind-try",
		"/sbin",
		"/sbin",
		// TOOLCHAIN: the wrapped command is usually process.execPath — which on
		// developer machines lives OUTSIDE /usr (nvm: ~/.nvm/.../bin/node,
		// homebrew: /opt/homebrew/...). Without mounting its directory the
		// sandbox cannot even exec the runtime (bwrap: execvp ENOENT — found by
		// the real-smoke test on this very machine). The node bin dir is
		// toolchain, not user data — same class as /usr.
		//
		// The pi bundle entry (spec.args[0] when an absolute .js file) brings its
		// OWN tree: the bundle dir has sibling chunks/runtime files, and ESM/CJS
		// resolution walks every ancestor `node_modules` for the SDK's external
		// deps (jiti/yaml/...). Bind the entry DIR + each ancestor named
		// node_modules, READ-ONLY — dependency trees are toolchain, not user data.
		...toolchainBinds(spec, wrap.isPackageRoot ?? defaultIsPackageRoot).flatMap((p) => ["--ro-bind-try", p, p]),
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		// Project dir read-write at its real path (mount order guarantees this
		// wins over any ancestor tmpfs).
		"--bind",
		wrap.cwd,
		wrap.cwd,
	];
	if (wrap.agentDir) {
		args.push("--bind", wrap.agentDir, wrap.agentDir);
	}
	for (const p of wrap.roBindPaths ?? []) {
		args.push("--ro-bind-try", p, p);
	}
	for (const p of wrap.rwBindPaths ?? []) {
		args.push("--bind-try", p, p);
	}
	args.push("--chdir", wrap.cwd, "--", spec.command, ...spec.args);
	// HOME/TMPDIR point at the sandbox tmpfs: the worker's writes land in
	// scratch space, and ~/.pi (auth.json!) simply does not exist inside.
	return { command: "bwrap", args, envOverrides: { HOME: "/tmp", TMPDIR: "/tmp" } };
}
