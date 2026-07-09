import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig, PROVIDER_STATUS_ID } from "../../src/extension/crew-vibes/config.ts";
import { capacityIndex, intervalForSpeed, isDangerStage, RUN_CREW_FRAMES } from "../../src/extension/crew-vibes/figures.ts";
import { clearProviderUsageCache, fetchProviderUsage } from "../../src/extension/crew-vibes/provider-usage.ts";
import {
	asCrewTheme,
	formatCount,
	formatSpeed,
	getCapacityUsage,
	renderCapacity,
	renderProviderUsage,
	renderSpeedFooter,
	renderWorkingMessage,
} from "../../src/extension/crew-vibes/render.ts";
import { SpeedTracker, TokenSpeedEngine } from "../../src/extension/crew-vibes/speed.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";

const theme: CrewTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => text,
	inverse: (text) => text,
};

test("DEFAULT_CONFIG has six capacity stages and sane speed defaults", () => {
	assert.equal(DEFAULT_CONFIG.capacity.icons.length, 6);
	assert.equal(DEFAULT_CONFIG.capacity.labels.length, 6);
	assert.equal(DEFAULT_CONFIG.speed.label, "tok/s");
	assert.ok(DEFAULT_CONFIG.speed.minIntervalMs <= DEFAULT_CONFIG.speed.maxIntervalMs);
});

test("normalizeConfig fills defaults from empty input and clamps bad values", () => {
	const cfg = normalizeConfig({});
	assert.deepEqual(cfg, DEFAULT_CONFIG);

	const clamped = normalizeConfig({ speed: { minIntervalMs: 999, maxIntervalMs: 1 } });
	assert.equal(clamped.speed.minIntervalMs, DEFAULT_CONFIG.speed.minIntervalMs);
	assert.equal(clamped.speed.maxIntervalMs, DEFAULT_CONFIG.speed.maxIntervalMs);

	const badLabels = normalizeConfig({ capacity: { labels: ["only"] } });
	assert.deepEqual(badLabels.capacity.labels, DEFAULT_CONFIG.capacity.labels);
});

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

test("RUN_CREW_FRAMES are all equal width so the indicator does not jitter", () => {
	const widths = RUN_CREW_FRAMES.map((frame) => frame.length);
	assert.ok(
		widths.every((width) => width === widths[0]),
		`frames have unequal widths: ${widths.join(",")}`,
	);
	assert.ok(RUN_CREW_FRAMES.length >= 3);
});

test("capacityIndex maps percent across six stages", () => {
	assert.equal(capacityIndex(null), 0);
	assert.equal(capacityIndex(0), 0);
	assert.equal(capacityIndex(17), 1);
	assert.equal(capacityIndex(50), 3);
	assert.equal(capacityIndex(99), 5);
	assert.equal(capacityIndex(150), 5);
});

test("isDangerStage flags only the last two stages", () => {
	assert.equal(isDangerStage(0, 6), false);
	assert.equal(isDangerStage(4, 6), true);
	assert.equal(isDangerStage(5, 6), true);
});

test("intervalForSpeed clamps to [min, max] and falls back when speed is null", () => {
	const speed = DEFAULT_CONFIG.speed;
	assert.equal(intervalForSpeed(speed, null), speed.defaultIntervalMs);
	assert.equal(intervalForSpeed(speed, 0), speed.defaultIntervalMs);
	assert.equal(intervalForSpeed(speed, 1_000_000), speed.minIntervalMs);
	assert.equal(intervalForSpeed(speed, 1), speed.maxIntervalMs);
});

test("TokenSpeedEngine suppresses unreliable readings below minReliableDuration", () => {
	const engine = new TokenSpeedEngine({
		slidingWindowMs: 1000,
		minReliableDurationMs: 1000,
		maxDisplayTokS: 500,
	});
	engine.start();
	engine.recordTokens(50);
	assert.equal(engine.tokS, 0);
	engine.stop();
});

test("TokenSpeedEngine nulls out absurd readings above maxDisplayTokS", () => {
	const engine = new TokenSpeedEngine({
		slidingWindowMs: 1000,
		minReliableDurationMs: 1,
		maxDisplayTokS: 500,
	});
	engine.start();
	for (let i = 0; i < 1000; i++) engine.recordTokens(10);
	const sanitized = engine.sanitizeTokS(10_000, 2000);
	assert.equal(sanitized, null);
	engine.stop();
});

test("SpeedTracker produces a valid tok/s for a successful completed message", async () => {
	const tracker = new SpeedTracker(DEFAULT_CONFIG.speed);
	tracker.startMessage();
	for (let i = 0; i < 200; i++) tracker.recordDelta("hello world token stream");
	await new Promise((resolve) => setTimeout(resolve, 1050));
	const completed = tracker.finishMessage(200, "stop");
	assert.ok(completed);
	assert.ok((completed?.tokS ?? 0) > 0);
	assert.ok(tracker.sessionAvgTokS() !== null);
});

test("SpeedTracker excludes error/aborted messages from the session average", () => {
	const tracker = new SpeedTracker(DEFAULT_CONFIG.speed);
	tracker.startMessage();
	for (let i = 0; i < 100; i++) tracker.recordDelta("token");
	tracker.finishMessage(100, "error");
	assert.equal(tracker.sessionAvgTokS(), null);
});

test("formatSpeed renders label and value", () => {
	assert.equal(formatSpeed(DEFAULT_CONFIG.speed, null), "-- tok/s");
	assert.match(formatSpeed(DEFAULT_CONFIG.speed, 12.345), /^12\.3 tok\/s$/);
});

test("formatCount scales compactly", () => {
	assert.equal(formatCount(999), "999");
	assert.equal(formatCount(1500), "1.5k");
	assert.equal(formatCount(25_000), "25k");
	assert.equal(formatCount(1_500_000), "1.5M");
});

test("renderSpeedFooter uses accent for live value and dim when unknown", () => {
	assert.match(renderSpeedFooter(theme, DEFAULT_CONFIG.speed, 42), /<accent>42\.0<\/accent> <dim>tok\/s<\/dim>/);
	assert.match(renderSpeedFooter(theme, DEFAULT_CONFIG.speed, null), /<dim>--<\/dim> <dim>tok\/s<\/dim>/);
});

test("renderWorkingMessage includes working prefix and speed", () => {
	const out = renderWorkingMessage(theme, DEFAULT_CONFIG.speed, 5);
	assert.match(out, /<muted>Working<\/muted>/);
	assert.match(out, /<accent>5\.0<\/accent>/);
});

test("renderCapacity colors the last two stages as error", () => {
	const usage = { tokens: 180_000, percent: 98 };
	const out = renderCapacity(theme, DEFAULT_CONFIG.capacity, usage);
	assert.match(out, /<error>.*<\/error>/);
});

test("renderCapacity keeps early stages as success", () => {
	const usage = { tokens: 5_000, percent: 10 };
	const out = renderCapacity(theme, DEFAULT_CONFIG.capacity, usage);
	assert.match(out, /<success>.*<\/success>/);
	assert.doesNotMatch(out, /<error>/);
});

test("getCapacityUsage tolerates a stub context", () => {
	const ctx = {
		getContextUsage: () => ({ tokens: 12_000, percent: 30, contextWindow: 200_000 }),
	} as unknown as Parameters<typeof getCapacityUsage>[0];
	const usage = getCapacityUsage(ctx);
	assert.equal(usage.tokens, 12_000);
	assert.equal(usage.percent, 30);
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
	assert.equal(DEFAULT_CONFIG.capacity.providerRefreshMs, 300000);
});

test("normalizeConfig fills providerUsage defaults from empty input", () => {
	const cfg = normalizeConfig({});
	assert.equal(cfg.capacity.providerUsage, true);
	assert.equal(cfg.capacity.providerRefreshMs, 300000);
});

test("normalizeConfig accepts custom providerUsage settings", () => {
	const cfg = normalizeConfig({ capacity: { providerUsage: false, providerRefreshMs: 60000 } });
	assert.equal(cfg.capacity.providerUsage, false);
	assert.equal(cfg.capacity.providerRefreshMs, 60000);
});

test("normalizeConfig clamps invalid providerRefreshMs to the default", () => {
	const negative = normalizeConfig({ capacity: { providerRefreshMs: -5 } });
	assert.equal(negative.capacity.providerRefreshMs, 300000);
	const nonNumeric = normalizeConfig({ capacity: { providerRefreshMs: "nope" } });
	assert.equal(nonNumeric.capacity.providerRefreshMs, 300000);
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

describe("provider-usage module", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedHome: string | undefined;
	let tempHome: string;

	beforeEach(() => {
		savedEnv = {};
		for (const key of PROVIDER_ENV_KEYS) savedEnv[key] = process.env[key];
		savedHome = process.env.HOME;
		tempHome = mkdtempSync(join(tmpdir(), "cv-provider-"));
		// Start every test from a credential-less, network-less blank slate.
		for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
		process.env.HOME = tempHome;
		clearProviderUsageCache();
	});

	afterEach(() => {
		for (const key of PROVIDER_ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		clearProviderUsageCache();
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("fetchProviderUsage returns null when no auth.json and no env token exist", async () => {
		// tempHome has no ~/.pi/agent/auth.json and no provider env vars are set.
		const usage = await fetchProviderUsage(0, "anthropic");
		assert.equal(usage, null);
	});

	test("fetchProviderUsage caches results within TTL (single network call)", async () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
		const { fn, counter } = anthropicOkMock();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fn;
		try {
			const first = await fetchProviderUsage(300000, "anthropic"); // default TTL = 5 min
			const second = await fetchProviderUsage(300000, "anthropic");
			assert.ok(first, "first call should return usage");
			assert.equal(counter.calls, 1, "fetch invoked exactly once across two cached calls");
			assert.equal(second, first, "cached result is the same object reference");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("clearProviderUsageCache forces a fresh fetch", async () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
		const { fn, counter } = anthropicOkMock();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fn;
		try {
			await fetchProviderUsage(300000, "anthropic");
			assert.equal(counter.calls, 1);
			clearProviderUsageCache();
			await fetchProviderUsage(300000, "anthropic");
			assert.equal(counter.calls, 2, "cache clear triggers a second fetch");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fetchProviderUsage parses Anthropic 5h + weekly usage", async () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = anthropicOkMock().fn;
		try {
			const usage = await fetchProviderUsage(0, "anthropic"); // TTL=0 forces fetch
			assert.ok(usage, "expected parsed usage");
			assert.equal(usage!.fiveHourPercent, 45.5);
			assert.equal(usage!.weeklyPercent, 23);
			assert.equal(usage!.fiveHourResetAt, "2026-07-08T16:00:00Z");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fetchProviderUsage returns null on non-OK HTTP response", async () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = makeFetchMock(() => new Response("Forbidden", { status: 403 })).fn;
		try {
			assert.equal(await fetchProviderUsage(0, "anthropic"), null);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fetchProviderUsage returns null when fetch throws (network failure)", async () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "test-token";
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		try {
			assert.equal(await fetchProviderUsage(0, "anthropic"), null);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
