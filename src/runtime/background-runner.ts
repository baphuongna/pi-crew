import * as fs from "node:fs";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { appendEvent } from "../state/event-log.ts";
import { loadRunManifestById, saveRunManifest, updateRunStatus } from "../state/state-store.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { loadConfig } from "../config/config.ts";
// Heavy runtime — lazy-loaded to avoid pulling team-runner into background-runner
// at module load time. Only needed when a background run actually starts.
import type { executeTeamRun as ExecuteTeamRunFn } from "./team-runner.ts";
let _cachedExecuteTeamRun: typeof ExecuteTeamRunFn | undefined;
async function executeTeamRun(...args: Parameters<typeof ExecuteTeamRunFn>): Promise<Awaited<ReturnType<typeof ExecuteTeamRunFn>>> {
	if (!_cachedExecuteTeamRun) {
		// LAZY: avoid pulling team-runner into background-runner at module load time.
		const mod = await import("./team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}
import { resolveCrewRuntime, runtimeResolutionState } from "./runtime-resolver.ts";
import { directTeamAndWorkflowFromRun } from "./direct-run.ts";
import { expandParallelResearchWorkflow } from "./parallel-research.ts";
import { writeAsyncStartMarker } from "./async-marker.ts";
import { startParentGuard, stopParentGuard } from "./parent-guard.ts";

/**
 * Heartbeat mechanism: periodically write a heartbeat file so the stale reconciler
 * can distinguish "process died" from "process still alive but quiet".
 * Without this, the reconciler relies solely on process.kill(pid, 0) which can
 * false-positive when a process is SIGKILLed and the PID hasn't been recycled yet.
 */
function startHeartbeat(stateRoot: string, eventsPath: string, runId: string): () => void {
	const heartbeatPath = path.join(stateRoot, "heartbeat.json");
	const writeHeartbeat = (): void => {
		try {
			const mem = process.memoryUsage();
			fs.writeFileSync(heartbeatPath, JSON.stringify({
				pid: process.pid,
				at: Date.now(),
				runId,
				memory: { heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024), rssMb: Math.round(mem.rss / 1024 / 1024) },
			}), "utf-8");
		} catch {
			/* ignore — best-effort */
		}
	};
	// Write immediately so the stale reconciler can use heartbeat age as liveness evidence.
	writeHeartbeat();
	const interval = setInterval(writeHeartbeat, 15_000);
	interval.unref();
	return () => clearInterval(interval);
}

/**
 * Remove macOS malloc-stack-logging vars that get inherited by child shells.
 * Without this, every subprocess prints "MallocStackLogging: can't turn off..." to stderr.
 */
function scrubProcessEnv(): void {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
}

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

function startInterruptGuard(manifest: { runId: string; stateRoot: string; eventsPath: string }): () => void {
	const controlPath = path.join(manifest.stateRoot, "foreground-control.json");
	const interval = setInterval(() => {
		try {
			if (!fs.existsSync(controlPath)) return;
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf-8")) as { requests?: Array<{ type: string; acknowledged?: boolean }> };
			const last = parsed.requests?.at(-1);
			if (last?.type === "interrupt" && last?.acknowledged !== true) {
				appendEvent(manifest.eventsPath, { type: "async.interrupt_detected", runId: manifest.runId, message: "Background runner detected foreground interrupt request — exiting." });
				process.exit(130);
			}
		} catch {
			/* ignore read/parse errors */
		}
	}, 3_000);
	interval.unref();
	return () => clearInterval(interval);
}

/**
 * CRITICAL: Node.js v24 throws on unhandled rejections by default.
 * Without this handler, any unhandled promise rejection (e.g., from cleanupTempDir,
 * terminateLiveAgentsForRun, or other async cleanup) will crash the background runner
 * BEFORE async.completed is written to the event log.
 * This causes the async notifier to falsely detect a stuck run after quietMs expires.
 */
function setupUnhandledRejectionGuard(state: { cwd?: string; runId?: string; eventsPath?: string }): void {
	process.on("unhandledRejection", (reason, promise) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		console.error("[background-runner] UNHANDLED REJECTION:", reason);
		try {
			// Try to write async.failed event if we have the necessary state
			if (state.eventsPath && state.runId) {
				appendEvent(state.eventsPath, {
					type: "async.failed",
					runId: state.runId,
					message: `Unhandled rejection: ${message}`,
					data: { reason: String(reason), handled: false },
				});
			}
		} catch (appendErr) {
			console.error("[background-runner] Failed to write async.failed event:", appendErr);
		}
		process.exitCode = 1;
		// Give async operations a moment to flush before exit
		setTimeout(() => process.exit(1), 100);
	});
}

async function main(): Promise<void> {
	// Scrub macOS malloc vars BEFORE anything else — must be clean for all child processes
	scrubProcessEnv();
	// Install signal handlers EARLY — log events before exiting so we can distinguish
	// OOM/SIGKILL (no event) from SIGTERM/SIGINT (event written).
	const signalLog = (sig: string): void => {
		const cwd = argValue("--cwd");
		const runId = argValue("--run-id");
		if (cwd && runId) {
			const loaded = loadRunManifestById(cwd, runId);
			if (loaded) appendEvent(loaded.manifest.eventsPath, { type: "async.failed", runId, message: `Background runner received ${sig} — exiting.`, data: { signal: sig, pid: process.pid } });
		}
	};
	process.on("SIGTERM", () => {
		// Capture caller identity via /proc/$ppid — Linux-specific
		let callerInfo = "unknown";
		let isPiProcess = false;
		try {
			const ppid = process.ppid;
			callerInfo = `ppid=${ppid}`;
			const cmdlinePath = `/proc/${ppid}/cmdline`;
			const statPath = `/proc/${ppid}/stat`;
			try {
				const cmdline = require("node:fs").readFileSync(cmdlinePath, "utf8").replace(/\0/g, " ").trim();
				const stat = require("node:fs").readFileSync(statPath, "utf8");
				const statParts = stat.split(" ");
				const ppidOfPpid = statParts[3];
				callerInfo += ` cmdline="${cmdline.slice(0, 120)}" ppid_of_ppid=${ppidOfPpid}`;
				// Check if sender is Pi process (infrastructure cleanup signal)
				isPiProcess = cmdline.includes("pi") && ppidOfPpid !== "1";
			} catch { /* best-effort */ }
		} catch { /* best-effort */ }
		// A2: Ignore SIGTERM from Pi infrastructure — Pi sends SIGTERM to cleanup
		// children when tool call returns, but this is NOT a real error condition
		// if the background runner is still doing useful work.
		if (isPiProcess) {
			const cwd = argValue("--cwd");
			const runId = argValue("--run-id");
			if (cwd && runId) {
				const loaded = loadRunManifestById(cwd, runId);
				if (loaded) appendEvent(loaded.manifest.eventsPath, { type: "async.sigterm_ignored", runId, message: `Background runner ignored SIGTERM from Pi infrastructure (${callerInfo}) — continuing work.`, data: { signal: "SIGTERM", pid: process.pid, ppid: process.ppid, callerInfo } });
			}
			return; // Don't exit — let the run complete
		}
		const cwd = argValue("--cwd");
		const runId = argValue("--run-id");
		if (cwd && runId) {
			const loaded = loadRunManifestById(cwd, runId);
			if (loaded) appendEvent(loaded.manifest.eventsPath, { type: "async.failed", runId, message: `Background runner received SIGTERM from ${callerInfo} — exiting.`, data: { signal: "SIGTERM", pid: process.pid, ppid: process.ppid, callerInfo } });
		}
		process.exit(143);
	});
	process.on("SIGINT", () => { signalLog("SIGINT"); process.exit(130); });
	// Hook Node.js abort — if process.exit is called with code 1 (uncaught exception, assert failure)
	// we log it before exiting so it appears in background.log
	const origExit = process.exit.bind(process);
	// Intercept all exit(code) calls to log them as async.exit events before exiting.
	// This surfaces uncaught exceptions / early exits that would otherwise vanish silently.
	process.exit = ((code?: number | string): never => {
		if (code !== undefined) {
			const cwd2 = argValue("--cwd");
			const runId2 = argValue("--run-id");
			if (cwd2 && runId2) {
				try {
					const loaded = loadRunManifestById(cwd2, runId2);
					if (loaded) {
						appendEvent(loaded.manifest.eventsPath, { type: "async.exit", runId: runId2, message: `Background runner exit(${code})`, data: { code, pid: process.pid } });
					}
				} catch { /* best-effort */ }
			}
		}
		return origExit(code);
	}) as typeof process.exit;

	// Start parent guard FIRST — if parent is already dead, exit immediately
	const parentPid = Number(process.env.PI_CREW_PARENT_PID);
	if (parentPid > 0) startParentGuard(parentPid);

	const cwd = argValue("--cwd");
	const runId = argValue("--run-id");
	if (!cwd || !runId) throw new Error("Usage: background-runner.ts --cwd <cwd> --run-id <runId>");

	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) throw new Error(`Run '${runId}' not found.`);
	let { manifest, tasks } = loaded;

	// Setup unhandled rejection guard EARLY — must be before any async operations
	// that might produce unhandled rejections during cleanup.
	const rejectionGuardState = { cwd, runId, eventsPath: loaded.manifest.eventsPath };
	setupUnhandledRejectionGuard(rejectionGuardState);

	appendEvent(manifest.eventsPath, { type: "async.started", runId: manifest.runId, data: { pid: process.pid } });
	writeAsyncStartMarker(manifest, { pid: process.pid, startedAt: new Date().toISOString() });
	const stopHeartbeat = startHeartbeat(manifest.stateRoot, manifest.eventsPath, manifest.runId);
	const stopInterruptGuard = startInterruptGuard(manifest);

	try {
		const agents = allAgents(discoverAgents(cwd));
		const direct = directTeamAndWorkflowFromRun(manifest, tasks, agents);
		const team = direct?.team ?? allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === manifest.team);
		if (!team) throw new Error(`Team '${manifest.team}' not found.`);
		const baseWorkflow = direct?.workflow ?? allWorkflows(discoverWorkflows(cwd)).find((candidate) => candidate.name === manifest.workflow);
		if (!baseWorkflow) throw new Error(`Workflow '${manifest.workflow ?? ""}' not found.`);
		const workflow = expandParallelResearchWorkflow(baseWorkflow, cwd);
		const loadedConfig = loadConfig(cwd);
		const runConfig = manifest.runConfig && typeof manifest.runConfig === "object" && !Array.isArray(manifest.runConfig) ? manifest.runConfig as typeof loadedConfig.config : loadedConfig.config;
		const runtime = manifest.runtimeResolution ? { kind: manifest.runtimeResolution.kind, requestedMode: manifest.runtimeResolution.requestedMode, available: manifest.runtimeResolution.available, fallback: manifest.runtimeResolution.fallback, steer: manifest.runtimeResolution.kind === "live-session", resume: manifest.runtimeResolution.kind === "live-session", liveToolActivity: manifest.runtimeResolution.kind === "live-session", transcript: manifest.runtimeResolution.kind !== "scaffold", reason: manifest.runtimeResolution.reason, safety: manifest.runtimeResolution.safety } : await resolveCrewRuntime(runConfig);
		const runtimeResolution = manifest.runtimeResolution ?? runtimeResolutionState(runtime);
		manifest = { ...manifest, runtimeResolution, runConfig, updatedAt: new Date().toISOString() };
		saveRunManifest(manifest);
		appendEvent(manifest.eventsPath, { type: "runtime.resolved", runId: manifest.runId, message: `Runtime resolved: ${runtime.kind} safety=${runtime.safety}`, data: { runtimeResolution, async: true } });
		if (runtime.safety === "blocked") throw new Error(runtime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.");
		const executeWorkers = runtime.kind !== "scaffold";
		// Use ownerSessionId for workspaceId to ensure agents are only visible to the session that spawned them.
		// manifest.cwd would cause cross-session visibility since all sessions share the same project directory.
		// Mark this as background mode so task-runner writes events to background.log for debugging.
		process.env.PI_CREW_BACKGROUND_MODE = "1";
		const result = await executeTeamRun({ manifest, tasks, team, workflow, agents, executeWorkers, limits: runConfig.limits, runtime, runtimeConfig: runConfig.runtime, skillOverride: manifest.skillOverride, reliability: runConfig.reliability, workspaceId: manifest.ownerSessionId ?? manifest.cwd });
		manifest = result.manifest;
		tasks = result.tasks;
		appendEvent(manifest.eventsPath, { type: "async.completed", runId: manifest.runId, data: { status: manifest.status, tasks: tasks.length } });
		if (manifest.status === "failed" || manifest.status === "cancelled" || manifest.status === "blocked") process.exitCode = 1;
	} catch (error) {
		// Terminate live agents on failure too — agents are done when the run fails
		try {
			const loaded = loadRunManifestById(cwd, runId);
			if (loaded) {
				// LAZY: live-agent-manager only needed on failure cleanup path; avoid module load at hot path.
				const { terminateLiveAgentsForRun } = await import("./live-agent-manager.ts");
				void terminateLiveAgentsForRun(loaded.manifest.runId, "failed", appendEvent, loaded.manifest.eventsPath).catch(() => {});
			}
		} catch { /* best-effort */ }
		const message = error instanceof Error ? error.message : String(error);
		manifest = updateRunStatus(manifest, "failed", message);
		appendEvent(manifest.eventsPath, { type: "async.failed", runId: manifest.runId, message });
		process.exitCode = 1;
	} finally {
		stopInterruptGuard();
		stopParentGuard();
		stopHeartbeat();
	}
}

await main();
