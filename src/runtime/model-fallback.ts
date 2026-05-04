import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as ModelLike;
	if (typeof record.provider !== "string" || typeof record.id !== "string") return undefined;
	return { provider: record.provider, id: record.id, fullId: `${record.provider}/${record.id}` };
}

export function availableModelInfosFromRegistry(registry: unknown): AvailableModelInfo[] | undefined {
	if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
	const candidate = registry as ModelRegistryLike;
	const raw = typeof candidate.getAvailable === "function" ? candidate.getAvailable() : typeof candidate.getAll === "function" ? candidate.getAll() : undefined;
	if (!Array.isArray(raw)) return undefined;
	return raw.map(modelInfoFromUnknown).filter((entry): entry is AvailableModelInfo => entry !== undefined);
}

export function modelStringFromUnknown(model: unknown): string | undefined {
	return modelInfoFromUnknown(model)?.fullId;
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
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
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
	return { provider: settings.defaultProvider, id: settings.defaultModel, fullId: `${settings.defaultProvider}/${settings.defaultModel}` };
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

export function configuredModelInfosFromPiConfig(cwd?: string): AvailableModelInfo[] {
	const agentDir = piAgentDir();
	const globalSettings = readJsonObject(path.join(agentDir, "settings.json")) as PiSettingsLike | undefined;
	const projectSettings = cwd ? readJsonObject(path.join(cwd, ".pi", "settings.json")) as PiSettingsLike | undefined : undefined;
	const effectiveSettings = { ...(globalSettings ?? {}), ...(projectSettings ?? {}) };
	return uniqueModelInfos([
		...modelsJsonInfos(readJsonObject(path.join(agentDir, "models.json")) as PiModelsJsonLike | undefined),
		...(settingsModelInfo(effectiveSettings) ? [settingsModelInfo(effectiveSettings)!] : []),
	]);
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	// When multiple providers share the same model id, return the raw model string.
	// Callers should use the preferredProvider hint via resolveModelCandidate.
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
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
	return nextModel ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.` : `[fallback] ${attempt.model} failed: ${failure}.`;
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
	return availableModels.some((entry) => entry.id === baseModel);
}

export interface ConfiguredModelRouting {
	requested?: string;
	candidates: string[];
	reason?: string;
}

export function buildConfiguredModelRouting(input: {
	overrideModel?: string;
	stepModel?: string;
	agentModel?: string;
	fallbackModels?: string[];
	parentModel?: unknown;
	modelRegistry?: unknown;
	cwd?: string;
}): ConfiguredModelRouting {
	const registryModels = availableModelInfosFromRegistry(input.modelRegistry);
	const configModels = configuredModelInfosFromPiConfig(input.cwd);
	const availableModels = registryModels && registryModels.length > 0 ? registryModels : configModels.length > 0 ? configModels : registryModels;
	const parentModel = modelStringFromUnknown(input.parentModel);
	const preferredProvider = parentModel?.split("/")[0] ?? availableModels?.[0]?.provider;
	// B3: Parent model inheritance — when agent has no model specified,
	// inherit from parent session model before falling back to defaults.
	const effectiveAgentModel = input.agentModel?.trim() ? input.agentModel : parentModel;
	const requested = [input.overrideModel, input.stepModel, effectiveAgentModel].find((model): model is string => Boolean(model?.trim()));
	if (availableModels && availableModels.length === 0) return { requested, candidates: [], reason: "no configured Pi models available" };
	const rawModels = availableModels
		? [input.overrideModel, input.stepModel, effectiveAgentModel, ...(input.fallbackModels ?? []), ...availableModels.map((model) => model.fullId)]
		: [input.overrideModel, parentModel];
	const configuredModels = rawModels
		.filter((model): model is string => Boolean(model?.trim()))
		.filter((model) => isAvailableModel(model.trim(), availableModels));
	const candidates = buildModelCandidates(configuredModels[0], configuredModels.slice(1), availableModels, preferredProvider);
	const reason = requested && candidates[0] && resolveModelCandidate(requested, availableModels, preferredProvider) !== candidates[0]
		? "requested model unavailable; selected configured Pi fallback"
		: candidates.length > 1
			? "configured Pi fallback chain"
			: undefined;
	return { requested, candidates, reason };
}

export function buildConfiguredModelCandidates(input: Parameters<typeof buildConfiguredModelRouting>[0]): string[] {
	return buildConfiguredModelRouting(input).candidates;
}
