import type { PiTeamsConfig } from "../config/config.ts";
import type { RuntimeResolutionState } from "../state/types.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";

export type CrewRuntimeMode = "auto" | "scaffold" | "child-process" | "live-session";

export type CrewRuntimeSafety = "trusted" | "explicit_dry_run" | "blocked";

export interface CrewRuntimeCapabilities {
	kind: CrewRuntimeKind;
	requestedMode: CrewRuntimeMode;
	available: boolean;
	fallback?: CrewRuntimeKind;
	steer: boolean;
	resume: boolean;
	liveToolActivity: boolean;
	transcript: boolean;
	reason?: string;
	safety: CrewRuntimeSafety;
}

export function runtimeResolutionState(runtime: CrewRuntimeCapabilities, resolvedAt = new Date().toISOString()): RuntimeResolutionState {
	return {
		kind: runtime.kind,
		requestedMode: runtime.requestedMode,
		safety: runtime.safety,
		available: runtime.available,
		...(runtime.fallback ? { fallback: runtime.fallback } : {}),
		...(runtime.reason ? { reason: runtime.reason } : {}),
		resolvedAt,
	};
}

export async function isLiveSessionRuntimeAvailable(timeoutMs = 1500, env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; reason?: string }> {
	if (env.PI_CREW_MOCK_LIVE_SESSION === "success") {
		return { available: true, reason: "Mock live-session runtime is enabled." };
	}
	const probe = async (): Promise<{ available: boolean; reason?: string }> => {
		try {
			// LAZY: optional peer dependency — probe at runtime to avoid hard dependency.
			const mod = await import("@earendil-works/pi-coding-agent");
			const api = mod as Record<string, unknown>;
			const required = ["createAgentSession", "DefaultResourceLoader", "SessionManager", "SettingsManager"];
			const missing = required.filter((name) => typeof api[name] === "undefined");
			if (missing.length) return { available: false, reason: `Pi SDK live-session exports missing: ${missing.join(", ")}.` };
			return { available: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { available: false, reason: `Could not load optional Pi SDK live-session runtime: ${message}` };
		}
	};
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			probe(),
			new Promise<{ available: boolean; reason: string }>((resolve) => {
				timer = setTimeout(() => resolve({ available: false, reason: `Timed out probing optional Pi SDK live-session runtime after ${timeoutMs}ms.` }), timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function resolveCrewRuntime(config: PiTeamsConfig, env: NodeJS.ProcessEnv = process.env): Promise<CrewRuntimeCapabilities> {
	const requestedMode = config.runtime?.mode ?? "auto";
	const workersDisabled = config.executeWorkers === false || env.PI_CREW_EXECUTE_WORKERS === "0" || env.PI_TEAMS_EXECUTE_WORKERS === "0";
	if (requestedMode === "scaffold") return scaffoldCaps(requestedMode, undefined, "explicit_dry_run");
	if (workersDisabled) return scaffoldCaps(requestedMode, "Child worker execution disabled by config/env. Set runtime.mode=scaffold or executeWorkers=false only for dry runs.", "blocked");
	if (requestedMode === "child-process") return childCaps(requestedMode);
	// When a child-process mock is active (tests), force auto-mode to child-process where the mock is active.
	if (requestedMode === "auto" && env.PI_TEAMS_MOCK_CHILD_PI) return childCaps(requestedMode, "PI_TEAMS_MOCK_CHILD_PI mock forces child-process runtime in auto mode.");
	if (requestedMode === "live-session") {
		const live = await isLiveSessionRuntimeAvailable(1500, env);
		if (live.available) return liveCaps(requestedMode);
		if (config.runtime?.allowChildProcessFallback === false)
			return scaffoldCaps(requestedMode, live.reason, "blocked");
		return { ...childCaps(requestedMode), fallback: "child-process", reason: live.reason };
	}
	// auto mode: use child-process unless preferLiveSession is explicitly enabled
	if (requestedMode === "auto") {
		// Check for mock env var first (for testing)
		if (env.PI_CREW_MOCK_LIVE_SESSION === "success") {
			const live = await isLiveSessionRuntimeAvailable(1500, env);
			if (live.available) return liveCaps(requestedMode);
		}
		// Then check explicit config preference
		if (config.runtime?.preferLiveSession === true) {
			const live = await isLiveSessionRuntimeAvailable(1500, env);
			if (live.available) return liveCaps(requestedMode);
		}
	}
	return childCaps(requestedMode);
}

function scaffoldCaps(requestedMode: CrewRuntimeMode, reason?: string, safety: CrewRuntimeSafety = "explicit_dry_run"): CrewRuntimeCapabilities {
	return { kind: "scaffold", requestedMode, available: safety !== "blocked", steer: false, resume: false, liveToolActivity: false, transcript: false, safety, ...(reason ? { reason } : {}) };
}

function childCaps(requestedMode: CrewRuntimeMode, reason?: string): CrewRuntimeCapabilities {
	return { kind: "child-process", requestedMode, available: true, steer: true, resume: false, liveToolActivity: false, transcript: true, safety: "trusted", ...(reason ? { reason } : {}) };
}

function liveCaps(requestedMode: CrewRuntimeMode): CrewRuntimeCapabilities {
	return { kind: "live-session", requestedMode, available: true, steer: true, resume: true, liveToolActivity: true, transcript: true, safety: "trusted" };
}
