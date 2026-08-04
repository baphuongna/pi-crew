import { isSecretKey } from "./redaction.ts";

// Well-known LLM provider API keys that are intentionally allowlisted in
// child-pi.ts and async-runner.ts for pass-through to worker processes.
// These are "secret" by pattern (contain KEY/API) but are safe to allowlist
// because they are standard provider credentials, not arbitrary secrets.
const KNOWN_PROVIDER_KEYS = new Set([
	"MINIMAX_API_KEY",
	"MINIMAX_GROUP_ID",
	"OPENAI_API_KEY",
	"OPENAI_ORG_ID",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GENERATIVE_LANGUAGE_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_ENDPOINT",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_REGION",
	"ZEU_API_KEY",
	"ZERODEV_API_KEY",
]);

// Map from provider prefix (lowercase) to env var names.
// Used by providerEnvKeys() to scope API keys per task.
const PROVIDER_ENV_KEY_MAP: Record<string, string[]> = {
	minimax: ["MINIMAX_API_KEY", "MINIMAX_GROUP_ID"],
	openai: ["OPENAI_API_KEY", "OPENAI_ORG_ID"],
	anthropic: ["ANTHROPIC_API_KEY"],
	google: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_LANGUAGE_API_KEY"],
	gemini: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_LANGUAGE_API_KEY"],
	azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
	"azure-openai": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
	aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
	bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
	zai: ["ZEU_API_KEY"],
	zerodev: ["ZERODEV_API_KEY"],
};

function isKnownProviderKey(key: string): boolean {
	return KNOWN_PROVIDER_KEYS.has(key);
}

/**
 * Extract provider prefix from a model ID string and return the corresponding
 * env var names. Returns empty array for unknown/custom providers or invalid input.
 *
 * @param modelId - Model in "provider/modelId" format (e.g. "openai/gpt-4o")
 * @returns Array of env var names needed for this provider
 */
export function providerEnvKeys(modelId: string | undefined): string[] {
	if (!modelId) return [];
	const separatorIndex = modelId.indexOf("/");
	if (separatorIndex <= 0) return [];
	const provider = modelId.substring(0, separatorIndex).toLowerCase();
	return PROVIDER_ENV_KEY_MAP[provider] ?? [];
}

/**
 * Build a scoped allowlist that includes system vars + only the provider keys
 * relevant to the assigned model (and its fallback chain).
 *
 * @param baseAllowList - Non-provider system vars to always include
 * @param models - Model IDs to include provider keys for (primary + fallbacks)
 * @returns Combined allowlist with scoped provider keys
 */
export function buildScopedAllowList(baseAllowList: string[], models: (string | undefined)[]): string[] {
	const providerKeys = new Set<string>();
	for (const model of models) {
		for (const key of providerEnvKeys(model)) {
			providerKeys.add(key);
		}
	}
	return [...baseAllowList, ...providerKeys];
}

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
			// Validate non-glob entries don't look like secret keys.
			// Exception 1: if the key exists in env, it was intentionally set and
			// should be allowed through (user knows what they're doing).
			// Exception 2: known provider keys (MINIMAX_API_KEY, etc.) are always
			// allowed because they are standard provider credentials explicitly
			// listed in async-runner.ts / child-pi.ts allowlists.
			if (!pattern.endsWith("*") && isSecretKey(pattern) && !(pattern in env) && !isKnownProviderKey(pattern)) {
				throw new Error(`Allowlist entry "${pattern}" looks like a secret key. Use a more specific pattern.`);
			}
		}
		// Separate exact entries (explicitly trusted) from glob patterns.
		// Exact entries (e.g. provider API keys) are deliberately listed by the
		// caller and validated above; they must pass through unchanged.
		const exact = new Set<string>();
		const globPrefixes: string[] = [];
		for (const p of options.allowList) {
			if (p.endsWith("*")) {
				// Trailing glob: match keys that start with the prefix AND have at
				// least one additional character (distinguishes "PI_CREW_*" from "PI_CREW_").
				globPrefixes.push(p.slice(0, -1));
			} else {
				exact.add(p);
			}
		}
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) continue;
			// Exact allow-list entries are explicitly trusted (e.g. ANTHROPIC_API_KEY
			// scoped to a model). No secondary secret check — the caller vouches for them.
			if (exact.has(key)) {
				filtered[key] = value;
				continue;
			}
			// Glob-matched keys (e.g. PI_CREW_*): NEW-S1 secondary guard — a broad glob
			// must not forward secret-named keys (PI_CREW_OPENAI_API_KEY,
			// PI_CREW_SECRET_TOKEN, ...) to spawned hook scripts with process access.
			if (globPrefixes.some((prefix) => key.startsWith(prefix) && key.length > prefix.length) && !isSecretKey(key)) {
				filtered[key] = value;
			}
		}
		return filtered;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && !isSecretKey(key)) filtered[key] = value;
	}
	return filtered;
}
