import { getCrewEnv } from "../config/env-vars.ts";

export function logInternalError(scope: string, error: unknown, details?: string, severity?: "error" | "warn" | "debug"): void {
	// "error" and "warn" always emit; "debug" (default) is gated behind PI_TEAMS_DEBUG
	if (!severity || severity === "debug") {
		if (!getCrewEnv("PI_TEAMS_DEBUG")) return;
	}
	const message =
		error instanceof Error ? error.message : typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
	const suffix = details ? `: ${details}` : "";
	console.error(`[pi-crew:${scope}] ${message}${suffix}`);
}
