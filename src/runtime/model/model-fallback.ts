import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errors } from "../../errors.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { fuzzyResolveModelId } from "./model-resolver.ts";
import { checkModelScope } from "./model-scope.ts";
import { providerRankFromQuota, deprioritizedProviders as quotaDeprioritizedProviders } from "./provider-quota.ts";

export interface AvailableModelInfo {
	provider: string;
	id: string;
	fullId: string;
}

export interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
}

export interface ModelLike {
	provider?: unknown;
	id?: unknown;
}

export interface ModelRegistryLike {
	getAvailable?: () => unknown[];
	getAll?: () => unknown[];
}

interface PiSettingsLike {
	defaultProvider?: unknown;
	defaultModel?: unknown;
}

interface PiModelsJsonLike {
	providers?: unknown;
}

interface PiProviderConfigLike {
	models?: unknown;
	modelOverrides?: unknown;
}

function modelInfoFromUnknown(value: unknown): AvailableModelInfo | undefined {
	// A plain `"provider/id"` (or bare `"id"`) string is a valid model reference.
	// The child-process path receives pi's `Model` object, but the live-session
	// path and the background path (manifest-persisted) carry strings; both must
	// resolve identically or parent-model inheritance silently disappears.
	if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return undefined;
		const slashIdx = raw.indexOf("/");
		if (slashIdx <= 0) return { provider: "", id: raw, fullId: raw };
		return {
			provider: raw.slice(0, slashIdx),
			id: raw.slice(slashIdx + 1),
			fullId: raw,
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as ModelLike;
	if (typeof record.provider !== "string" || typeof record.id !== "string") return undefined;
	return {
		provider: record.provider,
		id: record.id,
		fullId: `${record.provider}/${record.id}`,
	};
}

export function availableModelInfosFromRegistry(registry: unknown): AvailableModelInfo[] | undefined {
	if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
	const candidate = registry as ModelRegistryLike;
	const raw =
		typeof candidate.getAvailable === "function"
			? candidate.getAvailable()
			: typeof candidate.getAll === "function"
				? candidate.getAll()
				: undefined;
	if (!Array.isArray(raw)) return undefined;
	return raw.map(modelInfoFromUnknown).filter((entry): entry is AvailableModelInfo => entry !== undefined);
}

export function modelStringFromUnknown(model: unknown): string | undefined {
	return modelInfoFromUnknown(model)?.fullId;
}

/**
 * Normalize any model reference (pi `Model` object, `"provider/id"`, bare id)
 * to its canonical string form. Returns undefined for unrecognized input.
 */
export function modelRefToString(model: unknown): string | undefined {
	return modelInfoFromUnknown(model)?.fullId;
}

/** Provider segment of a `"provider/id"` reference, or undefined for bare ids. */
export function providerOfModelRef(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const slashIdx = model.indexOf("/");
	return slashIdx > 0 ? model.slice(0, slashIdx) : undefined;
}

function uniqueModelInfos(models: AvailableModelInfo[]): AvailableModelInfo[] {
	const seen = new Set<string>();
	return models.filter((model) => {
		if (seen.has(model.fullId)) return false;
		seen.add(model.fullId);
		return true;
	});
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
	// NEW-P4: TOCTOU fix — readFileSync + catch instead of existsSync+read (1 syscall,
	// no race). The catch returns undefined for both ENOENT and parse errors, exactly
	// matching the previous existsSync-gated behavior (missing → undefined, corrupt → undefined).
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function piAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) {
		if (envDir === "~") return os.homedir();
		if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
		return envDir;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function settingsModelInfo(settings: PiSettingsLike | undefined): AvailableModelInfo | undefined {
	if (typeof settings?.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
	return {
		provider: settings.defaultProvider,
		id: settings.defaultModel,
		fullId: `${settings.defaultProvider}/${settings.defaultModel}`,
	};
}

function modelsJsonInfos(modelsJson: PiModelsJsonLike | undefined): AvailableModelInfo[] {
	if (!modelsJson?.providers || typeof modelsJson.providers !== "object" || Array.isArray(modelsJson.providers)) return [];
	const infos: AvailableModelInfo[] = [];
	for (const [provider, rawConfig] of Object.entries(modelsJson.providers as Record<string, unknown>)) {
		if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
		const config = rawConfig as PiProviderConfigLike;
		if (Array.isArray(config.models)) {
			for (const rawModel of config.models) {
				if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
				const id = (rawModel as { id?: unknown }).id;
				if (typeof id === "string") infos.push({ provider, id, fullId: `${provider}/${id}` });
			}
		}
		if (config.modelOverrides && typeof config.modelOverrides === "object" && !Array.isArray(config.modelOverrides)) {
			for (const id of Object.keys(config.modelOverrides)) infos.push({ provider, id, fullId: `${provider}/${id}` });
		}
	}
	return infos;
}

/**
 * Providers that have a discoverable credential, so a model from them is
 * plausibly runnable. Mirrors (loosely) pi's own `configuredProviders` set,
 * which is what `ModelRegistry.getAvailable()` filters on — the raw-JSON
 * fallback below has no registry, so without this check a background run would
 * happily queue models the user has no key for and burn a child spawn per one.
 *
 * Detection channels (existence only — no credential value is ever read into
 * a return value or a log):
 *   • a top-level provider key in `~/.pi/agent/auth.json`
 *   • `apiKey` / `baseUrl` set on the provider in `models.json` (local
 *     providers such as ollama are keyless but carry a baseUrl)
 *   • an `<PROVIDER>_API_KEY` environment variable
 */
export function providersWithCredentials(modelsJson: PiModelsJsonLike | undefined, env: NodeJS.ProcessEnv = process.env): Set<string> {
	const providers = new Set<string>();
	const auth = readJsonObject(path.join(piAgentDir(), "auth.json"));
	for (const key of Object.keys(auth ?? {})) providers.add(key);
	if (modelsJson?.providers && typeof modelsJson.providers === "object" && !Array.isArray(modelsJson.providers)) {
		for (const [provider, rawConfig] of Object.entries(modelsJson.providers as Record<string, unknown>)) {
			if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
			const config = rawConfig as { apiKey?: unknown; baseUrl?: unknown };
			if (typeof config.apiKey === "string" && config.apiKey.trim()) providers.add(provider);
			if (typeof config.baseUrl === "string" && config.baseUrl.trim()) providers.add(provider);
		}
	}
	for (const key of Object.keys(env)) {
		const match = /^([A-Z0-9]+(?:_[A-Z0-9]+)*)_API_KEY$/.exec(key);
		if (match && env[key]?.trim()) providers.add(match[1]!.toLowerCase().replace(/_/g, "-"));
	}
	return providers;
}

interface ConfiguredModelCacheEntry {
	signature: string;
	all: AvailableModelInfo[];
	credentialed: AvailableModelInfo[];
}

/** US-012: avoid re-reading 3 JSON files on every routing build (and every retry). */
const configuredModelCache = new Map<string, ConfiguredModelCacheEntry>();

function fileSignature(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "-";
	}
}

export interface ConfiguredModelOptions {
	/** Drop models whose provider has no discoverable credential. */
	requireCredentials?: boolean;
}

export function configuredModelInfosFromPiConfig(cwd?: string, options?: ConfiguredModelOptions): AvailableModelInfo[] {
	const agentDir = piAgentDir();
	const globalSettingsPath = path.join(agentDir, "settings.json");
	const modelsJsonPath = path.join(agentDir, "models.json");
	const authPath = path.join(agentDir, "auth.json");
	const projectSettingsPath = cwd ? path.join(cwd, ".pi", "settings.json") : undefined;
	const cacheKey = `${agentDir}\u0000${cwd ?? ""}`;
	const signature = [globalSettingsPath, modelsJsonPath, authPath, ...(projectSettingsPath ? [projectSettingsPath] : [])]
		.map(fileSignature)
		.join("|");
	const cached = configuredModelCache.get(cacheKey);
	if (cached?.signature === signature) return options?.requireCredentials ? cached.credentialed : cached.all;

	const globalSettings = readJsonObject(globalSettingsPath) as PiSettingsLike | undefined;
	const projectSettings = projectSettingsPath ? (readJsonObject(projectSettingsPath) as PiSettingsLike | undefined) : undefined;
	const effectiveSettings = {
		...(globalSettings ?? {}),
		...(projectSettings ?? {}),
	};
	const defaultModel = settingsModelInfo(effectiveSettings);
	const modelsJson = readJsonObject(modelsJsonPath) as PiModelsJsonLike | undefined;
	const all = uniqueModelInfos([...(defaultModel ? [defaultModel] : []), ...modelsJsonInfos(modelsJson)]);
	const credentialedProviders = providersWithCredentials(modelsJson);
	// The settings.json default model is kept regardless: it is the user's
	// explicit choice and pi resolves its auth through channels we do not model
	// here (OAuth, keychain, provider extensions).
	const credentialed = all.filter(
		(info) => info.fullId === defaultModel?.fullId || credentialedProviders.has(info.provider.toLowerCase()),
	);
	configuredModelCache.set(cacheKey, { signature, all, credentialed });
	// LRU cap: prevent unbounded growth across many distinct agent-dir/cwd combos.
	if (configuredModelCache.size > 32) {
		const oldestKey = configuredModelCache.keys().next().value;
		if (oldestKey !== undefined) configuredModelCache.delete(oldestKey);
	}
	return options?.requireCredentials ? credentialed : all;
}

/** @internal Test seam — clear the mtime-keyed configured-model cache. */
export function __test_resetConfiguredModelCache(): void {
	configuredModelCache.clear();
}

export function splitThinkingSuffix(model: string): {
	baseModel: string;
	thinkingSuffix: string;
} {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

// WP-8 (R8): loud passthrough warnings — deduped per model so a chain of
// tasks resolving the same unvalidated model warns once per process. The
// delegate surface (spawn-policy admission) validates models against the
// catalog itself (WP-5) and never routes through resolveModelCandidate.
const passthroughWarned = new Set<string>();
function warnUnvalidatedPassthrough(model: string, reason: string): void {
	const key = `${model}|${reason}`;
	if (passthroughWarned.has(key)) return;
	passthroughWarned.add(key);
	console.warn(
		`[model-routing] unvalidated passthrough: '${model}' (${reason}) — not confirmed against the configured model catalog; spawn may fail at the provider.`,
	);
}

/** Test seam: the dedup set is module-global (one warn per model+reason per
 *  process); tests reset it for deterministic counting. */
export function resetPassthroughWarnings(): void {
	passthroughWarned.clear();
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	// Provider-qualified refs ("provider/model") pass through UNVALIDATED —
	// the caller asserted a full id; there is nothing to resolve. Loud (R8):
	// this is the documented trust path, not a silent one.
	if (model.includes("/")) {
		warnUnvalidatedPassthrough(model, "provider-qualified ref, no catalog check");
		return model;
	}
	if (!availableModels || availableModels.length === 0) {
		warnUnvalidatedPassthrough(model, "no model catalog available");
		return model;
	}

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	// When multiple providers share the same model id, return the raw model string.
	// Callers should use the preferredProvider hint via resolveModelCandidate.
	if (matches.length !== 1) {
		// Fuzzy fallback: try to resolve via partial name matching
		const fuzzy = fuzzyResolveModelId(baseModel, availableModels);
		if (fuzzy) return `${fuzzy}${thinkingSuffix}`;
		warnUnvalidatedPassthrough(model, "no exact or fuzzy catalog match");
		return model;
	}
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate.?limit/i,
	/too many requests/i,
	/\b429\b/,
	/rate_limit_error/i,
	/quota/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/socket hang up/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	//
	// Provider-side 5xx / generic api_error. The pi-core retry layer already
	// retries these (agent-session.ts matches `500|server error|internal error`),
	// but the pi-crew MODEL FALLBACK layer must ALSO treat them as retryable so
	// that when the provider is hard-down across all 3 provider retries, we fail
	// over to the next configured model instead of giving up. Reported case
	// (2026-06-17): `500 {"type":"error","error":{"type":"api_error",
	// "message":"unknown error, 999 (1000)"}}` — a transient provider outage that
	// should trigger the fallback chain, not abort.
	//
	// `api_error` is the OpenAI-compatible generic error type (vs rate_limit_error
	// / overloaded_error / etc.) and almost always means a transient server fault.
	//
	// `unknown error` is the body of the generic message; `internal`/`server`
	// catch the common phrasings. `\b500\b`/`\b501\b` catch the HTTP status in
	// the rendered error string.
	/\b500\b/,
	/\b501\b/,
	/api_error/i,
	/unknown error/i,
	/internal(?:_server)?[ _]error/i,
	/server error/i,
	/bad gateway/i,
	//
	// Broader retryable patterns (added 2026-06-25, FIX 2):
	// - `/provider[_ ]?error/i`: OpenAI-compatible "Provider error" generic fault.
	// - `/context[_ ]?length[_ ]?exceeded/i`: "context_length_exceeded" from
	//   OpenAI/Anthropic — when the configured model is the bottleneck, a
	//   different model in the fallback chain may have a larger window.
	// - `/safety/i`: Anthropic safety blocks — typically retryable on a
	//   different model in the fallback chain.
	// - `/is[_ ]?overloaded/i`: alias to the existing `/overloaded/i` pattern
	//   to catch phrasings like "upstream is overloaded".
	// - `/\b408\b/`: HTTP 408 Request Timeout — transient, provider-side.
	//
	// Intentionally NOT added: `/bad_request/` — can mean bad input (e.g.
	// invalid schema), which is non-retryable.
	/provider[_ ]?error/i,
	/context[_ ]?length[_ ]?exceeded/i,
	/safety/i,
	/is[_ ]?overloaded/i,
	/\b408\b/,
	//
	// EPIPE / broken-pipe. In the child-pi worker path this typically means
	// the child `pi` process exited (crash or early exit) while the parent
	// was still writing to its stdin — spawning a fresh child on the next
	// model in the fallback chain usually recovers. In the network path it
	// is a transient pipe close. Both are retryable on a different model.
	// See docs/failure-mode-inventory.md EPIPE gap; NON_RETRYABLE patterns
	// (auth/billing) are checked first, so an auth error mentioning EPIPE
	// stays non-retryable.
	/epipe/i,
	/broken pipe/i,
];

// These patterns indicate auth/key/billing issues that will never succeed on retry.
const NON_RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/billing/i,
	/credit/i,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	// Auth / billing / invalid-key failures will never succeed on retry.
	if (NON_RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

function isAvailableModel(model: string, availableModels: AvailableModelInfo[] | undefined): boolean {
	if (!availableModels || availableModels.length === 0) return true;
	const { baseModel } = splitThinkingSuffix(model);
	if (baseModel.includes("/")) return availableModels.some((entry) => entry.fullId === baseModel);
	if (availableModels.some((entry) => entry.id === baseModel)) return true;
	const fuzzy = fuzzyResolveModelId(baseModel, availableModels);
	return fuzzy !== undefined;
}

/**
 * Ordering + budget policy for the AUTO portion of the fallback chain (the
 * models appended from the registry / pi config that nobody declared).
 *
 * Explicit declarations (tool override, step, team role, agent model and the
 * declared `fallbackModels`) are never reordered and never truncated — only the
 * auto tail is governed here.
 */
export interface ModelFallbackPolicy {
	/**
	 * How many auto-appended models to keep. `undefined` = keep all (legacy).
	 * Each extra candidate multiplies the worst-case child-spawn budget by
	 * `maxAttempts + 1`, so an unbounded tail on a large catalogue is the main
	 * cost amplifier.
	 */
	maxAutoFallbacks?: number;
	/**
	 * `"parentFirst"` keeps the auto tail on the same provider as the model
	 * actually in use before crossing to another provider when a policy is
	 * configured or quota data enriches it — same auth, similar cost/latency
	 * profile. `"asIs"` preserves raw catalogue order. Without explicit
	 * configuration, auto tail stays catalogue order.
	 */
	order?: "parentFirst" | "asIs";
	/** Lower rank = try earlier. Populated from provider quota when available. */
	providerRank?: Record<string, number>;
	/** Providers at/near their quota limit — pushed to the back of the tail. */
	deprioritizedProviders?: string[];
	/** Drop pi-config models whose provider has no discoverable credential. */
	requireCredentials?: boolean;
	/**
	 * When true (default), populate `providerRank` and `deprioritizedProviders`
	 * from the provider-quota cache before ordering the auto tail. Set to false
	 * to disable quota-aware ordering entirely.
	 */
	quotaAwareOrdering?: boolean;
}

/**
 * Order the auto tail. Stable: equal-priority entries keep catalogue order.
 * Priority, most significant first:
 *   1. not quota-exhausted
 *   2. same provider as the anchor (the model we are actually going to run)
 *   3. explicit provider rank (quota-derived), unknown providers last
 */
export function orderAutoFallbacks(candidates: string[], policy: ModelFallbackPolicy | undefined, anchorProvider?: string): string[] {
	if (!policy || policy.order === "asIs") return candidates;
	const deprioritized = new Set((policy.deprioritizedProviders ?? []).map((p) => p.toLowerCase()));
	const rank = policy.providerRank ?? {};
	const rankFor = (provider: string | undefined): number => {
		if (!provider) return Number.MAX_SAFE_INTEGER;
		const value = rank[provider] ?? rank[provider.toLowerCase()];
		return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
	};
	return candidates
		.map((model, index) => {
			const provider = providerOfModelRef(model);
			return {
				model,
				index,
				exhausted: provider && deprioritized.has(provider.toLowerCase()) ? 1 : 0,
				anchored: anchorProvider && provider === anchorProvider ? 0 : 1,
				rank: rankFor(provider),
			};
		})
		.sort((a, b) => a.exhausted - b.exhausted || a.anchored - b.anchored || a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.model);
}

/**
 * Build a {@link ModelFallbackPolicy} from crew config + environment. Env vars
 * override config (lowest friction for a quick experiment without editing JSON):
 *   PI_CREW_MAX_AUTO_FALLBACKS — cap the auto tail
 *   PI_CREW_MODEL_FALLBACK_ORDER — "parentFirst" | "asIs"
 *   PI_CREW_MODEL_REQUIRE_CREDENTIALS — "1" to drop uncredentialed providers
 *
 * `parentFirst` ordering applies only when a policy is explicitly configured or
 * quota data enriches it; otherwise the auto tail stays catalogue order.
 *
 * Returns undefined when nothing is configured, so callers that pass it to
 * `buildConfiguredModelRouting` get legacy (unbounded, unordered) behaviour.
 */
export function resolveModelFallbackPolicy(
	config:
		| {
				maxAutoFallbacks?: number;
				order?: "parentFirst" | "asIs";
				requireCredentials?: boolean;
				quotaAwareOrdering?: boolean;
		  }
		| undefined,
	env: NodeJS.ProcessEnv = process.env,
): ModelFallbackPolicy | undefined {
	const envMaxAuto = env.PI_CREW_MAX_AUTO_FALLBACKS;
	let maxAutoFallbacks: number | undefined;
	if (envMaxAuto) {
		const parsed = Number.parseInt(envMaxAuto, 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			maxAutoFallbacks = parsed;
		} else if (Number.isFinite(parsed)) {
			// Negative — clamp to 0 with warning.
			logInternalError(
				"model-fallback.max-auto-fallbacks-invalid",
				undefined,
				`PI_CREW_MAX_AUTO_FALLBACKS="${envMaxAuto}" is negative, clamped to 0`,
				"warn",
			);
			maxAutoFallbacks = 0;
		} else {
			// NaN or non-finite — fall back to config.
			logInternalError(
				"model-fallback.max-auto-fallbacks-invalid",
				undefined,
				`PI_CREW_MAX_AUTO_FALLBACKS="${envMaxAuto}" is invalid, falling back to config`,
				"warn",
			);
			maxAutoFallbacks = config?.maxAutoFallbacks;
		}
	} else {
		maxAutoFallbacks = config?.maxAutoFallbacks;
	}
	const order = (env.PI_CREW_MODEL_FALLBACK_ORDER as "parentFirst" | "asIs" | undefined) ?? config?.order;
	const requireCredentials =
		env.PI_CREW_MODEL_REQUIRE_CREDENTIALS === "1"
			? true
			: env.PI_CREW_MODEL_REQUIRE_CREDENTIALS === "0"
				? false
				: config?.requireCredentials;
	// quotaAwareOrdering defaults to true (user preference: default-on with cache).
	// When explicitly disabled, no deprioritization/rank data is attached.
	const quotaAware = config?.quotaAwareOrdering !== false;
	if (maxAutoFallbacks === undefined && !order && requireCredentials === undefined && config?.quotaAwareOrdering === undefined)
		return undefined;
	return {
		...(maxAutoFallbacks !== undefined && Number.isFinite(maxAutoFallbacks) ? { maxAutoFallbacks } : {}),
		...(order ? { order } : {}),
		...(requireCredentials !== undefined ? { requireCredentials } : {}),
		quotaAwareOrdering: quotaAware,
	};
}

/**
 * Resolve the default subagent model from config or env. Precedence:
 *   PI_CREW_MODEL env > config.runtime.modelFallback.defaultSubagentModel
 * Returns undefined when neither is set.
 */
export function resolveDefaultSubagentModel(
	config: { defaultSubagentModel?: string } | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.PI_CREW_MODEL?.trim() || config?.defaultSubagentModel?.trim() || undefined;
}

export interface ConfiguredModelRouting {
	requested?: string;
	candidates: string[];
	reason?: string;
	/**
	 * Set when the caller asked for a model that is not resolvable against the
	 * available catalogue, so the chain silently runs something else. Callers
	 * surface this as a warning instead of dropping it on the floor.
	 */
	droppedRequested?: string;
	/** How many candidates came from the auto tail (diagnostics). */
	autoFallbackCount?: number;
	/**
	 * F7 scope gate verdict. Populated when the caller passed `scopeModelsPatterns`.
	 * - `inScope: true` → the resolved model is inside the allowlist (or no allowlist).
	 * - `inScope: false, source: "caller"` → caller override (override/step/team role)
	 *   is out-of-scope; the function throws `errors.modelOutOfScope` (hard error
	 *   before spawn) UNLESS the caller marked it as a frontmatter override
	 *   (`isFrontmatterOverride: true`), in which case the verdict is returned for
	 *   the caller to log as a warning.
	 * - `inScope: false, source: "frontmatter" | "resolved"` → frontmatter-pinned,
	 *   defaultSubagentModel, or parentModel-inherited model is out-of-scope;
	 *   soft warn + run anyway (no throw).
	 */
	scopeVerdict?: import("./model-scope.ts").ModelScopeCheck;
}

export function buildConfiguredModelRouting(input: {
	overrideModel?: string;
	stepModel?: string;
	teamRoleModel?: string;
	/** Team-role declared fallbacks (`fallbackModels=a,b` on the role line). */
	teamRoleFallbackModels?: string[];
	agentModel?: string;
	/**
	 * Config-level default model for subagents. Sits between the agent model
	 * and the inherited parent model in precedence: when the agent has
	 * `model: false` (all builtins), this takes over before falling back to
	 * the session's model. Ignored when the agent or caller already set one.
	 */
	defaultSubagentModel?: string;
	fallbackModels?: string[];
	parentModel?: unknown;
	modelRegistry?: unknown;
	cwd?: string;
	/** Ordering + budget policy for the auto tail. */
	policy?: ModelFallbackPolicy;
	/**
	 * F7: when set, enforce the enabledModels allowlist. Caller-supplied out-of-
	 * scope models throw `errors.modelOutOfScope`; frontmatter-pinned out-of-scope
	 * models are returned as a `scopeVerdict` for the caller to log.
	 */
	scopeModelsPatterns?: string[];
	/**
	 * F7: when true, the `overrideModel` (if any) is treated as a frontmatter
	 * (agent) override rather than a per-spawn caller override — out-of-scope
	 * is a warning, not a hard error. Used when the agent config is the
	 * authoritative source.
	 */
	isFrontmatterOverride?: boolean;
}): ConfiguredModelRouting {
	const registryModels = availableModelInfosFromRegistry(input.modelRegistry);
	const configModels = configuredModelInfosFromPiConfig(input.cwd, {
		requireCredentials: input.policy?.requireCredentials,
	});
	const availableModels =
		registryModels && registryModels.length > 0 ? registryModels : configModels.length > 0 ? configModels : registryModels;
	const parentModel = modelStringFromUnknown(input.parentModel);
	const preferredProvider = providerOfModelRef(parentModel) ?? availableModels?.[0]?.provider;
	// B3: Parent model inheritance — when agent has no model specified,
	// inherit from parent session model before falling back to defaults.
	// defaultSubagentModel (config/env) sits between agent and parent: when
	// the agent has `model: false` but a default is configured, the default
	// takes over and the parent model becomes the first fallback.
	const defaultSubagent = input.defaultSubagentModel?.trim() || undefined;
	const effectiveAgentModel = input.agentModel?.trim() ? input.agentModel : (defaultSubagent ?? parentModel);
	const requested = [input.overrideModel, input.stepModel, input.teamRoleModel, effectiveAgentModel].find((model): model is string =>
		Boolean(model?.trim()),
	);
	if (availableModels && availableModels.length === 0)
		return {
			requested,
			candidates: [],
			reason: "no configured Pi models available",
		};
	// Explicit declarations, highest precedence first. These are authoritative:
	// never reordered, never truncated by the auto-tail budget.
	const declaredRaw = [
		input.overrideModel,
		input.stepModel,
		input.teamRoleModel,
		effectiveAgentModel,
		// When defaultSubagentModel replaced parentModel as the effective agent
		// model, keep parentModel as an explicit fallback before the auto tail.
		...(defaultSubagent && !input.agentModel?.trim() ? [parentModel] : []),
		...(input.teamRoleFallbackModels ?? []),
		...(input.fallbackModels ?? []),
	];
	// Fix (Round 18): when an agent has `model: false` (frontmatter) the
	// inherited `parentModel` (= session chính's model, e.g. minimax-M3) IS the
	// desired primary. It must NOT be filtered out by isAvailableModel — which
	// only knows about models from models.json / registry, NOT builtin Pi models.
	// Pin the inherited parentModel at index 0 regardless of availability.
	const parentModelRaw = effectiveAgentModel?.trim() || undefined;
	// When defaultSubagentModel replaced parentModel as the effective agent
	// model, the parent model is still a valid fallback (it IS the session's
	// live model) — pin it too so isAvailableModel doesn't filter it out.
	const parentModelFallback = defaultSubagent && !input.agentModel?.trim() ? parentModel : undefined;
	const declaredModels = declaredRaw
		.filter((model): model is string => Boolean(model?.trim()))
		.filter((model, idx) => {
			if (parentModelRaw && idx === 0 && model.trim() === parentModelRaw) return true;
			if (parentModelFallback && model.trim() === parentModelFallback) return true;
			return isAvailableModel(model.trim(), availableModels);
		});
	const declaredCandidates = buildModelCandidates(declaredModels[0], declaredModels.slice(1), availableModels, preferredProvider);
	// Auto tail: everything the user did NOT declare. Without a registry the
	// only auto candidate is the inherited parent model.
	const autoRaw = availableModels ? availableModels.map((model) => model.fullId) : parentModel ? [parentModel] : [];
	const declaredSet = new Set(declaredCandidates);
	const autoResolved = buildModelCandidates(undefined, autoRaw, availableModels, preferredProvider).filter(
		(candidate) => !declaredSet.has(candidate),
	);
	const anchorProvider = providerOfModelRef(declaredCandidates[0]) ?? providerOfModelRef(parentModel);
	// Quota-aware ordering: when the policy allows it, enrich with live quota
	// data so exhausted providers sink to the back of the auto tail.
	let effectivePolicy = input.policy;
	if (effectivePolicy?.quotaAwareOrdering !== false && autoResolved.length > 0) {
		const tailProviders = [...new Set(autoResolved.map((m) => providerOfModelRef(m)).filter((p): p is string => Boolean(p)))];
		const deprioritized = quotaDeprioritizedProviders(tailProviders);
		const rank = providerRankFromQuota(tailProviders);
		if (deprioritized.length > 0 || Object.keys(rank).length > 0) {
			effectivePolicy = {
				...effectivePolicy,
				deprioritizedProviders: [...(effectivePolicy?.deprioritizedProviders ?? []), ...deprioritized],
				providerRank: { ...rank, ...(effectivePolicy?.providerRank ?? {}) },
			};
		}
	}
	const autoOrdered = orderAutoFallbacks(autoResolved, effectivePolicy, anchorProvider);
	const autoCandidates =
		effectivePolicy?.maxAutoFallbacks === undefined ? autoOrdered : autoOrdered.slice(0, Math.max(0, effectivePolicy.maxAutoFallbacks));
	const candidates = [...declaredCandidates, ...autoCandidates];
	const resolvedRequested = requested ? resolveModelCandidate(requested, availableModels, preferredProvider) : undefined;
	const droppedRequested = requested && candidates[0] && resolvedRequested !== candidates[0] ? requested : undefined;
	const reason = droppedRequested
		? "requested model unavailable; selected configured Pi fallback"
		: candidates.length > 1
			? "configured Pi fallback chain"
			: undefined;
	// F7 scope gate: when `scopeModelsPatterns` is configured, check the
	// resolved model. Caller-supplied (override/step/team role) out-of-scope
	// is a HARD ERROR (we surface it via the verdict AND throw, so spawn aborts
	// before any cost is incurred). Frontmatter-pinned, defaultSubagentModel,
	// and parentModel-inherited out-of-scope is a WARNING returned on the verdict
	// for the caller to log.
	let scopeVerdict: ConfiguredModelRouting["scopeVerdict"];
	if (input.scopeModelsPatterns && input.scopeModelsPatterns.length > 0) {
		const resolved = candidates[0] ?? requested;
		// Attribution by REAL precedence: override/step/team role are caller-level
		// (hard-error when out-of-scope); agentModel is frontmatter (soft warn);
		// defaultSubagentModel + parentModel are resolved (soft warn).
		// F5: isFrontmatterOverride means the caller override equals the agent's
		// frontmatter model (author authority) → treat as "frontmatter" so the
		// soft warning surfaces instead of being silent (throw is also skipped).
		const source = input.isFrontmatterOverride
			? "frontmatter"
			: input.overrideModel
				? "caller"
				: input.stepModel
					? "caller"
					: input.teamRoleModel
						? "caller"
						: input.agentModel?.trim()
							? "frontmatter"
							: "resolved";
		scopeVerdict = checkModelScope(resolved, input.scopeModelsPatterns, source);
		if (!scopeVerdict.inScope && source === "caller" && !input.isFrontmatterOverride) {
			throw errors.modelOutOfScope(resolved ?? "", input.scopeModelsPatterns);
		}
	}
	return {
		requested,
		candidates,
		reason,
		droppedRequested,
		autoFallbackCount: autoCandidates.length,
		scopeVerdict,
	};
}

export function buildConfiguredModelCandidates(input: Parameters<typeof buildConfiguredModelRouting>[0]): string[] {
	return buildConfiguredModelRouting(input).candidates;
}

/**
 * Surface a non-silent warning when a soft-sourced (non-caller) model is
 * out-of-scope and runs anyway. Centralises the `"warn"` severity so call
 * sites cannot accidentally omit it — Round-2 F1 found two sites forgot it,
 * making the warning debug-gated/silent and defeating the entire Sec-M1 fix.
 * Caller-sourced out-of-scope already throws inside `buildConfiguredModelRouting`,
 * so this is a no-op for `source === "caller"`.
 */
export function warnOutOfScopeSoft(verdict: import("./model-scope.ts").ModelScopeCheck | undefined, scope: string, prefix = "Model"): void {
	if (!verdict || verdict.inScope || verdict.source === "caller") return;
	logInternalError(
		scope,
		undefined,
		`${prefix} "${verdict.model}" from source "${verdict.source}" is outside enabledModels scope: ${verdict.reason ?? "unknown"}. Running anyway (soft warn).`,
		"warn",
	);
}
