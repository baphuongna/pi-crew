/**
 * F7 model-scope enforcement tests.
 *
 * Verifies:
 * - Pattern matcher semantics (glob, substring, exact, case-insensitive)
 * - checkModelScope verdict
 * - buildConfiguredModelRouting: caller out-of-scope → throws E013;
 *   frontmatter out-of-scope → warning verdict (no throw)
 * - Toggle default is opt-in (back-compat)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { CrewError, ErrorCode } from "../../../../src/errors.ts";
import { buildConfiguredModelRouting } from "../../../../src/runtime/model/model-fallback.ts";
import { checkModelScope, isModelInScope, matchesModelPattern, patternToRegExp } from "../../../../src/runtime/model/model-scope.ts";

// Use a fresh temp cwd per test so configuredModelInfosFromPiConfig doesn't
// leak the host project's pi settings into the routing candidates (otherwise
// the resolved model becomes the host's default, not the one we set).
const tempDirs: string[] = [];
function freshCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-f7-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
});

describe("matchesModelPattern", () => {
	it("matches exact id (case-insensitive)", () => {
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5"), true);
		assert.equal(matchesModelPattern("Anthropic/Claude-Opus-4-5", "anthropic/claude-opus-4-5"), true);
		assert.equal(matchesModelPattern("openai/gpt-4o", "anthropic/claude-opus-4-5"), false);
	});

	it("matches glob with single '*' wildcard (unanchored — matches anywhere)", () => {
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "claude-*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-haiku-4-5", "claude-*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "*sonnet*"), false);
		assert.equal(matchesModelPattern("openai/gpt-4o-sonnet-preview", "*sonnet*"), true);
		assert.equal(matchesModelPattern("github-copilot/claude-3.5-sonnet", "github-copilot/*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "github-copilot/*"), false);
	});

	it("falls back to case-insensitive substring when no '*' in pattern", () => {
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "opus"), true);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "Opus"), true);
		assert.equal(matchesModelPattern("openai/gpt-4o", "opus"), false);
	});

	it("handles empty / whitespace input safely", () => {
		assert.equal(matchesModelPattern("", "claude-*"), false);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", ""), false);
		assert.equal(matchesModelPattern("  ", "claude-*"), false);
	});
});

describe("patternToRegExp", () => {
	it("escapes regex meta-characters", () => {
		// '.' must be literal, not regex any-char.
		assert.equal(patternToRegExp("a.b").test("axb"), false);
		assert.equal(patternToRegExp("a.b").test("a.b"), true);
	});

	it("converts '*' to .* (unanchored — matches anywhere)", () => {
		assert.equal(patternToRegExp("claude-*").test("claude-opus"), true);
		assert.equal(patternToRegExp("claude-*").test("anthropic/claude-opus-4-5"), true);
		assert.equal(patternToRegExp("*sonnet*").test("gpt-4o-sonnet-preview"), true);
	});

	it("is case-insensitive", () => {
		assert.equal(patternToRegExp("Claude-*").test("claude-opus"), true);
		assert.equal(patternToRegExp("claude-*").test("CLAUDE-OPUS"), true);
	});
});

describe("isModelInScope", () => {
	it("returns true if any pattern matches", () => {
		assert.equal(isModelInScope("anthropic/claude-opus-4-5", ["openai/*", "claude-*"]), true);
		assert.equal(isModelInScope("anthropic/claude-opus-4-5", ["openai/*", "github-copilot/*"]), false);
	});
	it("returns false when patterns is empty or undefined", () => {
		assert.equal(isModelInScope("anthropic/claude-opus-4-5", []), false);
		assert.equal(isModelInScope("anthropic/claude-opus-4-5", undefined), false);
	});
	it("returns false when model is missing", () => {
		assert.equal(isModelInScope(undefined, ["claude-*"]), false);
		assert.equal(isModelInScope("", ["claude-*"]), false);
	});
});

describe("checkModelScope", () => {
	it("returns inScope:true (no reason) when no allowlist is configured", () => {
		const v = checkModelScope("anthropic/claude-opus-4-5", undefined, "caller");
		assert.equal(v.inScope, true);
		assert.equal(v.reason, undefined);
		assert.equal(v.matchedPattern, undefined);
		assert.equal(v.source, "caller");
	});
	it("returns inScope:true with matchedPattern on hit", () => {
		const v = checkModelScope("anthropic/claude-opus-4-5", ["claude-*", "openai/*"], "caller");
		assert.equal(v.inScope, true);
		assert.equal(v.matchedPattern, "claude-*");
	});
	it("returns inScope:false with human reason on miss", () => {
		const v = checkModelScope("openai/gpt-4o", ["claude-*"], "caller");
		assert.equal(v.inScope, false);
		assert.ok(v.reason?.includes("openai/gpt-4o"));
		assert.ok(v.reason?.includes("claude-*"));
	});
});

// Mock model registry. The routing maps each entry through modelInfoFromUnknown
// which requires {provider, id} and constructs fullId = `${provider}/${id}`.
// So id must be the BARE id (no provider prefix) and fullId the canonical one.
function mockModelRegistry(models: string[]): { getAvailable(): unknown[] } {
	return {
		getAvailable: () =>
			models.map((fullId) => ({
				provider: fullId.split("/")[0],
				id: fullId.split("/").slice(1).join("/"),
				fullId,
			})),
	};
}

describe("buildConfiguredModelRouting — F7 scope gate", () => {
	// Models that the mock registry accepts. The gate checks the *resolved*
	// model (candidates[0] or requested) against scopeModelsPatterns.
	const baseInput = (cwd: string) => ({
		stepModel: undefined,
		teamRoleModel: undefined,
		agentModel: undefined,
		fallbackModels: undefined,
		parentModel: undefined,
		modelRegistry: mockModelRegistry(["openai/gpt-4o", "anthropic/claude-opus-4-5"]),
		cwd,
	});

	it("no scopeModelsPatterns → no gate (back-compat, never throws on out-of-scope)", () => {
		// Caller passes a model that would be out-of-scope if patterns were set.
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			overrideModel: "openai/gpt-4o",
		});
		assert.equal(result.scopeVerdict, undefined);
	});

	it("caller override out-of-scope → throws CrewError E013", () => {
		assert.throws(
			() =>
				buildConfiguredModelRouting({
					...baseInput(freshCwd()),
					overrideModel: "openai/gpt-4o",
					scopeModelsPatterns: ["claude-*"],
				}),
			(err: unknown) => {
				assert.ok(err instanceof CrewError, "throws CrewError");
				assert.equal((err as CrewError).code, ErrorCode.ModelOutOfScope);
				assert.ok(err instanceof Error && err.message.includes("openai/gpt-4o"));
				return true;
			},
		);
	});

	it("caller override in-scope → no throw, verdict recorded", () => {
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			overrideModel: "anthropic/claude-opus-4-5",
			scopeModelsPatterns: ["claude-*"],
		});
		assert.equal(result.scopeVerdict?.inScope, true);
		assert.equal(result.scopeVerdict?.source, "caller");
		assert.equal(result.scopeVerdict?.matchedPattern, "claude-*");
	});

	it("frontmatter agent model out-of-scope → returns verdict, NO throw", () => {
		// No caller override — only frontmatter (agentModel) is set and out-of-scope.
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			agentModel: "openai/gpt-4o",
			scopeModelsPatterns: ["claude-*"],
		});
		assert.equal(result.scopeVerdict?.inScope, false);
		assert.equal(result.scopeVerdict?.source, "frontmatter");
		assert.ok(result.scopeVerdict?.reason?.includes("openai/gpt-4o"));
		// No throw — frontmatter is authoritative (warning, not error).
	});

	it("frontmatter agent model in-scope → verdict inScope:true", () => {
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			agentModel: "anthropic/claude-opus-4-5",
			scopeModelsPatterns: ["claude-*"],
		});
		assert.equal(result.scopeVerdict?.inScope, true);
		assert.equal(result.scopeVerdict?.source, "frontmatter");
		assert.equal(result.scopeVerdict?.matchedPattern, "claude-*");
	});

	it("isFrontmatterOverride=true downgrades caller override to warning (not throw)", () => {
		// Use case: the agent config's model is passed as overrideModel (e.g. the
		// caller re-asserts the frontmatter model at spawn time) — the trust
		// distinction says this is still frontmatter, not a hard error.
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			overrideModel: "openai/gpt-4o",
			agentModel: "openai/gpt-4o",
			isFrontmatterOverride: true,
			scopeModelsPatterns: ["claude-*"],
		});
		assert.equal(result.scopeVerdict?.inScope, false);
		// F5: isFrontmatterOverride downgrades to "frontmatter" source so the
		// call-site soft warning actually surfaces (warning fires when source !== "caller").
		assert.equal(result.scopeVerdict?.source, "frontmatter");
		// No throw.
	});

	it("empty scopeModelsPatterns → no gate (treated as no enforcement)", () => {
		const result = buildConfiguredModelRouting({
			...baseInput(freshCwd()),
			overrideModel: "openai/gpt-4o",
			scopeModelsPatterns: [],
		});
		// Empty patterns = no allowlist configured = no-op (no verdict, no throw).
		assert.equal(result.scopeVerdict, undefined);
	});
});
