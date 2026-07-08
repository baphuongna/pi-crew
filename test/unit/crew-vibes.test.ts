import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../../src/extension/crew-vibes/config.ts";
import { capacityIndex, intervalForSpeed, isDangerStage, RUN_CREW_FRAMES } from "../../src/extension/crew-vibes/figures.ts";
import {
	asCrewTheme,
	formatCount,
	formatSpeed,
	getCapacityUsage,
	renderCapacity,
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
	assert.ok(widths.every((width) => width === widths[0]), `frames have unequal widths: ${widths.join(",")}`);
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
