/**
 * Self-contained provider rate-limit usage fetcher for crew-vibes.
 *
 * Reads credentials from `~/.pi/agent/auth.json` (plus env overrides) and
 * queries the Anthropic OAuth usage endpoint (primary) and the Copilot
 * internal quota endpoint (secondary). All failure paths return `null`
 * gracefully so headless / credential-less sessions never crash.
 *
 * No external dependencies — only Node.js built-ins (fs, path, os).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderUsage {
	fiveHourPercent: number;
	weeklyPercent: number;
	resetAt: string | null; // ISO string
	copilotMonthlyPercent?: number; // optional, for Copilot
}

/** AbortController + setTimeout helper. Always clears the timer. */
function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), ms);
	return fn(controller.signal).finally(() => clearTimeout(timeoutId));
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

function piAuthPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

/** Load the Anthropic OAuth access token from auth.json or env override. */
export function loadAnthropicToken(): string | undefined {
	const envToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
	if (envToken) return envToken;
	try {
		const data = JSON.parse(readFileSync(piAuthPath(), "utf8")) as {
			anthropic?: { access?: string };
		};
		const token = data.anthropic?.access;
		return typeof token === "string" && token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

/** Load the z.ai API key from env or auth.json. */
export function loadZaiToken(): string | undefined {
	const envKey = process.env.ZAI_API_KEY?.trim() || process.env.Z_AI_API_KEY?.trim();
	if (envKey) return envKey;
	try {
		const data = JSON.parse(readFileSync(piAuthPath(), "utf8")) as {
			"z-ai"?: { access?: string; key?: string };
			zai?: { access?: string; key?: string };
		};
		const key = data["z-ai"]?.access || data["z-ai"]?.key || data.zai?.access || data.zai?.key;
		return typeof key === "string" && key.length > 0 ? key : undefined;
	} catch {
		return undefined;
	}
}

/** Copilot host entry keys used by the legacy GitHub Copilot CLI. */
type CopilotHostEntry = {
	oauth_token?: string;
	user_token?: string;
	github_token?: string;
	token?: string;
};

const COPILOT_TOKEN_KEYS: Array<keyof CopilotHostEntry> = [
	"oauth_token",
	"user_token",
	"github_token",
	"token",
];

function tokenFromHostEntry(entry: CopilotHostEntry | undefined): string | undefined {
	if (!entry) return undefined;
	for (const key of COPILOT_TOKEN_KEYS) {
		const value = entry[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** Scan legacy Copilot hosts.json locations for a usable token. */
function loadLegacyCopilotToken(): string | undefined {
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	const candidates = [
		join(configHome, "github-copilot", "hosts.json"),
		join(homedir(), ".github-copilot", "hosts.json"),
	];
	for (const hostsPath of candidates) {
		try {
			const data = JSON.parse(readFileSync(hostsPath, "utf8")) as Record<string, CopilotHostEntry>;
			if (!data || typeof data !== "object") continue;
			const normalized: Record<string, CopilotHostEntry> = {};
			for (const [host, entry] of Object.entries(data)) {
				normalized[host.toLowerCase()] = entry;
			}
			const preferred = tokenFromHostEntry(normalized["github.com"]) ?? tokenFromHostEntry(normalized["api.github.com"]);
			if (preferred) return preferred;
			for (const entry of Object.values(normalized)) {
				const token = tokenFromHostEntry(entry);
				if (token) return token;
			}
		} catch {
			// Ignore parse / read errors — try next path
		}
	}
	return undefined;
}

/** Load the Copilot token from auth.json, env vars, then legacy locations. */
export function loadCopilotToken(): string | undefined {
	const envToken = (
		process.env.COPILOT_GITHUB_TOKEN ||
		process.env.GH_TOKEN ||
		process.env.GITHUB_TOKEN ||
		""
	).trim();
	if (envToken) return envToken;
	try {
		const data = JSON.parse(readFileSync(piAuthPath(), "utf8")) as {
			"github-copilot"?: { refresh?: string; access?: string };
		};
		const piToken = data["github-copilot"]?.refresh || data["github-copilot"]?.access;
		if (typeof piToken === "string" && piToken.length > 0) return piToken;
	} catch {
		// Ignore parse / read errors
	}
	return loadLegacyCopilotToken();
}

// ---------------------------------------------------------------------------
// Provider fetches
// ---------------------------------------------------------------------------

/** Anthropic OAuth usage response shape (subset we consume). */
type AnthropicUsageResponse = {
	five_hour?: { utilization?: number; resets_at?: string };
	seven_day?: { utilization?: number; resets_at?: string };
};

async function fetchAnthropicUsage(token: string): Promise<Pick<ProviderUsage, "fiveHourPercent" | "weeklyPercent" | "resetAt">> {
	const data = await withTimeout(10000, async (signal) => {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal,
		});
		if (!res.ok) throw new Error(`anthropic usage HTTP ${res.status}`);
		return (await res.json()) as AnthropicUsageResponse;
	});
	return {
		fiveHourPercent: data.five_hour?.utilization ?? 0,
		weeklyPercent: data.seven_day?.utilization ?? 0,
		resetAt: data.five_hour?.resets_at ?? null,
	};
}

/** Copilot internal user quota response shape (subset we consume). */
type CopilotUserResponse = {
	quota_snapshots?: {
		premium_interactions?: { percent_remaining?: number };
	};
};

async function fetchCopilotMonthlyPercent(token: string): Promise<number | undefined> {
	const data = await withTimeout(10000, async (signal) => {
		const res = await fetch("https://api.github.com/copilot_internal/user", {
			headers: {
				Authorization: `token ${token}`,
				"Editor-Version": "vscode/1.96.2",
				"User-Agent": "GitHubCopilotChat/0.26.7",
				"X-Github-Api-Version": "2025-04-01",
				Accept: "application/json",
			},
			signal,
		});
		if (!res.ok) throw new Error(`copilot user HTTP ${res.status}`);
		return (await res.json()) as CopilotUserResponse;
	});
	const percentRemaining = data.quota_snapshots?.premium_interactions?.percent_remaining;
	if (typeof percentRemaining !== "number") return undefined;
	return Math.max(0, 100 - percentRemaining);
}

/** z.ai quota limit response shape. */
type ZaiLimit = {
	type?: string;
	percentage?: number;
	nextResetTime?: string;
};
type ZaiUsageResponse = {
	success?: boolean;
	code?: number;
	msg?: string;
	data?: { limits?: ZaiLimit[] };
};

async function fetchZaiUsage(token: string): Promise<ProviderUsage> {
	const data = await withTimeout(10000, async (signal) => {
		const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
			},
			signal,
		});
		if (!res.ok) throw new Error(`z.ai usage HTTP ${res.status}`);
		return (await res.json()) as ZaiUsageResponse;
	});
	if (!data.success || data.code !== 200) throw new Error(data.msg || "z.ai API error");

	const limits = data.data?.limits ?? [];
	let tokensPercent = 0;
	let monthlyPercent = 0;
	let resetAt: string | null = null;

	for (const limit of limits) {
		const pct = limit.percentage ?? 0;
		if (limit.type === "TOKENS_LIMIT") {
			tokensPercent = pct;
			resetAt = limit.nextResetTime ?? resetAt;
		} else if (limit.type === "TIME_LIMIT") {
			monthlyPercent = pct;
			resetAt = limit.nextResetTime ?? resetAt;
		}
	}

	return {
		fiveHourPercent: tokensPercent,
		weeklyPercent: monthlyPercent,
		resetAt,
	};
}

// ---------------------------------------------------------------------------
// Cache + public entry point
// ---------------------------------------------------------------------------

let cachedUsage: ProviderUsage | null = null;
let cachedAt = 0;

/** Reset the module-level cache (used by tests and on session restart). */
export function clearProviderUsageCache(): void {
	cachedUsage = null;
	cachedAt = 0;
}

/**
 * Fetch provider rate-limit usage, caching the result for `maxAgeMs`.
 *
 * Tries providers in order: Anthropic → z.ai → Copilot.
 * Returns the first one that has credentials + responds successfully.
 * Returns `null` when no credentials exist or all fetches fail — never throws.
 */
export async function fetchProviderUsage(maxAgeMs = 300000): Promise<ProviderUsage | null> {
	// Serve fresh-enough cache without hitting the network.
	if (cachedUsage !== null && Date.now() - cachedAt < maxAgeMs) {
		return cachedUsage;
	}

	try {
		// Try Anthropic first
		const anthropicToken = loadAnthropicToken();
		if (anthropicToken) {
			const base = await fetchAnthropicUsage(anthropicToken);
			const usage: ProviderUsage = {
				fiveHourPercent: base.fiveHourPercent,
				weeklyPercent: base.weeklyPercent,
				resetAt: base.resetAt,
			};
			cachedUsage = usage;
			cachedAt = Date.now();
			return usage;
		}

		// Try z.ai
		const zaiToken = loadZaiToken();
		if (zaiToken) {
			const usage = await fetchZaiUsage(zaiToken);
			cachedUsage = usage;
			cachedAt = Date.now();
			return usage;
		}

		// Try Copilot
		const copilotToken = loadCopilotToken();
		if (copilotToken) {
			const monthlyPercent = await fetchCopilotMonthlyPercent(copilotToken);
			if (monthlyPercent !== undefined) {
				const usage: ProviderUsage = {
					fiveHourPercent: 0,
					weeklyPercent: monthlyPercent,
					resetAt: null,
					copilotMonthlyPercent: monthlyPercent,
				};
				cachedUsage = usage;
				cachedAt = Date.now();
				return usage;
			}
		}

		// No credentials for any provider
		return null;
	} catch {
		// Network error / timeout / parse error — fail gracefully.
		return null;
	}
}
