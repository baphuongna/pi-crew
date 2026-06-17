import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { powerlineWidgetHeader } from "../../src/ui/widget/widget-renderer.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";
import type { CrewAgentRecord } from "../../src/runtime/crew-agent-runtime.ts";

/**
 * Powerline widget header wiring (opt-in config.ui.headerStyle="powerline").
 * Verifies the foundation modules (status-layout tiered collapse + powerline
 * renderSegmentChain) are WIRED into a real visible consumer, producing a
 * degraded-on-narrow powerline status line — not dead foundation code.
 */

// Minimal CrewTheme WITH bg support (the powerline path requires it).
function bgTheme(): CrewTheme {
	return {
		fg: (color: string, text: string) => `\x1b[fg=${color}]${text}`,
		bg: (color: string, text: string) => `\x1b[bg=${color}]${text}`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as unknown as CrewTheme;
}

// CrewTheme WITHOUT bg → powerline must signal fallback (return "").
function fgOnlyTheme(): CrewTheme {
	return {
		fg: (color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as CrewTheme;
}

function agent(status: CrewAgentRecord["status"]): CrewAgentRecord {
	return { status } as CrewAgentRecord;
}

function makeRuns(agents: CrewAgentRecord[]): Array<{ agents: CrewAgentRecord[] }> {
	return [{ agents }];
}

describe("powerlineWidgetHeader — wired foundation", () => {
	it("renders a filled-bg powerline chain when theme has bg support", () => {
		const runs = makeRuns([agent("running"), agent("running"), agent("completed")]);
		const out = powerlineWidgetHeader(runs as never, "⚙", 0, bgTheme(), 200);
		assert.ok(out.length > 0, "produces output");
		assert.ok(out.includes("bg="), "contains bg fill sequences");
		assert.ok(out.includes("Crew"), "lead segment present");
		assert.ok(out.includes("2 running"), "running count segment");
		assert.ok(out.includes("1/3 done"), "progress segment");
	});

	it("returns \"\" (signal fallback) when theme lacks bg support", () => {
		const runs = makeRuns([agent("running")]);
		const out = powerlineWidgetHeader(runs as never, "⚙", 0, fgOnlyTheme(), 200);
		assert.equal(out, "", "no powerline on bg-less theme → caller falls back to default header");
	});

	it("shows a queued segment (pending bg) when agents are queued", () => {
		const runs = makeRuns([agent("running"), agent("queued")]);
		const out = powerlineWidgetHeader(runs as never, "⚙", 0, bgTheme(), 200);
		assert.ok(out.includes("1 queued"), "queued count present");
		assert.ok(out.includes("bg=toolPendingBg"), "queued uses pending bg slot");
	});

	it("uses success bg when all agents are completed", () => {
		const runs = makeRuns([agent("completed"), agent("completed")]);
		const out = powerlineWidgetHeader(runs as never, "⚙", 0, bgTheme(), 200);
		assert.ok(out.includes("2/2 done"));
		assert.ok(out.includes("bg=toolSuccessBg"), "all-complete → success bg");
	});

	it("degrades on narrow width: lower-order segments survive, higher-order drop", () => {
		const runs = makeRuns([agent("running"), agent("queued"), agent("completed")]);
		const wide = powerlineWidgetHeader(runs as never, "⚙", 0, bgTheme(), 200);
		const narrow = powerlineWidgetHeader(runs as never, "⚙", 0, bgTheme(), 12);
		// Wide shows everything.
		assert.ok(wide.includes("/team-dashboard"), "wide: dashboard segment visible");
		// Narrow drops the highest-collapse-order segment (/team-dashboard, order 4).
		// Lead (order 0) + progress (order 1) survive.
		assert.ok(narrow.includes("Crew"), "narrow: lead segment survives");
		assert.ok(!narrow.includes("/team-dashboard"), "narrow: dashboard segment hidden (highest order)");
		assert.ok(wide.length > narrow.length, "narrow output is shorter than wide");
	});

	it("includes the notification badge in the lead segment", () => {
		const runs = makeRuns([agent("running")]);
		const out = powerlineWidgetHeader(runs as never, "⚙", 3, bgTheme(), 200);
		// notificationBadge(3) renders something non-empty; just verify it's in lead.
		assert.ok(out.includes("Crew"));
	});
});
