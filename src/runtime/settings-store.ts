import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
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
	if (
		typeof r.graceTurns === "number" &&
		Number.isInteger(r.graceTurns) &&
		r.graceTurns >= 1 &&
		r.graceTurns <= GRACE_TURNS_CEILING
	) {
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
	// Pass through scheduledJobs as opaque array (validated by crewScheduler.add)
	if (Array.isArray(r.scheduledJobs)) {
		out.scheduledJobs = r.scheduledJobs;
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
	return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

export function saveCrewSettings(s: CrewSettings, cwd: string = process.cwd()): boolean {
	const p = projectPath(cwd);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf-8");
		return true;
	} catch {
		return false;
	}
}

export function applyCrewSettingsToConfig(
	config: { limits?: { maxConcurrentWorkers?: number }; runtime?: { maxTurns?: number; graceTurns?: number; groupJoin?: string }; notifierIntervalMs?: number },
	settings: CrewSettings,
): void {
	if (settings.maxConcurrent != null && config.limits) config.limits.maxConcurrentWorkers = settings.maxConcurrent;
	if (settings.defaultMaxTurns != null && config.runtime) config.runtime.maxTurns = settings.defaultMaxTurns;
	if (settings.graceTurns != null && config.runtime) config.runtime.graceTurns = settings.graceTurns;
	if (settings.defaultJoinMode != null && config.runtime) config.runtime.groupJoin = settings.defaultJoinMode;
	if (settings.notifierIntervalMs != null) config.notifierIntervalMs = settings.notifierIntervalMs;
}
