import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildConfiguredModelCandidates, buildConfiguredModelRouting, buildModelCandidates, configuredModelInfosFromPiConfig, isRetryableModelFailure, resolveModelCandidate, splitThinkingSuffix } from "../../src/runtime/model-fallback.ts";

test("splitThinkingSuffix preserves model suffix", () => {
	assert.deepEqual(splitThinkingSuffix("claude-sonnet:high"), { baseModel: "claude-sonnet", thinkingSuffix: ":high" });
	assert.deepEqual(splitThinkingSuffix("openai/gpt-5"), { baseModel: "openai/gpt-5", thinkingSuffix: "" });
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
		buildConfiguredModelCandidates({ overrideModel: "gpt-5-mini", agentModel: "claude-haiku-4-5", modelRegistry }),
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
	const routing = buildConfiguredModelRouting({ agentModel: "claude-haiku-4-5", fallbackModels: ["gpt-5-mini"], parentModel: { provider: "openai-codex", id: "gpt-5.5" }, modelRegistry });
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
	const modelRegistry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] };
	assert.deepEqual(
		buildConfiguredModelCandidates({ agentModel: "claude-haiku-4-5", parentModel: { provider: "openai-codex", id: "gpt-5.5" }, modelRegistry }),
		["claude-haiku-4-5", "openai-codex/gpt-5.5"],
	);
});

test("buildConfiguredModelCandidates preserves explicit configured models without Pi registry", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		assert.deepEqual(buildConfiguredModelCandidates({ stepModel: "openai-codex/gpt-5.5", teamRoleModel: "gemini/gemini-pro", agentModel: "claude-haiku-4-5", fallbackModels: ["sonnet"], parentModel: { provider: "parent", id: "model" } }), ["openai-codex/gpt-5.5", "gemini/gemini-pro", "claude-haiku-4-5", "sonnet", "parent/model"]);
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
		assert.deepEqual(buildConfiguredModelCandidates({ agentModel: "claude-haiku-4-5", fallbackModels: ["sonnet"] }), ["claude-haiku-4-5", "sonnet"]);
		assert.deepEqual(buildConfiguredModelCandidates({ overrideModel: "openai-codex/gpt-5.5", agentModel: "claude-haiku-4-5" }), ["openai-codex/gpt-5.5", "claude-haiku-4-5"]);
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
		fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify({ defaultProvider: "configured-provider", defaultModel: "configured-model" }));
		fs.writeFileSync(path.join(tempDir, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "custom-model" }], modelOverrides: { "overridden-model": {} } } } }));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "project-provider", defaultModel: "project-model" }));
		assert.deepEqual(configuredModelInfosFromPiConfig(cwd), [
			{ provider: "project-provider", id: "project-model", fullId: "project-provider/project-model" },
			{ provider: "custom", id: "custom-model", fullId: "custom/custom-model" },
			{ provider: "custom", id: "overridden-model", fullId: "custom/overridden-model" },
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
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
		assert.equal(
			isRetryableModelFailure(err),
			true,
			`expected retryable for: ${err}`,
		);
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
