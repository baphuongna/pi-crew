import { isSecretKey } from "./redaction.ts";

export interface SanitizeEnvOptions {
	/** Allow-list of env var names to preserve. Supports trailing glob, e.g. `"PI_*"`. */
	allowList?: string[];
}

// Keywords that indicate a secret env var
const SECRET_SUFFIXES = ["token", "api", "key", "password", "passwd", "secret", "credential", "authorization", "private"];

/**
 * Check if a glob pattern could match secret env vars.
 * A pattern like "PI_*" is dangerous because it could match PI_TOKEN, PI_API_KEY, etc.
 *
 * Exception: `PI_CREW_*` is a controlled namespace — the pi-crew codebase owns
 * every PI_CREW_* env var (PI_CREW_PARENT_PID, PI_CREW_ADAPTIVE_REPAIR, etc.)
 * and none of them are secrets. Allowing the glob here lets child Pi processes
 * inherit our config without needing a per-var allowlist.
 */
function isDangerousGlob(pattern: string): boolean {
	if (!pattern.endsWith("*")) return false;
	const prefix = pattern.slice(0, -1); // Remove trailing *
	if (prefix === "") return true; // Single "*" matches everything
	// PI_CREW_* is the pi-crew controlled namespace — no secrets live here.
	// This covers PI_CREW_*, PI_CREW_TEAMS_*, PI_CREW_AGENT_*, etc.
	if (prefix.startsWith("PI_CREW_") || prefix === "PI_CREW") return false;
	// Check if combining the prefix with any secret suffix would create a secret key
	for (const suffix of SECRET_SUFFIXES) {
		if (isSecretKey(prefix + suffix)) {
			return true;
		}
	}
	return false;
}

/**
 * Strip env vars whose keys look like secrets before passing to child processes.
 *
 * Default mode (no allowList): deny-list using isSecretKey.
 * When allowList is provided, only keys matching the allow-list are preserved.
 */
export function sanitizeEnvSecrets(env: NodeJS.ProcessEnv, options?: SanitizeEnvOptions): Record<string, string> {
	const filtered: Record<string, string> = {};
	if (options?.allowList && options.allowList.length > 0) {
		// Validate allowlist patterns don't match secrets
		for (const pattern of options.allowList) {
			if (isDangerousGlob(pattern)) {
				throw new Error(`Allowlist pattern "${pattern}" could match secret env vars. Use a more specific pattern.`);
			}
			// Validate non-glob entries don't look like secret keys — but skip the check
			// if the key actually exists in env. This allows intentional allowlisting of
			// known provider keys (MINIMAX_API_KEY, ANTHROPIC_API_KEY, etc.) that are
			// legitimately needed by child Pi processes, while still catching accidental
			// additions like "SECRET_TOKEN = ..." in config files.
			if (!pattern.endsWith("*") && isSecretKey(pattern) && !(pattern in env)) {
				throw new Error(`Allowlist entry "${pattern}" looks like a secret key. Use a more specific pattern.`);
			}
		}
		const matchers = options.allowList.map((p) => {
			if (p.endsWith("*")) {
				// Glob pattern: matches keys that start with the prefix AND have
				// at least one additional character (distinguishes "PI_CREW_*" from "PI_CREW_").
				// For example, "PI_CREW_*" matches "PI_CREW_DEPTH" but not "PI_CREW_".
				// This ensures trailing glob patterns require extra chars, not exact-prefix-only matches.
				const prefix = p.slice(0, -1);
				return (k: string) => k.startsWith(prefix) && k.length > prefix.length;
			}
			// Exact match is case-sensitive; Unix env vars are uppercase by convention.
			return (k: string) => k === p;
		});
		for (const [key, value] of Object.entries(env)) {
			if (value !== undefined && matchers.some((fn) => fn(key))) filtered[key] = value;
		}
		return filtered;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !isSecretKey(key)) filtered[key] = value;
	}
	return filtered;
}