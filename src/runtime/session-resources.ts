import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { logInternalError } from "../utils/internal-error.ts";

/**
 * Try to register a cleanup function with Pi's session resource cleanup API (v0.72+).
 * Falls back to returning undefined if the API is not available.
 *
 * The returned function (if defined) can be called to unregister the cleanup.
 */
export function tryRegisterSessionCleanup(pi: ExtensionAPI, cleanup: () => void): (() => void) | undefined {
	const api = pi as unknown as Record<string, unknown>;
	const registerFn = api["registerSessionResourceCleanup"];
	if (typeof registerFn === "function") {
		try {
			const unregister = (registerFn as (fn: () => void) => (() => void) | void)(cleanup);
			if (typeof unregister === "function") return unregister;
			// API returned void — cleanup is registered but cannot be unregistered
			return undefined;
		} catch (error) {
			logInternalError("session-resources.register", error);
			return undefined;
		}
	}
	return undefined;
}
