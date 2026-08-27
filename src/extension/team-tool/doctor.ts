import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { allAgents, discoverAgents, getSecurityEventLog } from "../../agents/discover-agents.ts";
import { loadConfig } from "../../config/config.ts";
import { DEFAULT_PATHS } from "../../config/defaults.ts";
import { type DriftReport, detectDrift, formatDriftReport } from "../../config/drift-detector.ts";
import { buildConfiguredModelRouting, resolveModelFallbackPolicy } from "../../runtime/model/model-fallback.ts";
import { getPiTempBase } from "../../runtime/model/pi-args.ts";
import { getRuntimeWarmupStatus } from "../../runtime/model/runtime-warmup.ts";
import { currentSessionModel, sessionModelSnapshot } from "../../runtime/model/session-model.ts";
import { getPiSpawnCommand } from "../../runtime/pi-spawn.ts";
import { formatZombieReport, scanZombieSubagents, type ZombieScanResult } from "../../runtime/process/zombie-scanner.ts";
import { launchScriptRegistry, sweepLaunchScripts, sweepOrphanLaunchScriptFiles } from "../../runtime/surface/launch-script.ts";
import { surfaceProviderForCleanup } from "../../runtime/surface/resolve-surface.ts";
import type { SurfaceProvider } from "../../runtime/surface/surface-provider.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { TeamToolParams } from "../../schema/team-tool-schema.ts";
import { atomicWriteFile, atomicWriteJson } from "../../state/atomic-write.ts";
import { TEAM_TERMINAL_RUN_STATUSES } from "../../state/contracts.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { type FatalFsCause, fsFailureLabel } from "../../utils/fs-errno.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { validateResources } from "../validate-resources.ts";
import { configRecord, result, type TeamContext } from "./context.ts";

interface DoctorCheck {
	label: string;
	ok: boolean;
	detail: string;
}

/** bug-026 sub-issue B: how many of the most recent runs to scan for tasks
 *  carrying a fatal-fs failureCause. Bounded so doctor stays fast on projects
 *  with long run histories. */
const FS_FAILURE_SCAN_RUN_LIMIT = 10;

function relativeTimeAgo(iso: string): string {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** bug-026 sub-issue B: scan the most recent runs (by mtime, capped) for
 *  tasks with a fatal-fs failureCause (enospc/edquot/emfile/enfile). Reads
 *  tasks.json directly (no state-store import) and never throws — doctor is
 *  a diagnostic tool; unreadable runs are simply skipped. */
function scanRecentFsFailureCauses(cwd: string): string {
	const runsRoot = path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir);
	let recentRunIds: string[];
	try {
		recentRunIds = fs
			.readdirSync(runsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				let mtimeMs = 0;
				try {
					mtimeMs = fs.statSync(path.join(runsRoot, entry.name)).mtimeMs;
				} catch {
					/* unreadable run dir — mtime 0 sorts last */
				}
				return { runId: entry.name, mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, FS_FAILURE_SCAN_RUN_LIMIT)
			.map((entry) => entry.runId);
	} catch {
		return "no run history";
	}
	let count = 0;
	let last: { runId: string; cause: FatalFsCause; finishedAt?: string } | undefined;
	for (const runId of recentRunIds) {
		let tasks: unknown;
		try {
			tasks = JSON.parse(fs.readFileSync(path.join(runsRoot, runId, "tasks.json"), "utf-8"));
		} catch {
			continue;
		}
		if (!Array.isArray(tasks)) continue;
		for (const task of tasks) {
			const failureCause = (task as { failureCause?: FatalFsCause }).failureCause;
			if (!failureCause) continue;
			count += 1;
			const finishedAt = (task as { finishedAt?: string }).finishedAt;
			if (!last || (finishedAt ?? "") > (last.finishedAt ?? "")) last = { runId, cause: failureCause, finishedAt };
		}
	}
	if (count === 0) return `none in last ${FS_FAILURE_SCAN_RUN_LIMIT} runs`;
	const when = last?.finishedAt ? `, ${relativeTimeAgo(last.finishedAt)}` : "";
	return `${count} task(s) in last ${FS_FAILURE_SCAN_RUN_LIMIT} runs (last: ${last?.runId}${when}, ${fsFailureLabel(last!.cause)})`;
}

function firstOutputLine(stdout: string | null | undefined, stderr: string | null | undefined): string {
	const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
	return (
		output
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? "available"
	);
}

// Round 29 optimization: memoize spawnSync probe results at module level.
// The probes (git --version, pi --version) are stable for the process
// lifetime, and spawnSync on a node script can cost 1-2s. Without the
// cache, each buildTeamDoctorReport() call would pay that cost, and a
// file with 12 tests would take 20s+ even with empty cwd. The cache is
// safe: a doctor check is informational, and a stale ok=true would
// self-correct on the next process restart.
// MISSED-2 (R5): FIFO cap so the memo cannot grow unbounded. Naturally
// bounded by ~10-20 probed commands; the cap is a safety net (Map preserves
// insertion order).
const MAX_COMMAND_EXISTS_CACHE = 128;
const commandExistsCache = new Map<string, { ok: boolean; detail: string }>();
function commandExists(command: string, args: string[]): { ok: boolean; detail: string } {
	const cacheKey = `${command} ${args.join(" ")}`;
	const cached = commandExistsCache.get(cacheKey);
	if (cached) return cached;
	let result: { ok: boolean; detail: string };
	try {
		const output = spawnSync(command, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (output.error) {
			result = { ok: false, detail: output.error.message };
		} else if (output.status !== 0) {
			result = {
				ok: false,
				detail: firstOutputLine(output.stdout, output.stderr) || `status ${output.status}`,
			};
		} else {
			result = {
				ok: true,
				detail: firstOutputLine(output.stdout, output.stderr),
			};
		}
	} catch (error) {
		result = {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	commandExistsCache.set(cacheKey, result);
	// MISSED-2 (R5): FIFO eviction — drop the oldest entry past the cap.
	if (commandExistsCache.size > MAX_COMMAND_EXISTS_CACHE) {
		const oldest = commandExistsCache.keys().next().value;
		if (oldest !== undefined) commandExistsCache.delete(oldest);
	}
	return result;
}

let piCommandExistsCache: { ok: boolean; detail: string } | undefined;
function piCommandExists(): { ok: boolean; detail: string } {
	if (piCommandExistsCache) return piCommandExistsCache;
	const spec = getPiSpawnCommand(["--version"]);
	const output = commandExists(spec.command, spec.args);
	if (!output.ok) {
		piCommandExistsCache = output;
		return piCommandExistsCache;
	}
	const executable = spec.command === "pi" ? "pi" : `${spec.command} ${spec.args[0] ?? ""}`.trim();
	piCommandExistsCache = {
		ok: true,
		detail: `${output.detail} (${executable})`,
	};
	return piCommandExistsCache;
}

function checkWritableDir(dir: string): { ok: boolean; detail: string } {
	try {
		if (!fs.existsSync(dir)) return { ok: false, detail: `${dir}: missing` };
		if (!fs.statSync(dir).isDirectory()) return { ok: false, detail: `${dir}: not a directory` };
		// fs.accessSync(W_OK) is unreliable on Windows; verify by writing a temp file.
		const probePath = `${dir}/.pi-crew-write-test`;
		try {
			atomicWriteFile(probePath, "ok");
			fs.rmSync(probePath, { force: true });
		} catch {
			return {
				ok: false,
				detail: `${dir}: not writable (write test failed)`,
			};
		}
		return { ok: true, detail: dir };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `${dir}: ${message}` };
	}
}

function auditJsonSchema(schema: unknown): string[] {
	const issues: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object" || Array.isArray(node)) return;
		const record = node as Record<string, unknown>;
		if (Array.isArray(record.type)) issues.push("schema node uses array-valued type");
		if (record.description && !record.type && !record.anyOf && !record.oneOf && !record.allOf && !record.properties)
			issues.push(`description-only schema node: ${record.description}`);
		if (record.type === "array" && !record.items) issues.push("array schema missing items");
		if (record.type && (record.anyOf || record.oneOf)) issues.push("schema node combines type with union keyword");
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) for (const item of value) walk(item);
			else walk(value);
		}
	};
	walk(schema);
	return issues;
}

function makeLine(check: DoctorCheck): string {
	return `- ${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.detail}`;
}

function section(title: string, checks: () => DoctorCheck[]): string[] {
	try {
		return [title, ...checks().map(makeLine)];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return [title, `- FAIL ${title}: ${detail}`];
	}
}

export interface TeamDoctorReportInput {
	cwd: string;
	configPath: string;
	configErrors: string[];
	configWarnings: string[];
	model?: { provider: string; id: string };
	validationErrors: number;
	validationWarnings: number;
	smokeChildPi?: { ok: boolean; detail: string };
}

export interface TeamDoctorReport {
	text: string;
	hasErrors: boolean;
	drift?: DriftReport;
}

export function buildTeamDoctorReport(input: TeamDoctorReportInput): TeamDoctorReport {
	// Discover once — used in both Drift and Discovery sections. Walking the
	// filesystem 3x (agents/teams/workflows) is the dominant cost of this
	// function; calling it twice doubles the cost. Round 29 optimization.
	const discoveredAgentsAll = allAgents(discoverAgents(input.cwd));
	const discoveredTeamsAll = allTeams(discoverTeams(input.cwd));
	const discoveredWorkflowsAll = allWorkflows(discoverWorkflows(input.cwd));
	// Compute drift once — reused in both Drift section and return value
	const driftResult = detectDrift(
		{
			agents: discoveredAgentsAll.map((a) => a.name),
			teams: discoveredTeamsAll.map((t) => t.name),
			workflows: discoveredWorkflowsAll.map((w) => w.name),
		},
		loadConfig(input.cwd).config,
	);
	const sections = [
		section("Runtime", () => {
			const git = commandExists("git", ["--version"]);
			const pi = piCommandExists();
			return [
				{ label: "cwd", ok: true, detail: input.cwd },
				{
					label: "platform",
					ok: true,
					detail: `${process.platform}/${process.arch} node=${process.version}`,
				},
				{ label: "pi command", ok: pi.ok, detail: pi.detail },
				{ label: "git command", ok: git.ok, detail: git.detail },
				{
					label: "config",
					ok: input.configErrors.length === 0,
					detail: `${input.configPath} (${input.configErrors.length} errors)`,
				},
				{
					label: "model",
					ok: true,
					detail: input.model ? `${input.model.provider}/${input.model.id}` : "not available in this context",
				},
				{
					label: "config warnings",
					ok: true,
					detail: `${input.configWarnings.length} warnings`,
				},
			];
		}),
		section("Filesystem", () => {
			const userWritable = checkWritableDir(userCrewRoot());
			const projectWritable = checkWritableDir(projectCrewRoot(input.cwd));
			return [
				{
					label: "user state",
					ok: userWritable.ok || userWritable.detail.endsWith(": missing"),
					detail: userWritable.detail,
				},
				{
					label: "project state",
					ok: projectWritable.ok || projectWritable.detail.endsWith(": missing"),
					detail: projectWritable.detail,
				},
				{
					label: "project state root",
					ok: true,
					detail: path.join(projectCrewRoot(input.cwd), DEFAULT_PATHS.state.runsSubdir),
				},
				{
					label: "artifacts root",
					ok: true,
					detail: path.join(projectCrewRoot(input.cwd), DEFAULT_PATHS.state.artifactsSubdir),
				},
				{
					// bug-026 sub-issue B: INFORMATIONAL (ok always true) — a historical
					// disk-full incident must not permanently fail doctor. The line makes
					// fs failureCauses discoverable without digging through run logs.
					label: "fs failure causes",
					ok: true,
					detail: scanRecentFsFailureCauses(input.cwd),
				},
			];
		}),
		section("Model Routing", () => {
			const snapshot = sessionModelSnapshot();
			const liveModel = currentSessionModel();
			const policy = resolveModelFallbackPolicy(loadConfig(input.cwd).config.runtime?.modelFallback);
			// Build a sample chain for a generic agent (no explicit model) to show
			// what the auto tail looks like with the current config.
			const sampleRouting = buildConfiguredModelRouting({
				parentModel: liveModel,
				cwd: input.cwd,
				policy,
			});
			return [
				{
					label: "session model (live)",
					ok: true,
					detail: liveModel ?? "not tracked yet",
				},
				{
					label: "session model (source)",
					ok: true,
					detail: `${snapshot.source}${snapshot.updatedAt ? ` @ ${new Date(snapshot.updatedAt).toISOString()}` : ""}`,
				},
				{
					label: "fallback policy",
					ok: true,
					detail: policy
						? `maxAuto=${policy.maxAutoFallbacks ?? "∞"} order=${policy.order ?? "parentFirst"} creds=${policy.requireCredentials ?? false} quota=${policy.quotaAwareOrdering ?? true}`
						: "legacy (unbounded, unordered)",
				},
				{
					label: "sample chain (no explicit model)",
					ok: true,
					detail: sampleRouting.candidates.length > 0 ? sampleRouting.candidates.join(" → ") : "(empty)",
				},
				{
					label: "auto tail size",
					ok: true,
					detail: `${sampleRouting.autoFallbackCount ?? 0} models`,
				},
			];
		}),
		section("Discovery", () => {
			const agentModelHints = discoveredAgentsAll.filter((agent) => agent.model || agent.fallbackModels?.length).length;
			return [
				{
					label: "agents",
					ok: true,
					detail: `${discoveredAgentsAll.length} discovered`,
				},
				{
					label: "teams",
					ok: true,
					detail: `${discoveredTeamsAll.length} discovered`,
				},
				{
					label: "workflows",
					ok: true,
					detail: `${discoveredWorkflowsAll.length} discovered`,
				},
				{
					label: "resource model hints",
					ok: true,
					detail: `${agentModelHints} agents declare model/fallback preferences`,
				},
			];
		}),
		section("Resource validation", () => [
			{
				label: "resource validation",
				ok: input.validationErrors === 0,
				detail: `${input.validationErrors} errors, ${input.validationWarnings} warnings`,
			},
		]),
		section("Drift", () => {
			const driftErrors = driftResult.items.filter((item) => item.severity === "error").length;
			const driftWarnings = driftResult.items.filter((item) => item.severity === "warning").length;
			return [
				{
					label: "config drift",
					ok: !driftResult.hasDrift || driftErrors === 0,
					detail: driftResult.hasDrift ? `${driftErrors} errors, ${driftWarnings} warnings` : "no drift detected",
				},
			];
		}),
		section("Schema", () => {
			const schemaIssues = auditJsonSchema(TeamToolParams);
			return [
				{
					label: "strict-provider schema",
					ok: schemaIssues.length === 0,
					detail: schemaIssues.length ? schemaIssues.slice(0, 3).join("; ") : "team tool schema compatible",
				},
			];
		}),
		section("Async/result delivery", () => [
			{
				label: "result watcher",
				ok: true,
				detail: "fs.watch with polling fallback for EMFILE/ENOSPC/EPERM",
			},
			{
				label: "async notifier",
				ok: true,
				detail: "session-stale guarded completion notifications enabled",
			},
		]),
		section("Worktrees", () => [
			{ label: "leader repository", ok: true, detail: input.cwd },
			{
				label: "cleanup policy",
				ok: true,
				detail: "dirty worktrees preserved unless force is set",
			},
		]),
		section("Runtime warmup (cold-start fix v0.8.6)", () => {
			// Surface whether the general cold-start-race fix is active + how long
			// the graph warmup took, so a session can confirm the fix loaded
			// (post-restart) and isn't pathologically slow. An UNWARMED graph is
			// the documented cause of `Cannot read properties of undefined
			// (reading '<binding>')` under concurrent subagent spawn.
			//
			// "Not started" is NOT a doctor error: it is the normal state in unit
			// tests and in any caller that invokes buildTeamDoctorReport directly
			// without going through registerPiTeams. Only a STARTED-but-FAILED
			// warmup is an error (something genuinely went wrong during pre-warm).
			const status = getRuntimeWarmupStatus();
			const checks: DoctorCheck[] = [
				{
					label: "warmup started",
					ok: true, // informational — "not started" is not a failure
					detail: status.started
						? "module graph pre-warmed at registration"
						: "not started in this process (normal for direct unit-test calls; in a live Pi session, started at extension load)",
				},
			];
			if (status.started) {
				checks.push({
					label: "warmup completed",
					ok: status.completed,
					detail: status.completed
						? status.durationMs !== undefined
							? `graph warm in ${status.durationMs}ms`
							: "completed"
						: "in progress",
				});
				if (status.error) {
					checks.push({
						label: "warmup error",
						ok: false,
						detail: status.error,
					});
				}
			}
			return checks;
		}),
	];
	// R7-13: surface security telemetry. The event log was previously
	// write-only (0 production readers); doctor now reports a compact summary
	// — total events plus the latest event's time and scope. Emitted only
	// when events exist (cheap single line, no per-event dump). A non-empty
	// log is informational, not a failure: blocked registrations mean the
	// SEC-001 protection fired.
	const securityEvents = getSecurityEventLog();
	const lastSecurityEvent = securityEvents.at(-1);
	if (lastSecurityEvent) {
		sections.push(
			section("Security", () => [
				{
					label: "security events",
					ok: true,
					detail: `${securityEvents.length} logged; last ${lastSecurityEvent.type} agent="${lastSecurityEvent.name}" at ${new Date(lastSecurityEvent.timestamp).toISOString()}`,
				},
			]),
		);
	}
	if (input.smokeChildPi) {
		sections.push([`Child check`, `- ${input.smokeChildPi.ok ? "OK" : "FAIL"} child Pi smoke: ${input.smokeChildPi.detail}`]);
	}
	const lines = ["pi-crew doctor report"];
	for (const block of sections) {
		if (block.length > 0) {
			lines.push(...block);
			lines.push("");
		}
	}
	if (lines.at(-1) === "") lines.pop();
	const text = lines.join("\n");
	return {
		text,
		hasErrors: sections.some((sectionLines) => sectionLines.some((line) => line.includes("FAIL"))),
		drift: driftResult.hasDrift ? driftResult : undefined,
	};
}

// ── T12: orphan surface-pane cleanup (doctor focus=zombies) ─────────────────
//
// Three orphan sources:
//  1. zombie scan — a sub-agent whose crew parent died while carrying
//     PI_CREW_SURFACE/PI_CREW_SURFACE_PANE: the pane outlived its host.
//  2. terminal-run manifests — a finished run whose manifest.surface.panes
//     still has entries (host died before releaseSurfacePane). Those panes
//     hold the live-pane cap hostage for the rest of the run (T11 residual);
//     doctor is the sweep that finally releases them.
//  3. terminal-run manifests' surface.tabs (tab-layout Task 6) — a finished
//     run whose tabs entry still carries tab ids: the host died before
//     closeTabForRun ran in its finally block. Doctor closes each tab BY ID
//     (its own process never owned the provider's tabKey map) and clears the
//     manifest entry only once the mux confirmed every tab id resolved.
//
// Closing is gated on provider.detect() — if the mux is unavailable the panes
// are listed without any close attempt (fail-open list-only, never close blind).

/** How many most-recent run manifests to scan for orphan panes. */
const ORPHAN_RUN_SCAN_LIMIT = 10;

export interface OrphanSurfacePane {
	paneId: string;
	kind: "tmux" | "herdr";
	/** Provenance line for the human, e.g. `zombie-scan pid 4242`. */
	source: string;
}

/**
 * Tab-layout Task 6: một entry `surface.tabs[tabKey]` còn tabIds trên manifest
 * của run TERMINAL — ứng viên orphan, phải liveness-check từng tabId qua mux
 * (closeTabById) trước khi đóng (doctor chạy ở process khác host đã spawn nên
 * map nội bộ tabKey của provider trống ở đây — KHÔNG dùng closeTab(tabKey)).
 */
export interface OrphanSurfaceTab {
	runId: string;
	tabKey: string;
	/** Mọi tab/window id của entry (run dài vượt MAX_PANES_PER_TAB có nhiều). */
	tabIds: string[];
	kind: "tmux" | "herdr";
	manifestPath: string;
}

export interface DoctorSurfaceCleanupDeps {
	/** Provider per kind — injectable so tests never touch a real mux. */
	providers?: Partial<Record<"tmux" | "herdr", SurfaceProvider>>;
	/** Clock (ms epoch) for the script TTL sweep — default Date.now. */
	now?: () => number;
	/** Launch-script temp base (default getPiTempBase()). */
	tempBase?: string;
	/** Max recent run manifests scanned — 0 skips the manifest source. */
	runScanLimit?: number;
}

export interface DoctorSurfaceCleanupResult {
	orphans: OrphanSurfacePane[];
	/** Pane ids successfully closed via provider.closeSurface. */
	closed: string[];
	/** Pane ids the mux no longer knows — nothing to close, not a failure. */
	gone: string[];
	failures: { paneId: string; error: string }[];
	/** Tabs của terminal runs còn tabIds trên manifest (tab-layout Task 6). */
	orphanTabs: OrphanSurfaceTab[];
	/** Tab ids closed directly by id via provider.closeTabById. */
	tabsClosed: string[];
	/** Tab ids the mux no longer knows — liveness confirmed dead, not a failure. */
	tabsGone: string[];
	tabFailures: { tabId: string; error: string }[];
	/** Launch scripts removed from disk + registry (orphan script sweep, T5). */
	scriptsSwept: number;
	/** Why a provider kind was skipped (listed-only). */
	providerNotes: string[];
}

/** TERMINAL-run manifest record đọc từ đĩa — nguồn chung cho pane + tab orphans. */
interface TerminalRunManifestRecord {
	runId: string;
	manifestPath: string;
	manifest: Record<string, unknown>;
	kind: "tmux" | "herdr";
}

/** Panes recorded on TERMINAL runs' manifests — the T11 residual leak. */
function collectTerminalRunOrphanPanes(records: TerminalRunManifestRecord[]): OrphanSurfacePane[] {
	const orphans: OrphanSurfacePane[] = [];
	for (const record of records) {
		const surface = record.manifest.surface as { panes?: unknown } | undefined;
		if (!surface?.panes || typeof surface.panes !== "object") continue;
		for (const [taskId, paneId] of Object.entries(surface.panes as Record<string, unknown>)) {
			if (typeof paneId !== "string" || paneId === "") continue;
			orphans.push({ paneId, kind: record.kind, source: `run ${record.runId} task ${taskId} (terminal)` });
		}
	}
	return orphans;
}

/**
 * Tabs recorded on TERMINAL runs' manifests (tab-layout Task 5/6). Manifest
 * TRÊN ĐĨA GIỮ tabIds sau run end làm evidence — entry non-empty trên run
 * terminal nghĩa là host chết trước khi closeTabForRun chạy ở finally. Đây
 * chỉ là DANH SÁCH ứng viên; doctor liveness-check từng tabId qua mux
 * (closeTabById) rồi mới close-by-ID idempotent — không bao giờ close mù.
 */
function collectTerminalRunOrphanTabs(records: TerminalRunManifestRecord[]): OrphanSurfaceTab[] {
	const tabs: OrphanSurfaceTab[] = [];
	for (const record of records) {
		const surface = record.manifest.surface as { tabs?: unknown } | undefined;
		if (!surface?.tabs || typeof surface.tabs !== "object") continue;
		for (const [tabKey, tabIds] of Object.entries(surface.tabs as Record<string, unknown>)) {
			if (!Array.isArray(tabIds)) continue;
			const ids = tabIds.filter((id): id is string => typeof id === "string" && id !== "");
			if (ids.length === 0) continue; // host đã closeTabForRun — không phải orphan
			tabs.push({ runId: record.runId, tabKey, tabIds: ids, kind: record.kind, manifestPath: record.manifestPath });
		}
	}
	return tabs;
}

/** TERMINAL-run manifests gần nhất (mới nhất trước) — đọc MỘT lần cho cả pane + tab orphans. */
function readRecentRunManifests(cwd: string, limit: number): TerminalRunManifestRecord[] {
	const runsRoot = path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir);
	let recentRunIds: string[];
	try {
		recentRunIds = fs
			.readdirSync(runsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				let mtimeMs = 0;
				try {
					mtimeMs = fs.statSync(path.join(runsRoot, entry.name)).mtimeMs;
				} catch {
					/* unreadable run dir — mtime 0 sorts last */
				}
				return { runId: entry.name, mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, limit)
			.map((entry) => entry.runId);
	} catch {
		return [];
	}
	const records: TerminalRunManifestRecord[] = [];
	for (const runId of recentRunIds) {
		const manifestPath = path.join(runsRoot, runId, "manifest.json");
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		} catch {
			continue; // unreadable/absent manifest — nothing this run can tell us
		}
		if (typeof manifest.status !== "string" || !TEAM_TERMINAL_RUN_STATUSES.has(manifest.status as never)) continue;
		const kind = (manifest.surface as { provider?: unknown } | undefined)?.provider;
		if (kind !== "tmux" && kind !== "herdr") continue;
		records.push({ runId, manifestPath, manifest, kind });
	}
	return records;
}

/**
 * Collect + close orphan surface panes and sweep orphan launch scripts.
 * Best-effort throughout: an error on one pane never aborts the rest, and a
 * provider that fails detect() downgrades that kind to list-only.
 */
export async function cleanupOrphanSurfacePanes(input: {
	cwd: string;
	scan: ZombieScanResult;
	deps?: DoctorSurfaceCleanupDeps;
}): Promise<DoctorSurfaceCleanupResult> {
	const deps = input.deps ?? {};
	const now = deps.now ?? Date.now;

	// Orphan launch-script sweep (optional T5): registry covers this process's
	// scripts, disk glob covers scripts left by a dead host (they carry broker
	// tokens, so a doctor run is the right moment to purge them).
	let scriptsSwept = 0;
	try {
		scriptsSwept += sweepLaunchScripts(launchScriptRegistry, now());
		scriptsSwept += sweepOrphanLaunchScriptFiles(deps.tempBase ?? getPiTempBase(), now());
	} catch {
		// best-effort — sweeping must never break the pane report
	}

	const orphans: OrphanSurfacePane[] = [];
	const seen = new Set<string>();
	for (const zombie of input.scan.zombies) {
		if (!zombie.surface || !zombie.surfacePaneId || seen.has(zombie.surfacePaneId)) continue;
		seen.add(zombie.surfacePaneId);
		orphans.push({ paneId: zombie.surfacePaneId, kind: zombie.surface, source: `zombie-scan pid ${zombie.pid}` });
	}
	const runScanLimit = deps.runScanLimit ?? ORPHAN_RUN_SCAN_LIMIT;
	// Tab-layout Task 6: terminal runs còn surface.tabs entry non-empty. Đây
	// chỉ là ứng viên — KHÔNG đóng mù theo "tabs non-empty" (manifest giữ
	// tabIds sau run end by-design); liveness + close-by-ID từng tabId qua mux.
	const terminalRunManifests = runScanLimit > 0 ? readRecentRunManifests(input.cwd, runScanLimit) : [];
	if (terminalRunManifests.length > 0) {
		for (const orphan of collectTerminalRunOrphanPanes(terminalRunManifests)) {
			if (seen.has(orphan.paneId)) continue;
			seen.add(orphan.paneId);
			orphans.push(orphan);
		}
	}
	const orphanTabs = collectTerminalRunOrphanTabs(terminalRunManifests);

	const providerNotes: string[] = [];
	const providers = new Map<"tmux" | "herdr", SurfaceProvider>();
	for (const kind of [...new Set([...orphans.map((orphan) => orphan.kind), ...orphanTabs.map((tab) => tab.kind)])]) {
		const provider = deps.providers?.[kind] ?? surfaceProviderForCleanup(kind);
		if (!provider) {
			providerNotes.push(`${kind}: provider unavailable — panes listed only`);
			continue;
		}
		try {
			const detection = provider.detect();
			if (!detection.ok) {
				providerNotes.push(`${kind}: ${detection.reason ?? "not detected"} — panes listed only`);
				continue;
			}
		} catch (error) {
			providerNotes.push(`${kind}: detect threw (${error instanceof Error ? error.message : String(error)}) — panes listed only`);
			continue;
		}
		providers.set(kind, provider);
	}

	const closed: string[] = [];
	const gone: string[] = [];
	const failures: { paneId: string; error: string }[] = [];
	for (const orphan of orphans) {
		const provider = providers.get(orphan.kind);
		if (!provider) continue; // list-only — note already recorded per kind
		try {
			const handle = provider.attach(orphan.paneId);
			if (!handle) {
				gone.push(orphan.paneId);
				continue;
			}
			// Attach của herdr là optimistic (interface sync không round-trip
			// socket được) — xác minh pane còn sống trước khi đóng. tmux attach
			// đã xác minh sync nhưng readScreen thêm một lần vẫn vô hại.
			try {
				await provider.readScreen(handle, 1);
			} catch {
				gone.push(orphan.paneId);
				continue;
			}
			await provider.closeSurface(handle, { force: true });
			closed.push(orphan.paneId);
		} catch (error) {
			failures.push({ paneId: orphan.paneId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	// Tab-layout Task 6: đóng tab orphan theo tabId TRỰC TIẾP. Doctor chạy ở
	// process khác host đã spawn nên map nội bộ tabKey của provider.closeTab
	// TRỐNG ở đây — bắt buộc đường closeTabById theo id trên manifest. Entry
	// manifest chỉ được clear (giữ key rỗng, cùng shape closeTabForRun) khi
	// MỌI tabId đã được mux xác nhận (closed/gone); còn failure thì giữ
	// nguyên để lần doctor sau thử lại (close-by-ID idempotent nên an toàn).
	const tabsClosed: string[] = [];
	const tabsGone: string[] = [];
	const tabFailures: { tabId: string; error: string }[] = [];
	const tabCloseUnsupported = new Set<string>();
	for (const orphan of orphanTabs) {
		const provider = providers.get(orphan.kind);
		if (!provider) continue; // list-only — note already recorded per kind
		if (typeof provider.closeTabById !== "function") {
			if (!tabCloseUnsupported.has(orphan.kind)) {
				tabCloseUnsupported.add(orphan.kind);
				providerNotes.push(`${orphan.kind}: closeTabById unavailable — run tabs listed only`);
			}
			continue;
		}
		let allResolved = true;
		for (const tabId of orphan.tabIds) {
			try {
				const outcome = await provider.closeTabById(tabId);
				if (outcome === "gone") tabsGone.push(tabId);
				else tabsClosed.push(tabId);
			} catch (error) {
				allResolved = false;
				tabFailures.push({ tabId, error: error instanceof Error ? error.message : String(error) });
			}
		}
		if (!allResolved) continue; // giữ nguyên entry manifest — evidence cho lần thử sau
		try {
			const manifest = JSON.parse(fs.readFileSync(orphan.manifestPath, "utf-8")) as {
				surface?: { tabs?: Record<string, unknown> };
			};
			if (Array.isArray(manifest.surface?.tabs?.[orphan.tabKey])) {
				manifest.surface.tabs[orphan.tabKey] = [];
				atomicWriteJson(orphan.manifestPath, manifest);
			}
		} catch (error) {
			tabFailures.push({
				tabId: orphan.tabIds[0] ?? orphan.tabKey,
				error: `manifest persist failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	return { orphans, closed, gone, failures, orphanTabs, tabsClosed, tabsGone, tabFailures, scriptsSwept, providerNotes };
}

export function formatOrphanPaneReport(cleanup: DoctorSurfaceCleanupResult): string {
	const lines: string[] = [];
	lines.push("## Orphan surface-pane cleanup");
	lines.push("");
	if (cleanup.orphans.length === 0) {
		lines.push("No orphan surface panes found (zombie scan + terminal-run manifests).");
	} else {
		lines.push(`Orphan panes (${cleanup.orphans.length}):`);
		for (const orphan of cleanup.orphans) {
			lines.push(`  - ${orphan.kind} pane ${orphan.paneId} — ${orphan.source}`);
		}
		lines.push("");
	}
	if (cleanup.closed.length > 0) lines.push(`Closed: ${cleanup.closed.join(", ")}`);
	if (cleanup.gone.length > 0) lines.push(`Already gone (mux no longer tracks them): ${cleanup.gone.join(", ")}`);
	if (cleanup.failures.length > 0) {
		lines.push(`Close failures (${cleanup.failures.length}):`);
		for (const failure of cleanup.failures) lines.push(`  - ${failure.paneId}: ${failure.error}`);
	}
	if (cleanup.orphanTabs.length > 0) {
		lines.push("");
		lines.push(`Orphan run tabs (${cleanup.orphanTabs.length}) — terminal runs whose surface.tabs still carry tab ids:`);
		for (const tab of cleanup.orphanTabs) {
			lines.push(`  - ${tab.kind} tab ${tab.tabIds.join(", ")} — run ${tab.runId} tabKey ${tab.tabKey} (terminal)`);
		}
	}
	if (cleanup.tabsClosed.length > 0) lines.push(`Tabs closed by id: ${cleanup.tabsClosed.join(", ")}`);
	if (cleanup.tabsGone.length > 0) lines.push(`Tabs already gone (mux no longer tracks them): ${cleanup.tabsGone.join(", ")}`);
	if (cleanup.tabFailures.length > 0) {
		lines.push(`Tab close failures (${cleanup.tabFailures.length}):`);
		for (const failure of cleanup.tabFailures) lines.push(`  - ${failure.tabId}: ${failure.error}`);
	}
	for (const note of cleanup.providerNotes) lines.push(`Note: ${note}`);
	lines.push(`Orphan launch scripts swept: ${cleanup.scriptsSwept}`);
	return lines.join("\n");
}

export async function handleDoctor(ctx: TeamContext, params: TeamToolParamsValue = {}): Promise<PiTeamsToolResult> {
	// Sub-focus: zombie sub-agent scan + orphan surface-pane cleanup (T12). The
	// process scan itself stays READ-ONLY — never kills a process. The pane
	// cleanup only closes multiplexer panes (zombie workers' panes + terminal
	// runs' leaked panes) through the provider, gated on detect(). The user's
	// main session never carries PI_CREW_KIND, so it can never appear here.
	if (params.focus === "zombies") {
		const scan = scanZombieSubagents();
		const cleanup = await cleanupOrphanSurfacePanes({ cwd: ctx.cwd, scan });
		const text = `${formatZombieReport(scan)}\n\n${formatOrphanPaneReport(cleanup)}`;
		return result(
			text,
			{
				action: "doctor",
				status: "ok",
				data: {
					zombies: scan.zombies.length,
					live: scan.live.length,
					errors: scan.errors.length,
					orphanPanes: cleanup.orphans.length,
					panesClosed: cleanup.closed.length,
					panesGone: cleanup.gone.length,
					paneCloseFailures: cleanup.failures.length,
					orphanTabs: cleanup.orphanTabs.length,
					tabsClosed: cleanup.tabsClosed.length,
					tabsGone: cleanup.tabsGone.length,
					tabCloseFailures: cleanup.tabFailures.length,
					scriptsSwept: cleanup.scriptsSwept,
				},
			},
			false,
		);
	}

	const loadedConfig = loadConfig(ctx.cwd);
	let smokeChildPi: { ok: boolean; detail: string } | undefined;
	if (configRecord(params.config).smokeChildPi === true) {
		try {
			const spec = getPiSpawnCommand(["--mode", "json", "-p", "Reply with exactly PI-TEAMS-SMOKE-OK"]);
			const output = execFileSync(spec.command, spec.args, {
				cwd: ctx.cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 15_000,
			}).trim();
			smokeChildPi = {
				ok: output.includes("PI-TEAMS-SMOKE-OK"),
				detail: output.split("\n").slice(-1)[0] ?? "completed",
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			smokeChildPi = { ok: false, detail: message };
		}
	}
	const validation = validateResources(ctx.cwd);
	const { text, hasErrors, drift } = buildTeamDoctorReport({
		cwd: ctx.cwd,
		configPath: loadedConfig.path,
		configErrors: loadedConfig.error ? [loadedConfig.error] : [],
		configWarnings: loadedConfig.warnings ?? [],
		model: ctx.model,
		validationErrors: validation.issues.filter((issue) => issue.level === "error").length,
		validationWarnings: validation.issues.filter((issue) => issue.level === "warning").length,
		smokeChildPi,
	});
	// Append detailed drift section if any drift was detected
	let finalText = text;
	if (drift?.hasDrift) {
		finalText = `${text}\n\nDrift details:\n${formatDriftReport(drift)}`;
	}
	return result(finalText, { action: "doctor", status: hasErrors ? "error" : "ok" }, hasErrors);
}
