import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { withFileLockSync } from "../state/locks.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { JoinMode } from "./group-join.ts";

export interface CrewSettings {
	maxConcurrent?: number;
	defaultMaxTurns?: number;
	graceTurns?: number;
	defaultJoinMode?: JoinMode;
	schedulingEnabled?: boolean;
	notifierIntervalMs?: number;
	/** Scheduled jobs loaded from settings — opaque, passed to crewScheduler */
	scheduledJobs?: unknown[];
}

const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const VALID_JOIN_MODES = new Set<JoinMode>(["async", "group", "smart"]);

/**
 * M2: Validate that a scheduled job object has required fields before passing to scheduler.
 * Prevents opaque unknown[] from reaching CrewScheduler.add() without validation.
 */
function validateScheduledJob(job: unknown): boolean {
	if (!job || typeof job !== "object") return false;
	const obj = job as Record<string, unknown>;
	return typeof obj.id === "string" && obj.id.length > 0 && typeof obj.scheduleType === "string" && typeof obj.enabled === "boolean";
}

function sanitizeSettings(raw: unknown): CrewSettings {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: CrewSettings = {};
	if (
		typeof r.maxConcurrent === "number" &&
		Number.isInteger(r.maxConcurrent) &&
		r.maxConcurrent >= 1 &&
		r.maxConcurrent <= MAX_CONCURRENT_CEILING
	) {
		out.maxConcurrent = r.maxConcurrent;
	}
	if (
		typeof r.defaultMaxTurns === "number" &&
		Number.isInteger(r.defaultMaxTurns) &&
		r.defaultMaxTurns >= 0 &&
		r.defaultMaxTurns <= MAX_TURNS_CEILING
	) {
		out.defaultMaxTurns = r.defaultMaxTurns;
	}
	if (typeof r.graceTurns === "number" && Number.isInteger(r.graceTurns) && r.graceTurns >= 1 && r.graceTurns <= GRACE_TURNS_CEILING) {
		out.graceTurns = r.graceTurns;
	}
	if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode as JoinMode)) {
		out.defaultJoinMode = r.defaultJoinMode as JoinMode;
	}
	if (typeof r.schedulingEnabled === "boolean") {
		out.schedulingEnabled = r.schedulingEnabled;
	}
	if (typeof r.notifierIntervalMs === "number" && r.notifierIntervalMs >= 1000) {
		out.notifierIntervalMs = r.notifierIntervalMs;
	}
	// Pass through scheduledJobs after basic validation
	if (Array.isArray(r.scheduledJobs)) {
		out.scheduledJobs = (r.scheduledJobs as unknown[]).filter(validateScheduledJob);
	}
	return out;
}

function globalPath(): string {
	return path.join(homedir(), ".pi", "crew-settings.json");
}

function projectPath(cwd: string): string {
	return path.join(cwd, ".pi", "crew-settings.json");
}

function readSettingsFile(filePath: string): CrewSettings {
	if (!fs.existsSync(filePath)) return {};
	try {
		return sanitizeSettings(JSON.parse(fs.readFileSync(filePath, "utf-8")));
	} catch (err) {
		logInternalError("settings-store.read", err, `Ignoring malformed settings at ${filePath}`);
		return {};
	}
}

export function loadCrewSettings(cwd: string = process.cwd()): CrewSettings {
	return {
		...readSettingsFile(globalPath()),
		...readSettingsFile(projectPath(cwd)),
	};
}

export function saveCrewSettings(s: CrewSettings, cwd: string = process.cwd()): boolean {
	const p = projectPath(cwd);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		// Atomic (temp + rename + fsync) instead of raw writeFileSync: a crash/SIGKILL
		// mid-write would otherwise truncate <cwd>/.pi/crew-settings.json, and the
		// reader silently resets to {} on parse failure — losing ALL crew settings +
		// scheduledJobs.
		atomicWriteJson(p, s);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomically read-modify-write crew settings under a file lock.
 *
 * Fixes two issues vs a plain loadCrewSettings → saveCrewSettings sequence:
 *  1. Cross-session lost-update race: <cwd>/.pi/crew-settings.json is project-scoped,
 *     so two Pi sessions on the same project concurrently scheduling jobs would each
 *     load-modify-save and the second save clobbers the first (lost job). The lock
 *     serializes the whole transaction.
 *  2. Crash truncation: the write uses atomicWriteJson (temp + rename + fsync).
 *
 * `mutator` receives the freshly-loaded (merged) settings and returns the new value
 * to persist. Returns the persisted settings.
 */
export function updateCrewSettings(cwd: string, mutator: (settings: CrewSettings) => CrewSettings): CrewSettings {
	const p = projectPath(cwd);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	return withFileLockSync(p, () => {
		const fresh = loadCrewSettings(cwd); // re-read inside the lock (TOCTOU-safe vs other updaters)
		const next = mutator(fresh);
		atomicWriteJson(p, next);
		return next;
	});
}

export function applyCrewSettingsToConfig(
	config: {
		limits?: { maxConcurrentWorkers?: number };
		runtime?: {
			maxTurns?: number;
			graceTurns?: number;
			groupJoin?: string;
		};
		notifierIntervalMs?: number;
	},
	settings: CrewSettings,
): void {
	if (settings.maxConcurrent != null && config.limits) config.limits.maxConcurrentWorkers = settings.maxConcurrent;
	if (settings.defaultMaxTurns != null && config.runtime) config.runtime.maxTurns = settings.defaultMaxTurns;
	if (settings.graceTurns != null && config.runtime) config.runtime.graceTurns = settings.graceTurns;
	if (settings.defaultJoinMode != null && config.runtime) config.runtime.groupJoin = settings.defaultJoinMode;
	if (settings.notifierIntervalMs != null) config.notifierIntervalMs = settings.notifierIntervalMs;
}
