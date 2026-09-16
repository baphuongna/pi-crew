import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig, PROVIDER_STATUS_ID } from "../../../../src/extension/crew-vibes/config.ts";
import { asCrewTheme, renderProviderUsage } from "../../../../src/extension/crew-vibes/render.ts";
import type { CrewTheme } from "../../../../src/ui/theme-adapter.ts";

const theme: CrewTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => text,
	inverse: (text) => text,
};

test("normalizeConfig accepts a valid custom sextet and tokenDisplay", () => {
	const cfg = normalizeConfig({
		capacity: {
			tokenDisplay: "percentage",
			labels: ["a", "b", "c", "d", "e", "f"],
			icons: ["1", "2", "3", "4", "5", "6"],
		},
	});
	assert.equal(cfg.capacity.tokenDisplay, "percentage");
	assert.deepEqual(cfg.capacity.labels, ["a", "b", "c", "d", "e", "f"]);
	assert.deepEqual(cfg.capacity.icons, ["1", "2", "3", "4", "5", "6"]);
});

test("asCrewTheme returns undefined for non-theme objects", () => {
	assert.equal(asCrewTheme(undefined), undefined);
	assert.equal(asCrewTheme({}), undefined);
	assert.ok(asCrewTheme(theme));
});

// ---------------------------------------------------------------------------
// Config: providerUsage defaults + PROVIDER_STATUS_ID
// ---------------------------------------------------------------------------

test("PROVIDER_STATUS_ID is the expected status id", () => {
	assert.equal(PROVIDER_STATUS_ID, "pi-crew-bar");
});

test("DEFAULT_CONFIG has providerUsage enabled with 5min refresh", () => {
	assert.equal(DEFAULT_CONFIG.capacity.providerUsage, true);
	assert.equal(DEFAULT_CONFIG.capacity.providerRefreshMs, 120000);
});

test("normalizeConfig fills providerUsage defaults from empty input", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.capacity.providerUsage, true);
	assert.equal(cfg.capacity.providerRefreshMs, 120000);
});

test("normalizeConfig accepts custom providerUsage settings", () => {
	const cfg = normalizeConfig({ capacity: { providerUsage: false, providerRefreshMs: 60000 } });
	assert.equal(cfg.capacity.providerUsage, false);
	assert.equal(cfg.capacity.providerRefreshMs, 60000);
});

test("normalizeConfig clamps invalid providerRefreshMs to the default", () => {
	const negative = normalizeConfig({ capacity: { providerRefreshMs: -5 } });
	assert.equal(negative.capacity.providerRefreshMs, 120000);
	const nonNumeric = normalizeConfig({ capacity: { providerRefreshMs: "nope" } });
	assert.equal(nonNumeric.capacity.providerRefreshMs, 120000);
});

// ---------------------------------------------------------------------------
// render.ts: renderProviderUsage
// ---------------------------------------------------------------------------

test("renderProviderUsage returns undefined for null usage", () => {
	assert.equal(renderProviderUsage(theme, null), undefined);
});

test("renderProviderUsage shows accent color under 80%", () => {
	const usage = { providerName: "Test", fiveHourPercent: 45, weeklyPercent: 23, fiveHourResetAt: null, weeklyResetAt: null };
	assert.match(renderProviderUsage(theme, usage)!, /<accent>5h [\u2501\u2504]+ 45%<\/accent> <dim>Wk [\u2501\u2504]+ 23%<\/dim>/);
});

test("renderProviderUsage shows error color at 80%+", () => {
	const usage = { providerName: "Test", fiveHourPercent: 85, weeklyPercent: 50, fiveHourResetAt: null, weeklyResetAt: null };
	const out = renderProviderUsage(theme, usage);
	assert.match(out!, /<error>5h [\u2501\u2504]+ 85%<\/error> <dim>Wk [\u2501\u2504]+ 50%<\/dim>/);
	assert.doesNotMatch(out!, /<accent>/);
});

test("renderProviderUsage switches accent→error exactly at the 80% boundary", () => {
	assert.match(
		renderProviderUsage(theme, {
			providerName: "Test",
			fiveHourPercent: 79,
			weeklyPercent: 5,
			fiveHourResetAt: null,
			weeklyResetAt: null,
		})!,
		/<accent>5h [\u2501\u2504]+ 79%<\/accent>/,
	);
	assert.match(
		renderProviderUsage(theme, {
			providerName: "Test",
			fiveHourPercent: 80,
			weeklyPercent: 5,
			fiveHourResetAt: null,
			weeklyResetAt: null,
		})!,
		/<error>5h [\u2501\u2504]+ 80%<\/error>/,
	);
});

test("renderProviderUsage shows reset timer when resetAt is in the future", () => {
	// ~3h from now; formatResetTimer floors minutes, so the exact h/m digits
	// depend on sub-second drift — assert the timer segment exists, not its value.
	const resetAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
	const usage = { providerName: "Test", fiveHourPercent: 30, fiveHourResetAt: resetAt, weeklyPercent: 10, weeklyResetAt: null };
	const out = renderProviderUsage(theme, usage);
	assert.match(out!, /\d+[hm](\d+[hm])?/);
});

test("renderProviderUsage omits reset timer when resetAt is in the past", () => {
	const usage = {
		providerName: "Test",
		fiveHourPercent: 30,
		fiveHourResetAt: "2000-01-01T00:00:00Z",
		weeklyPercent: 10,
		weeklyResetAt: null,
	};
	assert.match(renderProviderUsage(theme, usage)!, /<accent>5h [\u2501\u2504]+ 30%<\/accent> <dim>Wk [\u2501\u2504]+ 10%<\/dim>/);
});

test("renderProviderUsage includes Copilot monthly percent when present", () => {
	const usage = {
		providerName: "Test",
		fiveHourPercent: 30,
		weeklyPercent: 10,
		fiveHourResetAt: null,
		weeklyResetAt: null,
		copilotMonthlyPercent: 68,
	};
	assert.match(
		renderProviderUsage(theme, usage)!,
		/<accent>5h [\u2501\u2504]+ 30%<\/accent> <dim>Wk [\u2501\u2504]+ 10%<\/dim> <dim>Mo: 68%<\/dim>/,
	);
});

test("renderProviderUsage works without theme (plain text)", () => {
	const usage = { providerName: "Test", fiveHourPercent: 45, weeklyPercent: 23, fiveHourResetAt: null, weeklyResetAt: null };
	const out = renderProviderUsage(undefined, usage);
	assert.match(out!, /^Test 5h [\u2501\u2504]+ 45% Wk [\u2501\u2504]+ 23%$/);
	assert.doesNotMatch(out!, /</);
});

// ---------------------------------------------------------------------------
// footer.ts: custom setFooter component (definitive quota-truncation fix)
// ---------------------------------------------------------------------------

// Plain no-op theme so visibleWidth math is exact (no ANSI/markup to count).
const plainTheme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };

function footerCtx() {
	return {
		hasUI: true,
		sessionManager: { getCwd: () => "/tmp/proj", getSessionName: () => undefined, getEntries: () => [] },
		modelRegistry: { isUsingOAuth: () => false },
		model: { id: "m", provider: "anthropic", reasoning: false, contextWindow: 200000 },
		getContextUsage: () => ({ tokens: 1000, percent: 5, contextWindow: 200000 }),
	};
}

function footerData(entries: [string, string][]) {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(entries),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => undefined,
	};
} // ---------------------------------------------------------------------------
// provider-usage.ts: fetchProviderUsage + cache
//
// These tests fully isolate HOME + provider env vars and mock globalThis.fetch
// so they NEVER make real network calls and never depend on the host machine's
// real ~/.pi/agent/auth.json.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS = ["ANTHROPIC_OAUTH_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "XDG_CONFIG_HOME"] as const;

/** Build a counting fetch mock whose per-URL handler returns a Response. */
function makeFetchMock(handler: (url: string) => Response): { fn: typeof fetch; counter: { calls: number } } {
	const counter = { calls: 0 };
	const fn = (async (input: RequestInfo | URL, _init?: RequestInit) => {
		counter.calls++;
		const url = typeof input === "string" ? input : input.toString();
		return handler(url);
	}) as typeof fetch;
	return { fn, counter };
}

const ANTHROPIC_USAGE_BODY = {
	five_hour: { utilization: 45.5, resets_at: "2026-07-08T16:00:00Z" },
	seven_day: { utilization: 23.0, resets_at: "2026-07-10T00:00:00Z" },
};

/** Mock that serves the Anthropic usage payload for anthropic URLs, empty JSON otherwise. */
function anthropicOkMock(): { fn: typeof fetch; counter: { calls: number } } {
	return makeFetchMock((url) =>
		url.includes("anthropic")
			? new Response(JSON.stringify(ANTHROPIC_USAGE_BODY), { status: 200 })
			: new Response("{}", { status: 200 }),
	);
}
