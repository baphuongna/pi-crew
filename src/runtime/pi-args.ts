import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agent-config.ts";
import { getAgentSessionOptions } from "../agents/agent-config.ts";
import { userPiRoot } from "../utils/paths.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const PROMPT_RUNTIME_EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompt", "prompt-runtime.ts");
const TASK_ARG_LIMIT = 8000;
const DEFAULT_MAX_CREW_DEPTH = 2;

// Track every temp dir created in this process so we can clean them up
// even if the parent is killed before child-pi.ts cleanup runs.
// Prevents accumulation of /tmp/pi-crew-* dirs from crashed/killed tests.
const createdTempDirs = new Set<string>();

/**
 * Resolve the temp-dir base path.
 * Uses pi-crew's own user-root (`~/.pi/agent/pi-crew/tmp/`) so the temp
 * files live alongside other pi-crew state and never pollute the shared
 * /tmp directory. Uses `userPiRoot()` so the path stays consistent with
 * the rest of pi-crew (respects PI_TEAMS_HOME / PI_CODING_AGENT_DIR).
 */
function getPiTempBase(): string {
	return path.join(userPiRoot(), "tmp");
}

export interface BuildPiWorkerArgsInput {
	task: string;
	agent: AgentConfig;
	model?: string;
	sessionEnabled?: boolean;
	maxDepth?: number;
	skillPaths?: string[];
	env?: NodeJS.ProcessEnv;
	/** Role for tool restrictions (uses role-tools.ts config) */
	role?: string;
}

export interface BuildPiWorkerArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

function isValidThinkingLevel(value: string | undefined): value is string {
	return value !== undefined && THINKING_LEVELS.includes(value);
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && isValidThinkingLevel(model.substring(colonIdx + 1))) return model;
	// Invalid config values fall back to Pi's default thinking behavior.
	if (!isValidThinkingLevel(thinking)) return model;
	return `${model}:${thinking}`;
}

export function currentCrewDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CREW_DEPTH ?? env.PI_TEAMS_DEPTH ?? "0";
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function resolveCrewMaxDepth(inputMaxDepth?: number, env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_CREW_MAX_DEPTH ?? env.PI_TEAMS_MAX_DEPTH;
	const envDepth = raw !== undefined ? Number(raw) : NaN;
	if (Number.isInteger(envDepth) && envDepth >= 1 && envDepth <= 10) return envDepth;
	if (Number.isInteger(envDepth) && envDepth > 10) {
		console.warn(`PI_CREW_MAX_DEPTH=${envDepth} exceeds cap of 10, clamping to 10. Set 10 or lower to avoid this warning.`);
		return 10;
	}
	if (Number.isInteger(inputMaxDepth) && inputMaxDepth !== undefined && inputMaxDepth >= 1 && inputMaxDepth <= 10) return inputMaxDepth;
	if (Number.isInteger(inputMaxDepth) && inputMaxDepth !== undefined && inputMaxDepth > 10) {
		console.warn(`maxDepth=${inputMaxDepth} exceeds cap of 10, clamping to 10. Set 10 or lower to avoid this warning.`);
		return 10;
	}
	return DEFAULT_MAX_CREW_DEPTH;
}

export function checkCrewDepth(inputMaxDepth?: number, env: NodeJS.ProcessEnv = process.env): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = currentCrewDepth(env);
	const maxDepth = resolveCrewMaxDepth(inputMaxDepth, env);
	return { depth, maxDepth, blocked: depth >= maxDepth };
}

/**
 * Create a safe temp directory with symlink protection.
 * 1. mkdtempSync to create the directory
 * 2. lstatSync to verify it is not a symlink (TOCTOU safety)
 * 3. realpathSync to resolve the canonical path
 */
/**
 * Create a temp dir with symlink-safety checks. Tracked in the
 * `createdTempDirs` Set for global cleanup.
 *
 * Exported (rather than module-private) so unit tests can populate
 * the tracking Set without going through the public build flow.
 */
export function createSafeTempDir(base: string, prefix: string): string {
	// FIX: Walk FULL ancestor chain for symlinks BEFORE creating any directories.
	// An attacker could plant a symlink at any ancestor of base (e.g.,
	// making /home/bom/.pi -> /tmp/attacker). Walk from root to base
	// and verify no component is a symlink. Only THEN create base if needed.
	const absoluteBase = path.resolve(base);
	const parts = absoluteBase.split(path.sep);
	let accumulated = "";
	if (parts[0] === "") accumulated = "/"; // Unix root
	for (let i = 1; i < parts.length; i++) {
		if (parts[i] === "") continue;
		accumulated = path.join(accumulated, parts[i]);
		try {
			const stat = fs.lstatSync(accumulated);
			if (stat.isSymbolicLink()) throw new Error("Refusing to create temp dir: ancestor is a symlink: " + accumulated);
		} catch (e) {
			if (e instanceof Error && e.message.includes("symlink")) throw e;
			// Component doesn't exist yet — OK, proceed
			break;
		}
	}
	// Verify base dir itself is not a symlink before realpathSync.
	// Issue #1 fix: if baseDir itself is a symlink, realpathSync would
	// resolve to an attacker-controlled location.
	const baseStat = fs.lstatSync(base);
	if (baseStat.isSymbolicLink()) throw new Error("Refusing to create temp dir in symlinked base: " + base);
	// Create base dir only AFTER all ancestor symlink checks pass.
	if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
	// Issue #1 fix: re-validate the FULL ancestor chain immediately after
	// mkdirSync to close the TOCTOU window between initial validation
	// (lines 111-122) and directory creation. An attacker could have
	// deleted a validated ancestor and recreated it as a symlink in that
	// window.
	for (let i = 1; i < parts.length; i++) {
		if (parts[i] === "") continue;
		accumulated = path.join(accumulated, parts[i]);
		try {
			const stat = fs.lstatSync(accumulated);
			if (stat.isSymbolicLink()) throw new Error("Refusing to create temp dir: ancestor is a symlink (post-mkdir): " + accumulated);
		} catch (e) {
			if (e instanceof Error && e.message.includes("symlink")) throw e;
			// Component doesn't exist — OK
			break;
		}
	}
	// Resolve base to canonical path before joining.
	// Issue #1 fix: if the base dir is deleted between the post-mkdir
	// validation loop (lines 135-146) and realpathSync, realpathSync throws
	// ENOENT. Re-validate and retry to handle fast delete+recreate races.
	let resolvedBase: string;
	let retries = 3;
	while (true) {
		try {
			resolvedBase = fs.realpathSync(base);
			break;
		} catch (e: unknown) {
			if (--retries <= 0) throw e;
			// ENOENT: re-validate ancestor chain and retry
			const code = e instanceof Object && "code" in e ? (e as { code: string }).code : undefined;
			if (code !== "ENOENT") throw e;
		}
		// Re-validate ancestor chain post-mkdir (same logic as lines 135-146)
		const revalidateParts = absoluteBase.split(path.sep);
		let revalidateAccumulated = "";
		if (revalidateParts[0] === "") revalidateAccumulated = "/";
		for (let i = 1; i < revalidateParts.length; i++) {
			if (revalidateParts[i] === "") continue;
			revalidateAccumulated = path.join(revalidateAccumulated, revalidateParts[i]);
			try {
				const stat = fs.lstatSync(revalidateAccumulated);
				if (stat.isSymbolicLink()) {
					throw new Error("Refusing to create temp dir: ancestor is a symlink (post-mkdir): " + revalidateAccumulated);
				}
			} catch (e) {
				if (e instanceof Error && e.message.includes("symlink")) throw e;
				// Component doesn't exist — stop re-validating, retry realpathSync
				break;
			}
		}
	}
	// Issue #2 fix: verify resolvedBase itself is not a symlink (TOCTOU
	// between realpathSync and the ancestor walk). If a symlink was
	// created at the base path after realpathSync returned, catch it.
	let resolvedBaseStat: fs.Stats;
	try {
		resolvedBaseStat = fs.lstatSync(resolvedBase);
		if (resolvedBaseStat.isSymbolicLink()) throw new Error("Refusing to create temp dir: resolved base is a symlink: " + resolvedBase);
	} catch (e) {
		if (e instanceof Error && e.message.includes("symlink")) throw e;
		// resolvedBase doesn't exist yet — OK
	}
	// Verify resolved path has no symlink ancestors. realpathSync follows
	// symlinks, so if any ancestor is a symlink the resolved path will be
	// inside the attacker's target. Catch that by walking the resolved path.
	const resolvedParts = resolvedBase.split(path.sep);
	let resolvedAccumulated = "";
	if (resolvedParts[0] === "") resolvedAccumulated = "/"; // Unix root
	for (let i = 1; i < resolvedParts.length; i++) {
		if (resolvedParts[i] === "") continue;
		resolvedAccumulated = path.join(resolvedAccumulated, resolvedParts[i]);
		try {
			const stat = fs.lstatSync(resolvedAccumulated);
			if (stat.isSymbolicLink()) throw new Error("Refusing to create temp dir: resolved path contains symlink ancestor: " + resolvedAccumulated);
		} catch (e) {
			if (e instanceof Error && e.message.includes("symlink")) throw e;
			// Component doesn't exist — OK
			break;
		}
	}
	const rawTempDir = fs.mkdtempSync(path.join(resolvedBase, prefix));
	try {
		const stat = fs.lstatSync(rawTempDir);
		if (stat.isSymbolicLink()) throw new Error("temp dir is a symlink");
	} catch (e) {
		if (e instanceof Error && e.message.includes("symlink")) {
			fs.rmSync(rawTempDir, { recursive: true, force: true });
			throw new Error("Refusing to use symlinked temp directory.");
		}
		throw e;
	}
	const resolved = fs.realpathSync(rawTempDir);
	// Track for global cleanup on shutdown / crash
	createdTempDirs.add(resolved);
	return resolved;
}

export function buildPiWorkerArgs(input: BuildPiWorkerArgsInput): BuildPiWorkerArgsResult {
	const args = ["--mode", "json", "-p"];
	if (input.sessionEnabled === false) args.push("--no-session");

	const resolvedModel = input.model ?? input.agent.model;
	if (resolvedModel) {
		const modelWithThinking = applyThinkingSuffix(resolvedModel, input.agent.thinking);
		if (modelWithThinking) args.push("--model", modelWithThinking);
	}
	// When no model resolved, pass thinking separately so Pi can apply it to the inherited parent model.
	if (!resolvedModel && input.agent.thinking && input.agent.thinking !== "off" && isValidThinkingLevel(input.agent.thinking)) {
		args.push("--thinking", input.agent.thinking);
	}

	// Apply role-based tool restrictions (from role-tools.ts)
	// Role-specific config takes precedence over agent-defined tools
	const toolConfig = input.role ? getAgentSessionOptions(input.role) : {};
	const explicitTools = toolConfig.tools ?? input.agent.tools;
	const excludeTools = toolConfig.excludeTools;

	if (explicitTools?.length) args.push("--tools", explicitTools.join(","));
	if (excludeTools?.length) args.push("--exclude-tools", excludeTools.join(","));
	// Always add --no-extensions before --extension to prevent user extensions from being auto-loaded.
	// User extensions in ~/.pi/agent/extensions/ may fail due to missing dependencies.
	args.push("--no-extensions");
	if (input.agent.extensions !== undefined) {
		for (const extension of [PROMPT_RUNTIME_EXTENSION_PATH, ...input.agent.extensions]) args.push("--extension", extension);
	} else {
		args.push("--extension", PROMPT_RUNTIME_EXTENSION_PATH);
	}
	if (!input.agent.inheritSkills) args.push("--no-skills");
	for (const skillPath of input.skillPaths ?? []) args.push("--skill", skillPath);

	let tempDir: string | undefined;
	if (input.agent.systemPrompt) {
		// Use pi's own config dir instead of /tmp so temp files live alongside
		// other pi state and don't pollute the shared system temp dir.
		const tmpBase = getPiTempBase();
		tempDir = createSafeTempDir(tmpBase, `pi-crew-${process.pid}-`);
		const promptPath = path.join(tempDir, `${input.agent.name.replace(/[^\w.-]/g, "_")}.md`);
		fs.writeFileSync(promptPath, input.agent.systemPrompt, { mode: 0o600 });
		args.push(input.agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			const tmpBase = getPiTempBase();
			tempDir = createSafeTempDir(tmpBase, `pi-crew-${process.pid}-`);
		}
		const taskPath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskPath, input.task, { mode: 0o600 });
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env = input.env ?? process.env;
	const parentDepth = currentCrewDepth(env);
	const maxDepth = resolveCrewMaxDepth(input.maxDepth, env);
	return {
		args,
		env: {
			PI_CREW_INHERIT_PROJECT_CONTEXT: input.agent.inheritProjectContext ? "1" : "0",
			PI_CREW_INHERIT_SKILLS: input.agent.inheritSkills ? "1" : "0",
			PI_CREW_DEPTH: String(parentDepth + 1),
			PI_CREW_MAX_DEPTH: String(maxDepth),
			PI_CREW_ROLE: input.agent.name,
			PI_TEAMS_INHERIT_PROJECT_CONTEXT: input.agent.inheritProjectContext ? "1" : "0",
			PI_TEAMS_INHERIT_SKILLS: input.agent.inheritSkills ? "1" : "0",
			PI_TEAMS_DEPTH: String(parentDepth + 1),
			PI_TEAMS_MAX_DEPTH: String(maxDepth),
			PI_TEAMS_ROLE: input.agent.name,
		},
		tempDir,
	};
}

export function cleanupTempDir(tempDir: string | undefined): void {
	if (!tempDir) return;
	try {
		// CRITICAL: never rmSync a symlink. fs.rmSync with recursive:true
		// FOLLOWS symlinks — use lstatSync (does not follow) to verify.
		let lstat: fs.Stats;
		try {
			lstat = fs.lstatSync(tempDir);
		} catch {
			// Dir doesn't exist or inaccessible — best effort
			createdTempDirs.delete(tempDir);
			return;
		}
		if (lstat.isSymbolicLink()) {
			// Symlinks should not be in createdTempDirs (createSafeTempDir
			// rejects symlinked base dirs), but guard anyway.
			createdTempDirs.delete(tempDir);
			return;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
		createdTempDirs.delete(tempDir);
	} catch {
		// Best effort.
	}
}

/**
 * Clean up ALL temp dirs created in this process. Called from
 * crew-cleanup.ts on session_shutdown to prevent accumulation of
 * /tmp/pi-crew-* dirs when individual cleanupTempDir calls are missed
 * (e.g. parent process killed before child-pi.ts settles).
 */
export function cleanupAllTrackedTempDirs(): { cleaned: number; failed: number } {
	let cleaned = 0;
	let failed = 0;
	// Snapshot to avoid mutation during iteration
	for (const dir of [...createdTempDirs]) {
		try {
			// CRITICAL: never rmSync a symlink. fs.rmSync with recursive:true
			// FOLLOWS symlinks — use lstatSync to verify first.
			let lstat: fs.Stats;
			try {
				lstat = fs.lstatSync(dir);
			} catch {
				// Dir gone or inaccessible — best effort cleanup
				createdTempDirs.delete(dir);
				failed++;
				continue;
			}
			if (lstat.isSymbolicLink()) {
				// Should never happen (createSafeTempDir rejects symlinked
				// base), but guard anyway to prevent accidental target deletion.
				createdTempDirs.delete(dir);
				continue;
			}
			fs.rmSync(dir, { recursive: true, force: true });
			createdTempDirs.delete(dir);
			cleaned++;
		} catch {
			failed++;
		}
	}
	return { cleaned, failed };
}

/**
 * @internal Test-only: reset the in-memory `createdTempDirs` Set.
 * Used by unit tests to ensure isolation between cases. Not exported
 * via the public API surface.
 */
export function __test_resetTrackedTempDirs(): void {
	createdTempDirs.clear();
}

/**
 * @internal Test-only: get a snapshot of currently tracked temp dirs.
 */
export function __test_getTrackedTempDirs(): readonly string[] {
	return [...createdTempDirs];
}

/**
 * Purge stale entries from createdTempDirs — directories that no longer
 * exist on disk. This handles the case where a process crashed before
 * cleanupAllTrackedTempDirs ran, leaving orphaned entries in the Set.
 * Called at startup as a belt-and-suspenders measure alongside the
 * periodic cleanupOrphanTempDirs.
 */
export function purgeStaleTrackedTempDirs(): { removed: number; remaining: number } {
	let removed = 0;
	for (const dir of [...createdTempDirs]) {
		if (!fs.existsSync(dir)) {
			createdTempDirs.delete(dir);
			removed++;
		}
	}
	return { removed, remaining: createdTempDirs.size };
}

// Run startup purge to prevent unbounded Set growth from crash loops.
purgeStaleTrackedTempDirs();

/** Max age (ms) for orphan temp dirs. Anything older is considered abandoned. */
const ORPHAN_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
/** Cap dirs removed per call to avoid main-thread stalls. */
const ORPHAN_TEMP_CLEAN_BATCH_SIZE = 50;

/**
 * Remove orphan temp dirs in `~/.pi/agent/pi-crew/tmp/` older than the age
 * threshold. This catches dirs left behind by parent processes that were
 * SIGKILL'd (no graceful shutdown to call cleanupAllTrackedTempDirs).
 *
 * Called periodically by register.ts:tempReconcileTimer.
 *
 * @param now Current epoch ms (parameter for testability)
 * @param baseDir Override base dir (for testing). Defaults to
 *   `<userPiRoot>/tmp/`.
 */
export function cleanupOrphanTempDirs(
	now: number = Date.now(),
	baseDir: string = path.join(userPiRoot(), "tmp"),
): { scanned: number; cleaned: number; failed: number } {
	let scanned = 0;
	let cleaned = 0;
	let failed = 0;
	try {
		if (!fs.existsSync(baseDir)) return { scanned: 0, cleaned: 0, failed: 0 };
		const entries = fs.readdirSync(baseDir, { withFileTypes: true });
		// Only process pi-crew-* dirs to avoid touching unrelated files
		const candidates = entries
			.filter((e) => e.isDirectory() && e.name.startsWith("pi-crew-"))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, ORPHAN_TEMP_CLEAN_BATCH_SIZE);
		for (const entry of candidates) {
			scanned++;
			const dir = path.join(baseDir, entry.name);
			// CRITICAL: never rmSync a symlink. fs.rmSync with recursive:true
			// FOLLOWS symlinks — an attacker could plant a symlink to /etc and
			// wipe the system. Use lstat (does not follow) and skip.
			let lstat: fs.Stats;
			try {
				lstat = fs.lstatSync(dir);
			} catch {
				failed++;
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			// Skip dirs currently in use by this process. A long-running child
			// pi (>24h) would otherwise have its prompt/task tmp dir deleted
			// mid-execution, causing broken-pipe failures when the child
			// reads the system prompt.
			if (createdTempDirs.has(dir)) continue;
			try {
				// FIX: Perform lstatSync BEFORE statSync mtime check to close TOCTOU window.
				// An attacker could plant a symlink between the early lstatSync (line 373) and statSync.
				// If statSync follows the symlink, it reads the target's mtime, not the dir's.
				// By checking lstatSync first, we skip the mtime check entirely for symlinks.
				let preRmlstat: fs.Stats | undefined;
				try {
					preRmlstat = fs.lstatSync(dir);
				} catch {
					failed++;
					continue;
				}
				if (!preRmlstat || preRmlstat.isSymbolicLink()) continue;
				// Reuse preRmlstat (captured at line 408) — already verified non-symlink at line 415.
				// Avoid calling lstatSync again to eliminate the TOCTOU window between
				// preRmlstat lstatSync (line 408) and this mtime check.
				// NOTE: This is a best-effort approximation. The mtime was captured at line 408,
				// potentially seconds before the rmSync at line 420. If the directory was modified
				// after line 408, the age check uses stale data. This could cause premature cleanup
				// of dirs that were recently modified but appeared old based on cached mtime (±seconds jitter).
				if (now - preRmlstat.mtimeMs > ORPHAN_TEMP_MAX_AGE_MS) {
					fs.rmSync(dir, { recursive: true, force: true });
					createdTempDirs.delete(dir);
					cleaned++;
				}
			} catch {
				failed++;
			}
		}
	} catch {
		/* skip if tmpdir unreadable */
	}
	return { scanned, cleaned, failed };
}

/**
 * Clean up orphan `pi-crew-*` prompt/task temp dirs left in the system
 * `/tmp/` directory. Before commit 8ba270d these were the primary location
 * for temp dirs; users who upgraded may have thousands of orphans (the
 * user's /tmp had 2498 of these). The existing
 * `reconcileOrphanedTempWorkspaces` only cleans dirs containing
 * `.crew/state/runs/` (the run-state dirs), so prompt/task orphans are
 * never touched.
 *
 * Strategy: remove `pi-crew-*` dirs in /tmp that DO NOT contain
 * `.crew/state/runs/` AND are older than the age threshold. The age
 * threshold protects active processes that might still be writing.
 *
 * Bounded to ORPHAN_TEMP_CLEAN_BATCH_SIZE dirs per call.
 *
 * @param now Current epoch ms (parameter for testability)
 * @param tmpDirOverride Override /tmp dir (for testing). Defaults to
 *   `os.tmpdir()`.
 */
export function cleanupLegacyOrphanTempDirs(
	now: number = Date.now(),
	tmpDirOverride: string = os.tmpdir(),
): { scanned: number; cleaned: number; failed: number } {
	const tmpDir = tmpDirOverride;
	let scanned = 0;
	let cleaned = 0;
	let failed = 0;
	try {
		if (!fs.existsSync(tmpDir)) return { scanned: 0, cleaned: 0, failed: 0 };
		const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
		const candidates = entries
			.filter((e) => e.isDirectory() && e.name.startsWith("pi-crew-"))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, ORPHAN_TEMP_CLEAN_BATCH_SIZE);
		for (const entry of candidates) {
			scanned++;
			const dir = path.join(tmpDir, entry.name);
			// Symlink guard
			let lstat: fs.Stats;
			try {
				lstat = fs.lstatSync(dir);
			} catch {
				failed++;
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			// Skip dirs containing active run state — those are handled by
			// reconcileOrphanedTempWorkspaces which has run-state semantics.
			const crewDir = path.join(dir, ".crew");
			let crewDirLstat: fs.Stats | undefined;
			try {
				crewDirLstat = fs.lstatSync(crewDir);
			} catch {
				// doesn't exist
			}
			if (crewDirLstat && !crewDirLstat.isSymbolicLink()) continue;
			// Skip dirs currently tracked by this process (defense in depth:
			// with 8ba270d the Set should never contain /tmp/ paths, but
			// future code or external callers might).
			if (createdTempDirs.has(dir)) continue;
			try {
				// FIX: Perform lstatSync BEFORE statSync mtime check to close TOCTOU window.
				// An attacker could plant a symlink between the early lstatSync (line 457) and statSync.
				// If statSync follows the symlink, it reads the target's mtime, not the dir's.
				// By checking lstatSync first, we skip the mtime check entirely for symlinks.
				let preRmlstat: fs.Stats;
				try {
					preRmlstat = fs.lstatSync(dir);
				} catch {
					failed++;
					continue;
				}
				if (preRmlstat.isSymbolicLink()) continue;
				// Reuse preRmlstat (captured at line 494) — already verified non-symlink at line 501.
				// Avoid calling lstatSync again to eliminate the TOCTOU window between
				// preRmlstat lstatSync (line 494) and this mtime check.
				// NOTE: This is a best-effort approximation. The mtime was captured at line 494,
				// potentially seconds before the rmSync at line 505. If the directory was modified
				// after line 494, the age check uses stale data. This could cause premature cleanup
				// of dirs that were recently modified but appeared old based on cached mtime (±seconds jitter).
				if (now - preRmlstat.mtimeMs > ORPHAN_TEMP_MAX_AGE_MS) {
					fs.rmSync(dir, { recursive: true, force: true });
					cleaned++;
				}
			} catch {
				failed++;
			}
		}
	} catch {
		/* skip if tmpdir unreadable */
	}
	return { scanned, cleaned, failed };
}
