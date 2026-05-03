import type { PiTeamsConfig } from "../config/config.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";

export type CrewRuntimeMode = "auto" | "scaffold" | "child-process" | "live-session";

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
}

export async function isLiveSessionRuntimeAvailable(timeoutMs = 1500, env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; reason?: string }> {
	if (env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION !== "1") {
		return { available: false, reason: "Live-session runtime adapter is experimental and disabled. Set PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION=1 to probe SDK support." };
	}
	if (env.PI_CREW_MOCK_LIVE_SESSION === "success") {
		return { available: true, reason: "Mock live-session runtime is enabled." };
	}
	const probe = async (): Promise<{ available: boolean; reason?: string }> => {
		try {
			const mod = await import("@mariozechner/pi-coding-agent");
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
	if (requestedMode === "scaffold") return scaffoldCaps(requestedMode);
	if (workersDisabled) return scaffoldCaps(requestedMode, "Child worker execution disabled by config/env. Set runtime.mode=scaffold or executeWorkers=false only for dry runs.");
	if (requestedMode === "child-process") return childCaps(requestedMode);
	if (requestedMode === "live-session" || (requestedMode === "auto" && config.runtime?.preferLiveSession === true)) {
		const live = await isLiveSessionRuntimeAvailable(1500, env);
		if (live.available) return liveCaps(requestedMode);
		if (requestedMode === "live-session" && config.runtime?.allowChildProcessFallback === false) return { ...scaffoldCaps(requestedMode), available: false, reason: live.reason };
		return { ...childCaps(requestedMode), fallback: "child-process", reason: live.reason };
	}
	return childCaps(requestedMode);
}

function scaffoldCaps(requestedMode: CrewRuntimeMode, reason?: string): CrewRuntimeCapabilities {
	return { kind: "scaffold", requestedMode, available: true, steer: false, resume: false, liveToolActivity: false, transcript: false, ...(reason ? { reason } : {}) };
}

function childCaps(requestedMode: CrewRuntimeMode, reason?: string): CrewRuntimeCapabilities {
	return { kind: "child-process", requestedMode, available: true, steer: false, resume: false, liveToolActivity: false, transcript: true, ...(reason ? { reason } : {}) };
}

function liveCaps(requestedMode: CrewRuntimeMode): CrewRuntimeCapabilities {
	return { kind: "live-session", requestedMode, available: true, steer: true, resume: true, liveToolActivity: true, transcript: true };
}
