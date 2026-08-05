import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CrewError, ErrorCode } from "../../../../src/errors.ts";
import {
	buildConfiguredModelCandidates,
	buildConfiguredModelRouting,
	buildModelCandidates,
	configuredModelInfosFromPiConfig,
	isRetryableModelFailure,
	orderAutoFallbacks,
	resolveDefaultSubagentModel,
	resolveModelCandidate,
	resolveModelFallbackPolicy,
	splitThinkingSuffix,
	warnOutOfScopeSoft,
} from "../../../../src/runtime/model/model-fallback.ts";

test("splitThinkingSuffix preserves model suffix", () => {
	assert.deepEqual(splitThinkingSuffix("claude-sonnet:high"), {
		baseModel: "claude-sonnet",
		thinkingSuffix: ":high",
	});
	assert.deepEqual(splitThinkingSuffix("openai/gpt-5"), {
		baseModel: "openai/gpt-5",
		thinkingSuffix: "",
	});
});

test("resolveModelCandidate expands unique bare model", () => {
	const available = [{ provider: "anthropic", id: "sonnet", fullId: "anthropic/sonnet" }];
	assert.equal(resolveModelCandidate("sonnet:high", available), "anthropic/sonnet:high");
});

test("buildModelCandidates de-duplicates candidates", () => {
	const available = [{ provider: "anthropic", id: "sonnet", fullId: "anthropic/sonnet" }];
	assert.deepEqual(buildModelCandidates("sonnet", ["anthropic/sonnet", "other"], available), ["anthropic/sonnet", "other"]);
});

test("buildConfiguredModelCandidates pins effectiveAgentModel at index 0 even when not in registry", () => {
	// The effectiveAgentModel (= agentModel when set) MUST stay at candidates[0]
	// even if it is not present in the configured Pi modelRegistry. This is the
	// round-18 fix: previously `isAvailableModel` filtered it out, so a session
	// whose agent declared a model outside models.json fell through to whatever
	// the registry had instead of using its declared model.
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	const parentModel = { provider: "openai-codex", id: "gpt-5.5" };
	assert.deepEqual(
		buildConfiguredModelCandidates({
			agentModel: "claude-haiku-4-5",
			fallbackModels: ["gpt-5-mini"],
			parentModel,
			modelRegistry,
		}),
		["claude-haiku-4-5", "openai-codex/gpt-5-mini", "openai-codex/gpt-5.5"],
	);
});

// Má»—i model worker pháº£i cÃ³ fallback tá»« danh sÃ¡ch model Pi Ä‘Ã£ cáº¥u hÃ¬nh, khÃ´ng fallback sang builtin khÃ´ng kháº£ dá»¥ng.
test("buildConfiguredModelCandidates appends remaining configured Pi models as fallbacks", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
			{ provider: "gemini", id: "gemini-pro" },
		],
	};
	assert.deepEqual(
		buildConfiguredModelCandidates({
			overrideModel: "gpt-5-mini",
			agentModel: "claude-haiku-4-5",
			modelRegistry,
		}),
		["openai-codex/gpt-5-mini", "openai-codex/gpt-5.5", "gemini/gemini-pro"],
	);
});

test("buildConfiguredModelRouting persists requested model and keeps effectiveAgentModel at head", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	const routing = buildConfiguredModelRouting({
		agentModel: "claude-haiku-4-5",
		fallbackModels: ["gpt-5-mini"],
		parentModel: { provider: "openai-codex", id: "gpt-5.5" },
		modelRegistry,
	});
	assert.equal(routing.requested, "claude-haiku-4-5");
	// claude-haiku-4-5 is NOT in registry but must be the primary candidate
	// (round-18 fix); the configured Pi fallbacks follow.
	assert.deepEqual(routing.candidates, ["claude-haiku-4-5", "openai-codex/gpt-5-mini", "openai-codex/gpt-5.5"]);
	assert.match(routing.reason ?? "", /fallback/);
});

test("buildConfiguredModelCandidates falls back to Pi default when no configured model is selected", () => {
	// effectiveAgentModel = parentModel when agentModel is unset (B3 inheritance).
	// round-18 fix keeps it pinned at index 0 even when the parent model is not
	// in the Pi-configured modelRegistry (e.g. parent = builtin "minimax-M3").
	const modelRegistry = {
		getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
	};
	assert.deepEqual(
		buildConfiguredModelCandidates({
			agentModel: "claude-haiku-4-5",
			parentModel: { provider: "openai-codex", id: "gpt-5.5" },
			modelRegistry,
		}),
		["claude-haiku-4-5", "openai-codex/gpt-5.5"],
	);
});

test("buildConfiguredModelCandidates preserves explicit configured models without Pi registry", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		assert.deepEqual(
			buildConfiguredModelCandidates({
				stepModel: "openai-codex/gpt-5.5",
				teamRoleModel: "gemini/gemini-pro",
				agentModel: "claude-haiku-4-5",
				fallbackModels: ["sonnet"],
				parentModel: { provider: "parent", id: "model" },
			}),
			["openai-codex/gpt-5.5", "gemini/gemini-pro", "claude-haiku-4-5", "sonnet", "parent/model"],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("buildConfiguredModelCandidates keeps agent/fallback models without Pi registry", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		assert.deepEqual(
			buildConfiguredModelCandidates({
				agentModel: "claude-haiku-4-5",
				fallbackModels: ["sonnet"],
			}),
			["claude-haiku-4-5", "sonnet"],
		);
		assert.deepEqual(
			buildConfiguredModelCandidates({
				overrideModel: "openai-codex/gpt-5.5",
				agentModel: "claude-haiku-4-5",
			}),
			["openai-codex/gpt-5.5", "claude-haiku-4-5"],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("configuredModelInfosFromPiConfig reads provider and model from Pi settings/models config", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-project-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		fs.writeFileSync(
			path.join(tempDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "configured-provider",
				defaultModel: "configured-model",
			}),
		);
		fs.writeFileSync(
			path.join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						models: [{ id: "custom-model" }],
						modelOverrides: { "overridden-model": {} },
					},
				},
			}),
		);
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				defaultProvider: "project-provider",
				defaultModel: "project-model",
			}),
		);
		assert.deepEqual(configuredModelInfosFromPiConfig(cwd), [
			{
				provider: "project-provider",
				id: "project-model",
				fullId: "project-provider/project-model",
			},
			{
				provider: "custom",
				id: "custom-model",
				fullId: "custom/custom-model",
			},
			{
				provider: "custom",
				id: "overridden-model",
				fullId: "custom/overridden-model",
			},
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// NEW-P4 (TOCTOU): readJsonObject now uses readFileSync + catch instead of
// existsSync+read. A corrupt-but-present JSON file must still resolve to
// undefined without throwing (missing → undefined is covered by the
// "keeps agent/fallback models without Pi registry" tests above).
test("configuredModelInfosFromPiConfig: corrupt settings.json resolves to no models without throwing (NEW-P4)", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-corrupt-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		fs.writeFileSync(path.join(tempDir, "settings.json"), "{ not valid json", "utf-8");
		fs.writeFileSync(path.join(tempDir, "models.json"), "{ also not valid", "utf-8");
		assert.doesNotThrow(() => configuredModelInfosFromPiConfig());
		assert.deepEqual(configuredModelInfosFromPiConfig(), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

// Regression tests for isRetryableModelFailure — the pi-crew model-fallback
// "should we try the next candidate?" gate. The pi-core provider-retry layer
// (agent-session.ts) already retries transient 5xx, but when ALL 3 provider
// retries fail (provider hard-down), pi-crew's fallback chain must fire as the
// last safety net. Before this fix, `500 api_error "unknown error"` was NOT in
// the retryable list → the fallback chain never fired → team runs died on
// transient provider outages even when a fallback model was configured.
// Reported 2026-06-17 against a MiniMax-style provider returning
// `500 {"type":"error","error":{"type":"api_error","message":"unknown error, 999 (1000)"}}`.
test("isRetryableModelFailure catches the reported 500 api_error outage", () => {
	const reportedCases = [
		'500 api_error "unknown error, 999 (1000)"',
		'Error: 500 {"type":"error","error":{"type":"api_error","message":"unknown error, 999 (1000)"}}',
		'{"error":{"type":"api_error","message":"unknown error"}}',
	];
	for (const err of reportedCases) {
		assert.equal(isRetryableModelFailure(err), true, `expected retryable for: ${err}`);
	}
});

test("isRetryableModelFailure catches generic 5xx / internal server errors", () => {
	for (const err of [
		"500 Internal Server Error",
		"Internal Server Error",
		"Bad Gateway",
		"501 Not Implemented",
		"server error processing request",
		"internal_server_error",
	]) {
		assert.equal(isRetryableModelFailure(err), true, `expected retryable: ${err}`);
	}
});

test("isRetryableModelFailure still treats auth/billing/key errors as NON-retryable", () => {
	// NON_RETRYABLE must win over RETRYABLE — otherwise a transient-looking 500
	// wrapping an auth failure would loop the fallback chain uselessly.
	for (const err of [
		"unauthorized: invalid api key",
		"forbidden: billing issue",
		"token expired",
		"401 Authentication failed",
		"credit exhausted",
	]) {
		assert.equal(isRetryableModelFailure(err), false, `expected NON-retryable: ${err}`);
	}
});

test("isRetryableModelFailure handles undefined/empty (no false trigger)", () => {
	assert.equal(isRetryableModelFailure(undefined), false);
	assert.equal(isRetryableModelFailure(""), false);
});

// FIX 2 — Broader RETRYABLE_MODEL_FAILURE_PATTERNS (2026-06-25).
// Each new pattern is asserted with a representative provider error string.
test("isRetryableModelFailure: 'provider error: api_error' triggers fallback", () => {
	assert.equal(isRetryableModelFailure("provider error: api_error"), true);
});

test("isRetryableModelFailure: 'context_length_exceeded' triggers fallback", () => {
	assert.equal(isRetryableModelFailure("context_length_exceeded: please reduce prompt size"), true);
});

test("isRetryableModelFailure: 'output flagged by safety' triggers fallback", () => {
	assert.equal(isRetryableModelFailure("output flagged by safety filter; please retry"), true);
});

test("isRetryableModelFailure: 'upstream is overloaded' triggers fallback", () => {
	assert.equal(isRetryableModelFailure("upstream is overloaded; retrying"), true);
});

test("isRetryableModelFailure: HTTP 408 'request timeout' triggers fallback", () => {
	assert.equal(isRetryableModelFailure("HTTP 408 request timeout"), true);
});

// Regression guard: even with the broader retryable list, an invalid api key
// must still be flagged NON-retryable so the fallback chain doesn't loop.
test("isRetryableModelFailure: 'invalid api key' is NOT retryable", () => {
	assert.equal(isRetryableModelFailure("invalid api key"), false);
});

// Regression: when agent declares `model: false` and the parent session model is
// a builtin (not in models.json), the inherited model must lead the candidate
// chain. Previously the chain collapsed to the only models.json entry
// (e.g. zaic/glm-5.2), so a single-provider outage had no real fallback.
test("buildConfiguredModelCandidates keeps inherited parent builtin model when registry has different providers", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "zaic", id: "glm-5.2" },
			{ provider: "zai", id: "glm-5.2" },
		],
	};
	// parentModel = builtin (e.g. minimax-M3 from session chính), agent has model: false
	const result = buildConfiguredModelCandidates({
		agentModel: undefined,
		parentModel: { provider: "minimax", id: "MiniMax-M3" },
		modelRegistry,
	});
	assert.deepEqual(result, ["minimax/MiniMax-M3", "zaic/glm-5.2", "zai/glm-5.2"]);
});

// ── Policy: orderAutoFallbacks ──────────────────────────────────────────────

test("orderAutoFallbacks: parentFirst keeps anchor provider first", () => {
	const candidates = ["openai/gpt-5", "anthropic/sonnet", "openai/gpt-5-mini"];
	const ordered = orderAutoFallbacks(candidates, { order: "parentFirst" }, "openai");
	assert.deepEqual(ordered, ["openai/gpt-5", "openai/gpt-5-mini", "anthropic/sonnet"]);
});

test("orderAutoFallbacks: asIs preserves catalogue order", () => {
	const candidates = ["openai/gpt-5", "anthropic/sonnet", "openai/gpt-5-mini"];
	const ordered = orderAutoFallbacks(candidates, { order: "asIs" }, "openai");
	assert.deepEqual(ordered, candidates);
});

test("orderAutoFallbacks: deprioritized providers sink to the back", () => {
	const candidates = ["openai/gpt-5", "anthropic/sonnet", "gemini/pro"];
	const ordered = orderAutoFallbacks(candidates, { deprioritizedProviders: ["openai"] }, undefined);
	assert.deepEqual(ordered, ["anthropic/sonnet", "gemini/pro", "openai/gpt-5"]);
});

test("orderAutoFallbacks: providerRank overrides catalogue order", () => {
	const candidates = ["openai/gpt-5", "anthropic/sonnet", "gemini/pro"];
	const ordered = orderAutoFallbacks(candidates, { providerRank: { gemini: 0, anthropic: 1, openai: 2 } }, undefined);
	assert.deepEqual(ordered, ["gemini/pro", "anthropic/sonnet", "openai/gpt-5"]);
});

test("orderAutoFallbacks: undefined policy returns candidates unchanged", () => {
	const candidates = ["openai/gpt-5", "anthropic/sonnet"];
	assert.deepEqual(orderAutoFallbacks(candidates, undefined), candidates);
});

// ── Policy: resolveModelFallbackPolicy ───────────────────────────────────────

test("resolveModelFallbackPolicy returns undefined when nothing configured", () => {
	assert.equal(resolveModelFallbackPolicy(undefined), undefined);
	assert.equal(resolveModelFallbackPolicy({}), undefined);
});

test("resolveModelFallbackPolicy maps config fields", () => {
	const policy = resolveModelFallbackPolicy({
		maxAutoFallbacks: 3,
		order: "asIs",
		requireCredentials: true,
	});
	assert.equal(policy?.maxAutoFallbacks, 3);
	assert.equal(policy?.order, "asIs");
	assert.equal(policy?.requireCredentials, true);
	assert.equal(policy?.quotaAwareOrdering, true);
});

test("resolveModelFallbackPolicy env vars override config", () => {
	const env = { PI_CREW_MAX_AUTO_FALLBACKS: "5", PI_CREW_MODEL_FALLBACK_ORDER: "asIs" };
	const policy = resolveModelFallbackPolicy({ maxAutoFallbacks: 3, order: "parentFirst" }, env as NodeJS.ProcessEnv);
	assert.equal(policy?.maxAutoFallbacks, 5);
	assert.equal(policy?.order, "asIs");
});

test("resolveModelFallbackPolicy quotaAwareOrdering defaults to true", () => {
	const policy = resolveModelFallbackPolicy({ maxAutoFallbacks: 1 });
	assert.equal(policy?.quotaAwareOrdering, true);
	const disabled = resolveModelFallbackPolicy({ quotaAwareOrdering: false, maxAutoFallbacks: 1 });
	assert.equal(disabled?.quotaAwareOrdering, false);
});

// ── Policy: resolveDefaultSubagentModel ──────────────────────────────────────

test("resolveDefaultSubagentModel returns undefined when nothing configured", () => {
	assert.equal(resolveDefaultSubagentModel(undefined), undefined);
	assert.equal(resolveDefaultSubagentModel({}), undefined);
});

test("resolveDefaultSubagentModel prefers env over config", () => {
	const env = { PI_CREW_MODEL: "openai/gpt-5" };
	assert.equal(resolveDefaultSubagentModel({ defaultSubagentModel: "anthropic/sonnet" }, env as NodeJS.ProcessEnv), "openai/gpt-5");
});

test("resolveDefaultSubagentModel falls back to config", () => {
	assert.equal(resolveDefaultSubagentModel({ defaultSubagentModel: "anthropic/sonnet" }), "anthropic/sonnet");
});

// ── defaultSubagentModel in chain ────────────────────────────────────────────

test("buildConfiguredModelRouting: defaultSubagentModel takes precedence over parent when agent has no model", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	const routing = buildConfiguredModelRouting({
		agentModel: undefined,
		defaultSubagentModel: "openai-codex/gpt-5-mini",
		parentModel: { provider: "minimax", id: "MiniMax-M3" },
		modelRegistry,
	});
	assert.equal(routing.requested, "openai-codex/gpt-5-mini");
	assert.equal(routing.candidates[0], "openai-codex/gpt-5-mini");
	// Parent model becomes the first fallback after the default.
	assert.ok(routing.candidates.includes("minimax/MiniMax-M3"));
});

test("buildConfiguredModelRouting: agent model beats defaultSubagentModel", () => {
	const modelRegistry = {
		getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
	};
	const routing = buildConfiguredModelRouting({
		agentModel: "anthropic/claude-sonnet-4-5",
		defaultSubagentModel: "openai-codex/gpt-5.5",
		parentModel: { provider: "minimax", id: "MiniMax-M3" },
		modelRegistry,
	});
	assert.equal(routing.requested, "anthropic/claude-sonnet-4-5");
	assert.equal(routing.candidates[0], "anthropic/claude-sonnet-4-5");
});

test("buildConfiguredModelRouting: maxAutoFallbacks caps the auto tail", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
			{ provider: "gemini", id: "gemini-pro" },
			{ provider: "anthropic", id: "sonnet" },
		],
	};
	const routing = buildConfiguredModelRouting({
		agentModel: "claude-haiku-4-5",
		modelRegistry,
		policy: { maxAutoFallbacks: 2 },
	});
	// declared (1) + auto tail capped at 2 = 3 total
	assert.equal(routing.candidates.length, 3);
	assert.equal(routing.autoFallbackCount, 2);
});

test("buildConfiguredModelRouting: teamRoleFallbackModels appear in declared chain", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
			{ provider: "gemini", id: "gemini-pro" },
		],
	};
	const routing = buildConfiguredModelRouting({
		teamRoleModel: "openai-codex/gpt-5.5",
		teamRoleFallbackModels: ["openai-codex/gpt-5-mini", "gemini/gemini-pro"],
		agentModel: undefined,
		parentModel: { provider: "minimax", id: "MiniMax-M3" },
		modelRegistry,
	});
	// teamRoleFallbackModels come right after the effective agent model.
	const roleIdx = routing.candidates.indexOf("openai-codex/gpt-5.5");
	assert.ok(roleIdx >= 0, "teamRoleModel should be in candidates");
	assert.ok(routing.candidates.indexOf("openai-codex/gpt-5-mini") > roleIdx);
	assert.ok(routing.candidates.indexOf("gemini/gemini-pro") > roleIdx);
});

test("buildConfiguredModelRouting: droppedRequested is set when requested model is unavailable", () => {
	const modelRegistry = {
		getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
	};
	const routing = buildConfiguredModelRouting({
		overrideModel: "nonexistent/model",
		modelRegistry,
	});
	assert.equal(routing.droppedRequested, "nonexistent/model");
	assert.equal(routing.requested, "nonexistent/model");
	assert.equal(routing.candidates[0], "openai-codex/gpt-5.5");
});

// ── L3: PI_CREW_MAX_AUTO_FALLBACKS env guard ────────────────────────────────

test("resolveModelFallbackPolicy: env PI_CREW_MAX_AUTO_FALLBACKS NaN value falls back, no crash", () => {
	const env = { PI_CREW_MAX_AUTO_FALLBACKS: "abc" };
	const policy = resolveModelFallbackPolicy(undefined, env as NodeJS.ProcessEnv);
	// NaN is invalid -> fall back to config (undefined) -> maxAutoFallbacks absent.
	assert.equal(policy?.maxAutoFallbacks, undefined);
});

test("resolveModelFallbackPolicy: env PI_CREW_MAX_AUTO_FALLBACKS NaN falls back to config when config is set", () => {
	const env = { PI_CREW_MAX_AUTO_FALLBACKS: "abc" };
	const policy = resolveModelFallbackPolicy({ maxAutoFallbacks: 7 }, env as NodeJS.ProcessEnv);
	assert.equal(policy?.maxAutoFallbacks, 7);
});

test("resolveModelFallbackPolicy: env PI_CREW_MAX_AUTO_FALLBACKS negative clamped to 0", () => {
	const env = { PI_CREW_MAX_AUTO_FALLBACKS: "-5" };
	const policy = resolveModelFallbackPolicy(undefined, env as NodeJS.ProcessEnv);
	assert.equal(policy?.maxAutoFallbacks, 0);
});

// ── Sec-M1: scope gate attribution tests ─────────────────────────────────────
// Verifies the source attribution chain: override/step/teamRole -> "caller"
// (hard-error when out-of-scope); agentModel -> "frontmatter" (soft warn);
// defaultSubagentModel + parentModel -> "resolved" (soft warn).

function mockScopeRegistry(models: string[]): { getAvailable(): unknown[] } {
	return {
		getAvailable: () =>
			models.map((fullId) => ({
				provider: fullId.split("/")[0],
				id: fullId.split("/").slice(1).join("/"),
				fullId,
			})),
	};
}

function scopeCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-scope-"));
}

test("scope gate a: overrideModel out-of-scope -> throws CrewError (hard error)", () => {
	const cwd = scopeCwd();
	try {
		assert.throws(
			() =>
				buildConfiguredModelRouting({
					overrideModel: "openai/gpt-5",
					modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
					scopeModelsPatterns: ["anthropic/*"],
					cwd,
				}),
			(err: unknown) => {
				assert.ok(err instanceof CrewError, "throws CrewError");
				assert.equal((err as CrewError).code, ErrorCode.ModelOutOfScope);
				return true;
			},
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate a2: stepModel out-of-scope -> throws CrewError (hard error, F7 contract)", () => {
	const cwd = scopeCwd();
	try {
		assert.throws(
			() =>
				buildConfiguredModelRouting({
					stepModel: "openai/gpt-5",
					modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
					scopeModelsPatterns: ["anthropic/*"],
					cwd,
				}),
			(err: unknown) => {
				assert.ok(err instanceof CrewError, "throws CrewError");
				assert.equal((err as CrewError).code, ErrorCode.ModelOutOfScope);
				return true;
			},
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate a3: teamRoleModel out-of-scope -> throws CrewError (hard error, F7 contract)", () => {
	const cwd = scopeCwd();
	try {
		assert.throws(
			() =>
				buildConfiguredModelRouting({
					teamRoleModel: "openai/gpt-5",
					modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
					scopeModelsPatterns: ["anthropic/*"],
					cwd,
				}),
			(err: unknown) => {
				assert.ok(err instanceof CrewError, "throws CrewError");
				assert.equal((err as CrewError).code, ErrorCode.ModelOutOfScope);
				return true;
			},
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate b: defaultSubagentModel out-of-scope -> verdict inScope=false, NO throw", () => {
	const cwd = scopeCwd();
	try {
		const routing = buildConfiguredModelRouting({
			defaultSubagentModel: "openai/gpt-5",
			modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
			scopeModelsPatterns: ["anthropic/*"],
			cwd,
		});
		assert.equal(routing.scopeVerdict?.inScope, false);
		assert.equal(routing.scopeVerdict?.source, "resolved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate c: parentModel only (no agent/caller) out-of-scope -> verdict inScope=false, NO throw", () => {
	const cwd = scopeCwd();
	try {
		const routing = buildConfiguredModelRouting({
			parentModel: { provider: "openai", id: "gpt-5" },
			modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
			scopeModelsPatterns: ["anthropic/*"],
			cwd,
		});
		assert.equal(routing.scopeVerdict?.inScope, false);
		assert.equal(routing.scopeVerdict?.source, "resolved");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate d: agentModel (frontmatter) out-of-scope -> verdict inScope=false, NO throw", () => {
	const cwd = scopeCwd();
	try {
		const routing = buildConfiguredModelRouting({
			agentModel: "openai/gpt-5",
			modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
			scopeModelsPatterns: ["anthropic/*"],
			cwd,
		});
		assert.equal(routing.scopeVerdict?.inScope, false);
		assert.equal(routing.scopeVerdict?.source, "frontmatter");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scope gate e: model in-scope -> verdict inScope=true", () => {
	const cwd = scopeCwd();
	try {
		const routing = buildConfiguredModelRouting({
			agentModel: "anthropic/sonnet",
			modelRegistry: mockScopeRegistry(["openai/gpt-5", "anthropic/sonnet"]),
			scopeModelsPatterns: ["anthropic/*"],
			cwd,
		});
		assert.equal(routing.scopeVerdict?.inScope, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── F1/Sec-M1: warnOutOfScopeSoft centralises the "warn" severity ──────────
// Round-2 F1 found two call sites forgot the "warn" arg, making the warning
// debug-gated/silent. This guards the helper that now centralises it: if the
// "warn" severity is dropped, logInternalError becomes debug-gated and
// console.error is never called -> this test fails.
test("warnOutOfScopeSoft: emits for out-of-scope non-caller, silent otherwise", () => {
	const original = console.error;
	const calls: string[] = [];
	console.error = (msg: string) => {
		calls.push(msg);
	};
	try {
		// out-of-scope + non-caller source -> emits (the soft-warn path)
		warnOutOfScopeSoft({ inScope: false, source: "frontmatter", model: "openai/gpt-5", reason: "not allowed" }, "test.scope");
		assert.equal(calls.length, 1);
		assert.match(calls[0], /\[pi-crew:test\.scope\]/);
		assert.match(calls[0], /openai\/gpt-5/);
		assert.match(calls[0], /frontmatter/);
		// in-scope -> silent
		calls.length = 0;
		warnOutOfScopeSoft({ inScope: true, source: "frontmatter", model: "anthropic/ok" }, "test.scope");
		assert.equal(calls.length, 0);
		// caller source -> silent (caller throws inside buildConfiguredModelRouting)
		warnOutOfScopeSoft({ inScope: false, source: "caller", model: "openai/gpt-5" }, "test.scope");
		assert.equal(calls.length, 0);
		// undefined verdict -> silent
		warnOutOfScopeSoft(undefined, "test.scope");
		assert.equal(calls.length, 0);
	} finally {
		console.error = original;
	}
});
