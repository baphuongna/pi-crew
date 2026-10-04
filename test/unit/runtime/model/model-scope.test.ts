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

	it("matches glob against the configured form AND the bare id (canonical tries both)", () => {
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "claude-*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-haiku-4-5", "claude-*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "*sonnet*"), false);
		assert.equal(matchesModelPattern("openai/gpt-4o-sonnet-preview", "*sonnet*"), true);
		assert.equal(matchesModelPattern("github-copilot/claude-3.5-sonnet", "github-copilot/*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "github-copilot/*"), false);
	});

	it("falls back to case-insensitive substring when no glob chars in pattern", () => {
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

describe("matchesModelPattern — R3-20 divergence 1: `:<thinking>` suffix", () => {
	it("strips a valid thinking suffix from the PATTERN (the false-hard-error fix)", () => {
		// enabledModels carries `anthropic/claude-sonnet-5:high`; the resolved
		// model is the plain id — must be in scope, not E013.
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5:high"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5", "sonnet:high"), true);
	});

	it("strips a valid thinking suffix from the MODEL id (resolved candidates keep `:high`)", () => {
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5:high", "anthropic/claude-sonnet-5"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5:high", "anthropic/*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5:high", "anthropic/claude-sonnet-5:low"), true);
	});

	it("recognizes all canonical level names on the pattern side", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal(matchesModelPattern("anthropic/claude-x", `anthropic/claude-x:${level}`), true, level);
		}
	});

	it("glob branch strips one VALID suffix (canonical glob rule: `provider/*:high`)", () => {
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-5", "anthropic/*:high"), true);
		// Invalid level names are NOT stripped in the glob branch (canonical
		// keeps the raw glob when the suffix is not a valid level).
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/*:higher"), false);
	});

	it("level names are case-sensitive: `:HIGH` is not a valid glob suffix, but the fuzzy branch still recurses", () => {
		// Glob branch: `:HIGH` invalid → not stripped → no match.
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/*:HIGH"), false);
		// Fuzzy branch (no glob chars): parseModelPattern recurses on the
		// prefix for invalid suffixes (with a warning) → membership follows prefix.
		assert.equal(matchesModelPattern("anthropic/claude-x", "claude-x:HIGH"), true);
		assert.equal(matchesModelPattern("anthropic/claude-x", "claude-x:notalevel"), true);
	});

	it("multi-colon patterns strip progressively (fuzzy recursion)", () => {
		assert.equal(matchesModelPattern("claude-x", "claude-x:high:off"), true);
	});

	it("preserves colon-ful model ids that are not thinking suffixes (OpenRouter style)", () => {
		// `:exacto` is not a valid level → the MODEL id keeps it.
		assert.equal(matchesModelPattern("openrouter/model:exacto", "openrouter/model:exacto"), true);
		assert.equal(matchesModelPattern("openrouter/model:exacto", "openrouter/*"), true);
		// Pattern side: canonical scope mode recurses through invalid suffixes
		// (parseModelPattern strips + warns), so the prefix still decides.
		assert.equal(matchesModelPattern("openrouter/model", "openrouter/model:exacto"), true);
	});
});

describe("matchesModelPattern — R3-20 divergence 2: `?` and `[` glob chars", () => {
	it("treats `?` as a glob char (single non-separator char), not a substring", () => {
		assert.equal(matchesModelPattern("openai/gpt-4o", "gpt-?o"), true);
		assert.equal(matchesModelPattern("openai/gpt-4o", "openai/gpt-?o"), true);
		assert.equal(matchesModelPattern("openai/gpt-44o", "gpt-?o"), false);
		// `?` must NOT cross `/` (minimatch semantics).
		assert.equal(matchesModelPattern("openai/gpt-4o", "openai?gpt-4o"), false);
	});

	it("supports character classes with `!` and `^` negation", () => {
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/[cg]laude-x"), true);
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/[dz]laude-x"), false);
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/[!z]laude-x"), true);
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/[!c]laude-x"), false);
		assert.equal(matchesModelPattern("anthropic/claude-x", "anthropic/[^z]laude-x"), true);
	});

	it("treats an unmatched `[` as a literal", () => {
		assert.equal(matchesModelPattern("openai/gpt-4o[mini", "gpt-4o[mini"), true);
	});
});

describe("matchesModelPattern — R3-20 divergence 4: provider/id AND bare-id glob forms", () => {
	it("bare-id glob hit: provider-scoped string matched by an id-only glob", () => {
		// Old matcher required the glob to match the full `provider/id` string.
		assert.equal(matchesModelPattern("openai/gpt-5-mini", "gpt-5*"), true);
		assert.equal(matchesModelPattern("openai/gpt-4o", "openai/*"), true);
		assert.equal(matchesModelPattern("openai/gpt-4o", "anthropic/*"), false);
	});

	it("`*` alone matches any model via the bare-id form", () => {
		assert.equal(matchesModelPattern("anything/model-x", "*"), true);
		assert.equal(matchesModelPattern("model-x", "*"), true);
	});

	it("bare id = segment after the FIRST slash (openrouter ids contain slashes)", () => {
		assert.equal(matchesModelPattern("openrouter/moonshotai/kimi-k2.6", "openrouter/moonshotai/*"), true);
		assert.equal(matchesModelPattern("openrouter/moonshotai/kimi-k2.6", "moonshotai/*"), true);
		assert.equal(matchesModelPattern("openrouter/moonshotai/kimi-k2.6", "openrouter/*"), false);
	});
});

describe("matchesModelPattern — R3-20 divergence 3: display-name fuzzy (documented residual)", () => {
	it("display-name-only patterns stay unmatched without the catalog", () => {
		// Canonical fuzzy also matches model display `name`s
		// (model-resolver.js:114-115); a pure string matcher cannot replicate
		// that. Documented residual gap — see model-scope.ts header.
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "Claude Opus 4.5"), false);
		// Id-substring patterns still work (the common case).
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "Opus"), true);
	});
});

describe("matchesModelPattern — boundary", () => {
	it("no negation support (canonical enabledModels has none)", () => {
		// A leading `!` is matched literally, never treated as a negator.
		assert.equal(matchesModelPattern("anthropic/claude-x", "!claude-*"), false);
	});
});

describe("matchesModelPattern — regression: patterns used in pi docs/config examples", () => {
	it("docs example set keeps its verdicts", () => {
		// cli.md --models / settings.md enabledModels examples.
		assert.equal(matchesModelPattern("anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-4-5", "claude-*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-4-5", "*sonnet*"), true);
		assert.equal(matchesModelPattern("github-copilot/gpt-5.4", "github-copilot/*"), true);
		assert.equal(matchesModelPattern("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5:high"), true);
		// `--models sonnet:high,haiku:low` arrives here as separate elements.
		assert.equal(matchesModelPattern("anthropic/claude-haiku-4-5", "haiku:low"), true);
	});
});

describe("patternToRegExp", () => {
	it("escapes regex meta-characters", () => {
		// '.' must be literal, not regex any-char.
		assert.equal(patternToRegExp("a.b").test("axb"), false);
		assert.equal(patternToRegExp("a.b").test("a.b"), true);
	});

	it("converts '*' to a non-slash run (minimatch: `*` does not cross '/')", () => {
		assert.equal(patternToRegExp("claude-*").test("claude-opus"), true);
		// Cross-segment matching is matchesModelPattern's job (it retries the
		// bare-id form, like canonical minimatch(fullId) || minimatch(id)).
		assert.equal(patternToRegExp("claude-*").test("anthropic/claude-opus-4-5"), false);
		assert.equal(patternToRegExp("*sonnet*").test("gpt-4o-sonnet-preview"), true);
		assert.equal(patternToRegExp("*sonnet*").test("openai/gpt-4o-sonnet-preview"), false);
	});

	it("supports `?` and character classes", () => {
		assert.equal(patternToRegExp("gpt-?o").test("gpt-4o"), true);
		assert.equal(patternToRegExp("gpt-?o").test("gpt-44o"), false);
		assert.equal(patternToRegExp("[cg]laude").test("claude"), true);
		assert.equal(patternToRegExp("[cg]laude").test("dlaude"), false);
		assert.equal(patternToRegExp("[!c]laude").test("dlaude"), true);
		assert.equal(patternToRegExp("[!c]laude").test("claude"), false);
		assert.equal(patternToRegExp("a[b").test("a[b"), true);
	});

	it("whole-segment `**` crosses separators but still needs the preceding '/'", () => {
		assert.equal(patternToRegExp("anthropic/**").test("anthropic/claude-x"), true);
		assert.equal(patternToRegExp("anthropic/**").test("anthropic"), false);
		assert.equal(patternToRegExp("a/**").test("a/b/c"), true);
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

	it("R3-20: `:<thinking>` suffix in patterns no longer false-rejects caller models", () => {
		// The reported bug: enabledModels carries `provider/model:high`, the
		// plain resolved model got a hard E013 out-of-scope error.
		const cwd = freshCwd();
		const input = (extra: Record<string, unknown>) => ({
			...baseInput(cwd),
			modelRegistry: mockModelRegistry(["openai/gpt-4o", "anthropic/claude-sonnet-5"]),
			...extra,
		});
		const result = buildConfiguredModelRouting(
			input({
				overrideModel: "anthropic/claude-sonnet-5",
				scopeModelsPatterns: ["anthropic/claude-sonnet-5:high"],
			}),
		);
		assert.equal(result.scopeVerdict?.inScope, true);
		assert.equal(result.scopeVerdict?.source, "caller");
		assert.equal(result.scopeVerdict?.matchedPattern, "anthropic/claude-sonnet-5:high");

		// Resolved model carrying the suffix, pattern without it.
		const result2 = buildConfiguredModelRouting(
			input({
				overrideModel: "anthropic/claude-sonnet-5:high",
				scopeModelsPatterns: ["anthropic/*"],
			}),
		);
		assert.equal(result2.scopeVerdict?.inScope, true);
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
