import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildConfiguredModelCandidates, buildConfiguredModelRouting, buildModelCandidates, configuredModelInfosFromPiConfig, resolveModelCandidate, splitThinkingSuffix } from "../../src/runtime/model-fallback.ts";

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

test("buildConfiguredModelCandidates only uses configured Pi models before parent default", () => {
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
		["openai-codex/gpt-5-mini", "openai-codex/gpt-5.5"],
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

test("buildConfiguredModelRouting persists requested model and fallback chain", () => {
	const modelRegistry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	const routing = buildConfiguredModelRouting({ agentModel: "claude-haiku-4-5", fallbackModels: ["gpt-5-mini"], parentModel: { provider: "openai-codex", id: "gpt-5.5" }, modelRegistry });
	assert.equal(routing.requested, "claude-haiku-4-5");
	assert.deepEqual(routing.candidates, ["openai-codex/gpt-5-mini", "openai-codex/gpt-5.5"]);
	assert.match(routing.reason ?? "", /fallback/);
});

test("buildConfiguredModelCandidates falls back to Pi default when no configured model is selected", () => {
	const modelRegistry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.5" }] };
	assert.deepEqual(
		buildConfiguredModelCandidates({ agentModel: "claude-haiku-4-5", parentModel: { provider: "openai-codex", id: "gpt-5.5" }, modelRegistry }),
		["openai-codex/gpt-5.5"],
	);
});

test("buildConfiguredModelCandidates does not trust builtin agent models without Pi registry", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-models-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	try {
		assert.deepEqual(buildConfiguredModelCandidates({ agentModel: "claude-haiku-4-5", fallbackModels: ["sonnet"] }), []);
		assert.deepEqual(buildConfiguredModelCandidates({ overrideModel: "openai-codex/gpt-5.5", agentModel: "claude-haiku-4-5" }), ["openai-codex/gpt-5.5"]);
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
			{ provider: "custom", id: "custom-model", fullId: "custom/custom-model" },
			{ provider: "custom", id: "overridden-model", fullId: "custom/overridden-model" },
			{ provider: "project-provider", id: "project-model", fullId: "project-provider/project-model" },
		]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
