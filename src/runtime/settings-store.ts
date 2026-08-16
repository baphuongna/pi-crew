import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { projectOverrideWarning, sanitizeProjectConfig } from "../config/sanitize-project-config.ts";
import type { PiTeamsConfig } from "../config/types.ts";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { withFileLockSync } from "../state/coordination/locks.ts";
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

/**
 * LEGACY merged view — USER-TIER-ONLY ingestion path (P1 fix follow-up, bug-026 adjacent).
 *
 * Merges the user-tier global file OVER the project file into one flat object.
 * This view is trusted and MUST NOT be applied to live config anymore: the
 * project fragment bypasses `sanitizeProjectConfig`. The current consumer
 * path is `loadCrewSettingsTiers()` + `applyCrewSettingsTiersToConfig()`
 * (project fragment routed through the schema-driven tiering, Wave 2B).
 *
 * If you need to read crew settings for CONFIG APPLICATION, use the tiers
 * API — never this function. Kept exported for back-compat reads/tests;
 * adding a new consumer that writes into loadedConfig re-introduces the
 * fixed P1 bypass (see docs/decisions/2026-08-15-schema-driven-sanitize.md
 * and the Wave 2B execution log in docs/refactor-plan.md).
 */
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

/**
 * LEGACY direct-apply — USER-TIER-ONLY (P1 fix follow-up).
 *
 * Writes settings straight into a config object with NO sanitize tiering.
 * Applying a merged (user+project) `CrewSettings` through this function is
 * exactly the P1 bypass fixed in Wave 2B: project-tier values would land in
 * guard fields (`limits.maxConcurrentWorkers`, `runtime.maxTurns`, ...) with
 * no conditional drops. The tiered replacement is
 * `applyCrewSettingsTiersToConfig()` which routes the project fragment
 * through `sanitizeProjectConfig` + tighten-only comparison.
 *
 * Do NOT add new call sites that pass a merged/project-influenced settings
 * object. Acceptable use: tests, and user-tier-only tooling that has already
 * separated tiers.
 */
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

// ---------------------------------------------------------------------------
// Wave 2B (ITEM 1, P1 security): tiered loading + guarded apply.
//
// `<cwd>/.pi/crew-settings.json` is PROJECT-tier state — a cloned repository
// can ship it. `loadCrewSettings()` historically merged it OVER the user-tier
// `~/.pi/crew-settings.json` with only the type/range allowlist
// (`sanitizeSettings`), and `applyCrewSettingsToConfig` then wrote the merged
// result into guard fields (limits.maxConcurrentWorkers,
// runtime.maxTurns/graceTurns) AFTER `loadConfig()` had already sanitized the
// regular project config files — a full bypass of `sanitizeProjectConfig`.
// The functions below close that hole.
// ---------------------------------------------------------------------------

/** Tiered view of crew settings (see `loadCrewSettingsTiers`). */
export interface CrewSettingsTiers {
	/** User-tier `~/.pi/crew-settings.json` — fully trusted. */
	user: CrewSettings;
	/** Project-tier `<cwd>/.pi/crew-settings.json` — UNTRUSTED input. */
	project: CrewSettings;
	/** Historical merge view (project wins over user). Kept for the write-path
	 *  round-trip (`updateCrewSettings`) and for non-guard consumers
	 *  (scheduledJobs — see BOUNDARY note in applyCrewSettingsTiersToConfig). */
	merged: CrewSettings;
	/** Absolute path of the project-tier file (used in warnings). */
	projectPath: string;
}

/**
 * Load crew settings keeping the trust tiers distinguishable. The optional
 * `globalFile` parameter defaults to `~/.pi/crew-settings.json` and exists so
 * callers/tests can pin a hermetic user-tier file.
 */
export function loadCrewSettingsTiers(cwd: string = process.cwd(), globalFile: string = globalPath()): CrewSettingsTiers {
	const user = readSettingsFile(globalFile);
	const projectFilePath = projectPath(cwd);
	const project = readSettingsFile(projectFilePath);
	return { user, project, merged: { ...user, ...project }, projectPath: projectFilePath };
}

/**
 * Apply crew settings to a config with correct trust tiering. Returns the
 * list of drop warnings (standard project-override format).
 *
 * Pipeline for the PROJECT tier (the user tier is fully trusted and applied
 * exactly like the legacy merged semantics):
 *  1. CHOKE POINT — the fragment is mapped into `PiTeamsConfig` shape and run
 *     through `sanitizeProjectConfig`, the same schema-driven sanitize every
 *     other project-scoped config ingestion passes through (config.ts applies
 *     it to pi-teams.json and .pi/pi-crew.json). Today none of the mapped
 *     fields are sensitive-marked, so this is behavior-preserving — but any
 *     future `sensitive: true` mark or CONDITIONAL_PROJECT_DROPS entry on
 *     these paths automatically applies to crew-settings too.
 *  2. TIGHTEN-ONLY TIERING — `limits.maxConcurrentWorkers`,
 *     `runtime.maxTurns` and `runtime.graceTurns` are resource guards: a
 *     project-tier value that RAISES the effective value (baseline = config
 *     after the trusted user tier was applied) is dropped with the standard
 *     warning; lowering/equal survives. A value with NO baseline is also
 *     dropped: introducing a limit the user never set cannot be verified as
 *     tightening, and the only legitimate writer (updateCrewSettings
 *     spreading merged settings into the project file) always mirrors a
 *     user-tier value, so the equal case survives. This comparison lives HERE
 *     and not in CONDITIONAL_PROJECT_DROPS: that table is a fixed value
 *     predicate with no access to the effective-config baseline (Wave 2B
 *     decision — predicate signature intentionally unchanged).
 *  3. Survivors are applied over the user tier — safe by construction since
 *     survivors can only be equal-or-lower guard values.
 *
 * BOUNDARY (ITEM 1.4) — schedulingEnabled / scheduledJobs are NOT mapped into
 * the config fragment: `<cwd>/.pi/crew-settings.json` is the designated
 * persistence store for the user's own `crew schedule add/update/remove`
 * commands (handle-schedule.ts), and jobs execute only while a session is
 * open in that cwd, so project-tier scheduledJobs stay honored (consumed via
 * the `merged` view). `schedulingEnabled` currently has NO consumer anywhere
 * in src/ — if one is added it MUST be user-tier-only (project must not be
 * able to toggle background scheduling). Residual risk documented for the
 * security reviewer: a malicious repo shipping .pi/crew-settings.json with
 * scheduledJobs gets them registered on session_start; the hardening follow-up
 * (gate project-tier jobs behind a user-tier opt-in) is intentionally out of
 * scope here because it changes feature semantics.
 *
 * `notifierIntervalMs` (UI poll cadence) and `runtime.groupJoin` (join
 * semantics) are not guard fields and ride the choke point only.
 */
export function applyCrewSettingsTiersToConfig(config: PiTeamsConfig, tiers: CrewSettingsTiers): string[] {
	const warnings: string[] = [];
	// User tier: fully trusted, identical to the legacy merged semantics.
	applyCrewSettingsToConfig(config, tiers.user);

	const project = tiers.project;
	if (
		project.maxConcurrent == null &&
		project.defaultMaxTurns == null &&
		project.graceTurns == null &&
		project.defaultJoinMode == null &&
		project.notifierIntervalMs == null
	) {
		return warnings;
	}

	const fragment: PiTeamsConfig = {};
	if (project.maxConcurrent != null) fragment.limits = { maxConcurrentWorkers: project.maxConcurrent };
	if (project.defaultMaxTurns != null || project.graceTurns != null || project.defaultJoinMode != null) {
		const runtime: NonNullable<PiTeamsConfig["runtime"]> = {};
		if (project.defaultMaxTurns != null) runtime.maxTurns = project.defaultMaxTurns;
		if (project.graceTurns != null) runtime.graceTurns = project.graceTurns;
		// Legacy quirk (kept for behavior parity): crew-settings JoinMode allows
		// "async", which is not part of runtime.groupJoin's union — the old
		// structural param type let this through implicitly.
		if (project.defaultJoinMode != null)
			runtime.groupJoin = project.defaultJoinMode as NonNullable<PiTeamsConfig["runtime"]>["groupJoin"];
		fragment.runtime = runtime;
	}
	if (project.notifierIntervalMs != null) fragment.notifierIntervalMs = project.notifierIntervalMs;

	const sanitized = sanitizeProjectConfig(tiers.projectPath, config, fragment);
	warnings.push(...sanitized.warnings);

	const guards: Array<{ dotted: string; value: number | undefined; baseline: number | undefined }> = [
		{
			dotted: "limits.maxConcurrentWorkers",
			value: sanitized.config.limits?.maxConcurrentWorkers,
			baseline: config.limits?.maxConcurrentWorkers,
		},
		{ dotted: "runtime.maxTurns", value: sanitized.config.runtime?.maxTurns, baseline: config.runtime?.maxTurns },
		{ dotted: "runtime.graceTurns", value: sanitized.config.runtime?.graceTurns, baseline: config.runtime?.graceTurns },
	];
	const dropped = new Set<string>();
	for (const guard of guards) {
		if (guard.value === undefined) continue;
		if (guard.baseline === undefined || guard.value > guard.baseline) {
			dropped.add(guard.dotted);
			warnings.push(projectOverrideWarning(tiers.projectPath, guard.dotted));
		}
	}

	if (!dropped.has("limits.maxConcurrentWorkers") && sanitized.config.limits?.maxConcurrentWorkers != null && config.limits) {
		config.limits.maxConcurrentWorkers = sanitized.config.limits.maxConcurrentWorkers;
	}
	if (sanitized.config.runtime != null && config.runtime) {
		if (!dropped.has("runtime.maxTurns") && sanitized.config.runtime.maxTurns != null)
			config.runtime.maxTurns = sanitized.config.runtime.maxTurns;
		if (!dropped.has("runtime.graceTurns") && sanitized.config.runtime.graceTurns != null)
			config.runtime.graceTurns = sanitized.config.runtime.graceTurns;
		if (sanitized.config.runtime.groupJoin != null) config.runtime.groupJoin = sanitized.config.runtime.groupJoin;
	}
	if (sanitized.config.notifierIntervalMs != null) config.notifierIntervalMs = sanitized.config.notifierIntervalMs;
	return warnings;
}
