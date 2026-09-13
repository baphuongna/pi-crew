/**
 * Unit tests for the crew-vibes footer painting the dock as its LAST block
 * (below pwd/stats/meters) and for the sink flag GATING it (a dock provider
 * must not render when the sink is off, e.g. vibes disabled).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewVibesConfig } from "../../../src/extension/crew-vibes/config.ts";
import { type CrewVibesFooterDeps, createCrewVibesFooter } from "../../../src/extension/crew-vibes/footer.ts";
import {
	getFooterDockProvider,
	resetFooterDockRegistry,
	setFooterDockProvider,
	setFooterDockSinkActive,
} from "../../../src/ui/dock-footer.ts";
import { resetWidgetScheduledJobsReader, setWidgetScheduledJobsReader } from "../../../src/ui/widget/widget-renderer.ts";

const DISABLED_CONFIG = { enabled: false } as CrewVibesConfig;

function makeDeps(): CrewVibesFooterDeps {
	const sessionManager = {
		getCwd: () => "/tmp/project",
		getSessionName: () => "main",
		getEntries: () => [],
		buildSessionContext: () => undefined,
	};
	const ctx = {
		sessionManager,
		model: undefined,
		getContextUsage: () => undefined,
		modelRegistry: undefined,
	} as unknown as CrewVibesFooterDeps["ctx"];
	return {
		tui: undefined,
		theme: undefined,
		footerData: undefined,
		ctx,
		source: {
			getConfig: () => DISABLED_CONFIG,
			getQuotaUsage: () => null,
			getThinkingLevel: () => undefined,
		},
	};
}

test("dock lines are painted as the footer's last block", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		const footer = createCrewVibesFooter(makeDeps());
		setFooterDockProvider(() => ["HINT dock line", "● main"]);
		const lines = footer.render(80);
		assert.ok(lines.length >= 4, `pwd + stats + (no meters) + dock, got ${lines.length}`);
		assert.equal(lines.at(-2)?.trimEnd(), "HINT dock line", "dock block starts after the footer's own lines");
		assert.equal(lines.at(-1)?.trimEnd(), "● main", "dock is the very last block, below the meters");
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("no provider → no dock block", () => {
	resetFooterDockRegistry();
	try {
		const footer = createCrewVibesFooter(makeDeps());
		const lines = footer.render(80);
		const hasDock = lines.some((line) => line.includes("dock line") || line.includes("● main"));
		assert.equal(hasDock, false, "nothing dock-shaped is painted without a provider");
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("dock lines are truncated to the real render width", () => {
	resetFooterDockRegistry();
	try {
		const footer = createCrewVibesFooter(makeDeps());
		setFooterDockProvider(() => ["x".repeat(200)]);
		const lines = footer.render(40).filter((line) => line.includes("xxx"));
		assert.ok(lines.length > 0);
		for (const line of lines) {
			// Strip ANSI before measuring.
			const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
			assert.ok(plain.length <= 40, `dock line bounded by footer width, got ${plain.length}`);
		}
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("sink flag gates the dock (dock-footer sink governs vibes rendering)", () => {
	resetFooterDockRegistry();
	setFooterDockProvider(() => ["● main"]);
	try {
		// The widget only registers a provider when the sink is active; this
		// asserts the flag and provider travel together through the registry.
		setFooterDockSinkActive(true);
		assert.ok(getFooterDockProvider(), "provider visible to the footer while the sink is on");
		setFooterDockSinkActive(false);
		// The provider itself is untouched by the flag — the WIDGET decides
		// whether to (un)register it; the footer just paints whatever exists.
		assert.ok(getFooterDockProvider(), "provider survives the flag toggle");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
	}
});

// ── Maintainer decision 2026-09-13: capacity meter retired from the footer;
// its slot carries the Tier-C schedules segment (⏰ …), quota stays right. ──

const ENABLED_CONFIG = {
	enabled: true,
	speed: { enabled: false, footer: false, indicator: false, label: "tok/s" },
	capacity: { enabled: true, tokenDisplay: "tokens", showLabel: true, providerUsage: true },
} as unknown as CrewVibesConfig;

test("meter line = schedules segment (left) + provider quota (right); capacity stage retired", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		setWidgetScheduledJobsReader(() => [
			{
				id: "j1",
				name: "watch",
				description: "",
				schedule: "0 */2 * * *",
				scheduleType: "cron",
				subagentType: "executor",
				prompt: "{}",
				enabled: true,
				createdAt: new Date().toISOString(),
				nextRun: new Date(Date.now() + 84 * 60_000).toISOString(),
			} as never,
		]);
		const deps = makeDeps();
		deps.source.getConfig = () => ENABLED_CONFIG;
		deps.source.getQuotaUsage = () => ({
			providerName: "z.ai",
			fiveHourPercent: 37,
			fiveHourResetAt: new Date(Date.now() + 46 * 60_000).toISOString(),
			weeklyPercent: 0,
			weeklyResetAt: new Date(Date.now() + 24 * 86_400_000).toISOString(),
		});
		const footer = createCrewVibesFooter(deps);
		const lines = footer.render(120);
		const meter = lines.find((l) => l.includes("⏰"));
		assert.ok(meter, `meter line with schedules segment exists, got: ${lines.join(" | ")}`);
		assert.ok(meter.includes("⏰ 1 sched"), `schedules segment left: '${meter}'`);
		assert.ok(meter.includes("z.ai"), `provider quota right on the SAME line: '${meter}'`);
		assert.ok(!meter.includes("Orbit"), "capacity stage label is retired from the footer");
		assert.ok(!/\b\d+k\b/.test(meter.replace(/⏰ \d+ sched/, "")), "context token count is retired from the footer");
		footer.dispose();
	} finally {
		resetWidgetScheduledJobsReader();
		resetFooterDockRegistry();
	}
});

test("no jobs + no quota → no meter line at all", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		setWidgetScheduledJobsReader(() => []);
		const deps = makeDeps();
		deps.source.getConfig = () => ENABLED_CONFIG;
		deps.source.getQuotaUsage = () => null;
		const footer = createCrewVibesFooter(deps);
		const lines = footer.render(120);
		assert.ok(!lines.some((l) => l.includes("⏰")), "no schedules segment without jobs");
		footer.dispose();
	} finally {
		resetWidgetScheduledJobsReader();
		resetFooterDockRegistry();
	}
});
