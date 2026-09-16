/**
 * L2 — keybinding-map parity test.
 *
 * Captures the EXACT output of the pre-L2 imperative `if`-chain dispatch for
 * every (data, activePane) pair and asserts the post-L2 data-driven loop
 * produces identical results. The golden snapshot below was generated from
 * the old implementation BEFORE the refactor; if the refactor is correct,
 * every entry must match.
 *
 * Snapshot generation (run against old code to regenerate):
 *   node --input-type=module -e "
 *     import {dashboardActionForKey,DASHBOARD_KEYS} from './src/ui/keybinding-map.ts';
 *     const panes=[undefined,'agents','progress','mailbox','output','health','metrics','plan','schedules'];
 *     const allKeys=new Set([...DASHBOARD_KEYS.close,...DASHBOARD_KEYS.select,...DASHBOARD_KEYS.help,
 *       ...Object.values(DASHBOARD_KEYS.root).flat(),...Object.values(DASHBOARD_KEYS.pane).flat(),
 *       ...Object.values(DASHBOARD_KEYS.navigation).flat(),...Object.values(DASHBOARD_KEYS.mailbox).flat(),
 *       ...Object.values(DASHBOARD_KEYS.health).flat(),...Object.values(DASHBOARD_KEYS.plan).flat(),
 *       ...Object.values(DASHBOARD_KEYS.schedules).flat(),
 *       ...Object.values(DASHBOARD_KEYS.notification).flat()]);
 *     const g={};for(const p of panes)for(const k of [...allKeys].sort())
 *       g[String(p)+'|'+JSON.stringify(k)]=dashboardActionForKey(k,p)??null;
 *     console.log(JSON.stringify(g));"
 *
 * Tier A regeneration note: the golden was regenerated when the schedules
 * pane (key 8) and its pane-scoped T/N/V/X/R actions were added. Every
 * pre-existing entry was verified byte-identical before replacement; the
 * two legacy app-cursor variants (\u001bOA/OB) are preserved even though the
 * generator cannot produce them (matchesKey pass-2 normalization).
 *
 * Format: "<pane>|<JSON.stringify(key)>" → action | null (null means undefined).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type ActivePane,
	DASHBOARD_KEYS,
	type DashboardKeyAction,
	dashboardActionForKey,
	KEY_RESERVED,
} from "../../../src/ui/keybinding-map.ts";

// Golden snapshot from the pre-L2 implementation. DO NOT edit by hand —
// regenerate with the snippet above if the dispatch contract intentionally
// changes, and document WHY in the commit message.
const GOLDEN: Record<string, string | null> = {
	// Regenerated (M1-7 / P1-5): removed the phantom `p` → "progressToggle"
	// row. `progressToggle` was deleted from `DASHBOARD_KEYS.root`, the
	// `DashboardKeyAction` union and `DEFAULT_BINDINGS` because the flag it
	// toggled (`showFullProgress`) was never read to change rendered output.
	// Every remaining entry was verified byte-identical (only the 9 `|'p'`
	// rows were dropped — one per pane); the two legacy app-cursor variants
	// (\u001bOA/OB) are preserved. `p` is now unbound in every pane, asserted
	// by the dedicated M1-7 test below. Prior regeneration note:
	// Regenerated (feat/agents-browser): added root key 'b' → "browser" for
	// every pane; all pre-existing entries byte-identical (verified by diff
	// before replacement). Prior regeneration note:
	// Regenerated (tier A — schedules pane): added pane 'schedules', key '8',
	// the schedules group T/N/V/X/R, and the help group to the checked set.
	// All pre-existing entries are byte-identical (verified by diff before
	// replacement); the two legacy app-cursor variants (\u001bOA/OB) are kept.
	'agents|" "': "select",
	'agents|"1"': "pane-agents",
	'agents|"2"': "pane-progress",
	'agents|"3"': "pane-mailbox",
	'agents|"4"': "pane-output",
	'agents|"5"': "pane-health",
	'agents|"6"': "pane-metrics",
	'agents|"7"': "pane-plan",
	'agents|"8"': "pane-schedules",
	'agents|"?"': "help",
	'agents|"A"': null,
	'agents|"C"': null,
	'agents|"D"': null,
	'agents|"H"': "notifications-dismiss",
	'agents|"K"': null,
	'agents|"N"': null,
	'agents|"P"': null,
	'agents|"R"': null,
	'agents|"T"': null,
	'agents|"V"': "live-conversation",
	'agents|"X"': null,
	'agents|"\\n"': "select",
	'agents|"\\r"': "select",
	'agents|"\\t"': "select",
	'agents|"\\u001b"': "close",
	'agents|"a"': "artifacts",
	'agents|"b"': "browser",
	'agents|"d"': "agents",
	'agents|"down"': "down",
	'agents|"e"': "events",
	'agents|"enter"': "select",
	'agents|"escape"': "close",
	'agents|"i"': "api",
	'agents|"j"': "down",
	'agents|"k"': "up",
	'agents|"m"': "mailbox",
	'agents|"n"': null,
	'agents|"o"': "output",
	'agents|"q"': "close",
	'agents|"r"': "reload",
	'agents|"s"': "select",
	'agents|"tab"': "select",
	'agents|"u"': "summary",
	'agents|"up"': "up",
	'agents|"v"': "transcript",
	'health|" "': "select",
	'health|"1"': "pane-agents",
	'health|"2"': "pane-progress",
	'health|"3"': "pane-mailbox",
	'health|"4"': "pane-output",
	'health|"5"': "pane-health",
	'health|"6"': "pane-metrics",
	'health|"7"': "pane-plan",
	'health|"8"': "pane-schedules",
	'health|"?"': "help",
	'health|"A"': null,
	'health|"C"': null,
	'health|"D"': "health-diagnostic-export",
	'health|"H"': "notifications-dismiss",
	'health|"K"': "health-kill-stale",
	'health|"N"': null,
	'health|"P"': null,
	'health|"R"': "health-recovery",
	'health|"T"': null,
	'health|"V"': "live-conversation",
	'health|"X"': null,
	'health|"\\n"': "select",
	'health|"\\r"': "select",
	'health|"\\t"': "select",
	'health|"\\u001b"': "close",
	'health|"a"': "artifacts",
	'health|"b"': "browser",
	'health|"d"': "agents",
	'health|"down"': "down",
	'health|"e"': "events",
	'health|"enter"': "select",
	'health|"escape"': "close",
	'health|"i"': "api",
	'health|"j"': "down",
	'health|"k"': "up",
	'health|"m"': "mailbox",
	'health|"n"': null,
	'health|"o"': "output",
	'health|"q"': "close",
	'health|"r"': "reload",
	'health|"s"': "select",
	'health|"tab"': "select",
	'health|"u"': "summary",
	'health|"up"': "up",
	'health|"v"': "transcript",
	'mailbox|" "': "select",
	'mailbox|"1"': "pane-agents",
	'mailbox|"2"': "pane-progress",
	'mailbox|"3"': "pane-mailbox",
	'mailbox|"4"': "pane-output",
	'mailbox|"5"': "pane-health",
	'mailbox|"6"': "pane-metrics",
	'mailbox|"7"': "pane-plan",
	'mailbox|"8"': "pane-schedules",
	'mailbox|"?"': "help",
	'mailbox|"A"': null,
	'mailbox|"C"': null,
	'mailbox|"D"': null,
	'mailbox|"H"': "notifications-dismiss",
	'mailbox|"K"': null,
	'mailbox|"N"': null,
	'mailbox|"P"': null,
	'mailbox|"R"': null,
	'mailbox|"T"': null,
	'mailbox|"V"': "live-conversation",
	'mailbox|"X"': null,
	'mailbox|"\\n"': "mailbox-detail",
	'mailbox|"\\r"': "mailbox-detail",
	'mailbox|"\\t"': "select",
	'mailbox|"\\u001b"': "close",
	'mailbox|"a"': "artifacts",
	'mailbox|"b"': "browser",
	'mailbox|"d"': "agents",
	'mailbox|"down"': "down",
	'mailbox|"e"': "events",
	'mailbox|"enter"': "select",
	'mailbox|"escape"': "close",
	'mailbox|"i"': "api",
	'mailbox|"j"': "down",
	'mailbox|"k"': "up",
	'mailbox|"m"': "mailbox",
	'mailbox|"n"': null,
	'mailbox|"o"': "output",
	'mailbox|"q"': "close",
	'mailbox|"r"': "reload",
	'mailbox|"s"': "select",
	'mailbox|"tab"': "select",
	'mailbox|"u"': "summary",
	'mailbox|"up"': "up",
	'mailbox|"v"': "transcript",
	'metrics|" "': "select",
	'metrics|"1"': "pane-agents",
	'metrics|"2"': "pane-progress",
	'metrics|"3"': "pane-mailbox",
	'metrics|"4"': "pane-output",
	'metrics|"5"': "pane-health",
	'metrics|"6"': "pane-metrics",
	'metrics|"7"': "pane-plan",
	'metrics|"8"': "pane-schedules",
	'metrics|"?"': "help",
	'metrics|"A"': null,
	'metrics|"C"': null,
	'metrics|"D"': null,
	'metrics|"H"': "notifications-dismiss",
	'metrics|"K"': null,
	'metrics|"N"': null,
	'metrics|"P"': null,
	'metrics|"R"': null,
	'metrics|"T"': null,
	'metrics|"V"': "live-conversation",
	'metrics|"X"': null,
	'metrics|"\\n"': "select",
	'metrics|"\\r"': "select",
	'metrics|"\\t"': "select",
	'metrics|"\\u001b"': "close",
	'metrics|"a"': "artifacts",
	'metrics|"b"': "browser",
	'metrics|"d"': "agents",
	'metrics|"down"': "down",
	'metrics|"e"': "events",
	'metrics|"enter"': "select",
	'metrics|"escape"': "close",
	'metrics|"i"': "api",
	'metrics|"j"': "down",
	'metrics|"k"': "up",
	'metrics|"m"': "mailbox",
	'metrics|"n"': null,
	'metrics|"o"': "output",
	'metrics|"q"': "close",
	'metrics|"r"': "reload",
	'metrics|"s"': "select",
	'metrics|"tab"': "select",
	'metrics|"u"': "summary",
	'metrics|"up"': "up",
	'metrics|"v"': "transcript",
	'output|" "': "select",
	'output|"1"': "pane-agents",
	'output|"2"': "pane-progress",
	'output|"3"': "pane-mailbox",
	'output|"4"': "pane-output",
	'output|"5"': "pane-health",
	'output|"6"': "pane-metrics",
	'output|"7"': "pane-plan",
	'output|"8"': "pane-schedules",
	'output|"?"': "help",
	'output|"A"': null,
	'output|"C"': null,
	'output|"D"': null,
	'output|"H"': "notifications-dismiss",
	'output|"K"': null,
	'output|"N"': null,
	'output|"P"': null,
	'output|"R"': null,
	'output|"T"': null,
	'output|"V"': "live-conversation",
	'output|"X"': null,
	'output|"\\n"': "select",
	'output|"\\r"': "select",
	'output|"\\t"': "select",
	'output|"\\u001b"': "close",
	'output|"a"': "artifacts",
	'output|"b"': "browser",
	'output|"d"': "agents",
	'output|"down"': "down",
	'output|"e"': "events",
	'output|"enter"': "select",
	'output|"escape"': "close",
	'output|"i"': "api",
	'output|"j"': "down",
	'output|"k"': "up",
	'output|"m"': "mailbox",
	'output|"n"': null,
	'output|"o"': "output",
	'output|"q"': "close",
	'output|"r"': "reload",
	'output|"s"': "select",
	'output|"tab"': "select",
	'output|"u"': "summary",
	'output|"up"': "up",
	'output|"v"': "transcript",
	'plan|" "': "select",
	'plan|"1"': "pane-agents",
	'plan|"2"': "pane-progress",
	'plan|"3"': "pane-mailbox",
	'plan|"4"': "pane-output",
	'plan|"5"': "pane-health",
	'plan|"6"': "pane-metrics",
	'plan|"7"': "pane-plan",
	'plan|"8"': "pane-schedules",
	'plan|"?"': "help",
	'plan|"A"': "plan-approve",
	'plan|"C"': null,
	'plan|"D"': null,
	'plan|"H"': "notifications-dismiss",
	'plan|"K"': null,
	'plan|"N"': null,
	'plan|"P"': null,
	'plan|"R"': null,
	'plan|"T"': null,
	'plan|"V"': "live-conversation",
	'plan|"X"': "plan-diff",
	'plan|"\\n"': "select",
	'plan|"\\r"': "select",
	'plan|"\\t"': "select",
	'plan|"\\u001b"': "close",
	'plan|"a"': "artifacts",
	'plan|"b"': "browser",
	'plan|"d"': "agents",
	'plan|"down"': "down",
	'plan|"e"': "events",
	'plan|"enter"': "select",
	'plan|"escape"': "close",
	'plan|"i"': "api",
	'plan|"j"': "down",
	'plan|"k"': "up",
	'plan|"m"': "mailbox",
	'plan|"n"': "plan-deny",
	'plan|"o"': "output",
	'plan|"q"': "close",
	'plan|"r"': "reload",
	'plan|"s"': "select",
	'plan|"tab"': "select",
	'plan|"u"': "summary",
	'plan|"up"': "up",
	'plan|"v"': "transcript",
	'progress|" "': "select",
	'progress|"1"': "pane-agents",
	'progress|"2"': "pane-progress",
	'progress|"3"': "pane-mailbox",
	'progress|"4"': "pane-output",
	'progress|"5"': "pane-health",
	'progress|"6"': "pane-metrics",
	'progress|"7"': "pane-plan",
	'progress|"8"': "pane-schedules",
	'progress|"?"': "help",
	'progress|"A"': "plan-approve",
	'progress|"C"': null,
	'progress|"D"': null,
	'progress|"H"': "notifications-dismiss",
	'progress|"K"': null,
	'progress|"N"': null,
	'progress|"P"': null,
	'progress|"R"': null,
	'progress|"T"': null,
	'progress|"V"': "live-conversation",
	'progress|"X"': null,
	'progress|"\\n"': "select",
	'progress|"\\r"': "select",
	'progress|"\\t"': "select",
	'progress|"\\u001b"': "close",
	'progress|"a"': "artifacts",
	'progress|"b"': "browser",
	'progress|"d"': "agents",
	'progress|"down"': "down",
	'progress|"e"': "events",
	'progress|"enter"': "select",
	'progress|"escape"': "close",
	'progress|"i"': "api",
	'progress|"j"': "down",
	'progress|"k"': "up",
	'progress|"m"': "mailbox",
	'progress|"n"': "plan-deny",
	'progress|"o"': "output",
	'progress|"q"': "close",
	'progress|"r"': "reload",
	'progress|"s"': "select",
	'progress|"tab"': "select",
	'progress|"u"': "summary",
	'progress|"up"': "up",
	'progress|"v"': "transcript",
	'schedules|" "': "select",
	'schedules|"1"': "pane-agents",
	'schedules|"2"': "pane-progress",
	'schedules|"3"': "pane-mailbox",
	'schedules|"4"': "pane-output",
	'schedules|"5"': "pane-health",
	'schedules|"6"': "pane-metrics",
	'schedules|"7"': "pane-plan",
	'schedules|"8"': "pane-schedules",
	'schedules|"?"': "help",
	'schedules|"A"': null,
	'schedules|"C"': null,
	'schedules|"D"': null,
	'schedules|"H"': "notifications-dismiss",
	'schedules|"K"': null,
	'schedules|"N"': "schedule-run-now",
	'schedules|"P"': null,
	'schedules|"R"': "schedule-refresh",
	'schedules|"T"': "schedule-toggle",
	'schedules|"V"': "schedule-details",
	'schedules|"X"': "schedule-delete",
	'schedules|"\\n"': "select",
	'schedules|"\\r"': "select",
	'schedules|"\\t"': "select",
	'schedules|"\\u001b"': "close",
	'schedules|"a"': "artifacts",
	'schedules|"b"': "browser",
	'schedules|"d"': "agents",
	'schedules|"down"': "down",
	'schedules|"e"': "events",
	'schedules|"enter"': "select",
	'schedules|"escape"': "close",
	'schedules|"i"': "api",
	'schedules|"j"': "down",
	'schedules|"k"': "up",
	'schedules|"m"': "mailbox",
	'schedules|"n"': "schedule-run-now",
	'schedules|"o"': "output",
	'schedules|"q"': "close",
	'schedules|"r"': "reload",
	'schedules|"s"': "select",
	'schedules|"tab"': "select",
	'schedules|"u"': "summary",
	'schedules|"up"': "up",
	'schedules|"v"': "transcript",
	'undefined|" "': "select",
	'undefined|"1"': "pane-agents",
	'undefined|"2"': "pane-progress",
	'undefined|"3"': "pane-mailbox",
	'undefined|"4"': "pane-output",
	'undefined|"5"': "pane-health",
	'undefined|"6"': "pane-metrics",
	'undefined|"7"': "pane-plan",
	'undefined|"8"': "pane-schedules",
	'undefined|"?"': "help",
	'undefined|"A"': null,
	'undefined|"C"': null,
	'undefined|"D"': null,
	'undefined|"H"': "notifications-dismiss",
	'undefined|"K"': null,
	'undefined|"N"': null,
	'undefined|"P"': null,
	'undefined|"R"': null,
	'undefined|"T"': null,
	'undefined|"V"': "live-conversation",
	'undefined|"X"': null,
	'undefined|"\\n"': "select",
	'undefined|"\\r"': "select",
	'undefined|"\\t"': "select",
	'undefined|"\\u001b"': "close",
	'undefined|"\\u001bOA"': "up",
	'undefined|"\\u001bOB"': "down",
	'undefined|"a"': "artifacts",
	'undefined|"b"': "browser",
	'undefined|"d"': "agents",
	'undefined|"down"': "down",
	'undefined|"e"': "events",
	'undefined|"enter"': "select",
	'undefined|"escape"': "close",
	'undefined|"i"': "api",
	'undefined|"j"': "down",
	'undefined|"k"': "up",
	'undefined|"m"': "mailbox",
	'undefined|"n"': null,
	'undefined|"o"': "output",
	'undefined|"q"': "close",
	'undefined|"r"': "reload",
	'undefined|"s"': "select",
	'undefined|"tab"': "select",
	'undefined|"u"': "summary",
	'undefined|"up"': "up",
	'undefined|"v"': "transcript",
};

describe("dashboardActionForKey — L2 parity with pre-refactor behavior", () => {
	it("returns identical action for every (data, activePane) pair in the golden snapshot", () => {
		const panes: (ActivePane | undefined)[] = [
			undefined,
			"agents",
			"progress",
			"mailbox",
			"output",
			"health",
			"metrics",
			"plan",
			"schedules",
		];
		const allKeys = new Set<string>([
			...DASHBOARD_KEYS.close,
			...DASHBOARD_KEYS.select,
			...DASHBOARD_KEYS.help,
			...Object.values(DASHBOARD_KEYS.root).flat(),
			...Object.values(DASHBOARD_KEYS.pane).flat(),
			...Object.values(DASHBOARD_KEYS.navigation).flat(),
			...Object.values(DASHBOARD_KEYS.mailbox).flat(),
			...Object.values(DASHBOARD_KEYS.health).flat(),
			...Object.values(DASHBOARD_KEYS.plan).flat(),
			...Object.values(DASHBOARD_KEYS.schedules).flat(),
			...Object.values(DASHBOARD_KEYS.notification).flat(),
		]);
		let checked = 0;
		for (const pane of panes) {
			for (const key of allKeys) {
				const snapshotKey = `${String(pane)}|${JSON.stringify(key)}`;
				const expected = GOLDEN[snapshotKey];
				const actual = dashboardActionForKey(key, pane);
				// Golden uses null for undefined; normalize.
				const normalizedActual = actual === undefined ? null : actual;
				assert.equal(
					normalizedActual,
					expected,
					`parity broken for pane=${String(pane)} key=${JSON.stringify(key)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalizedActual)}`,
				);
				checked++;
			}
		}
		// Sanity: we actually exercised the snapshot.
		assert.ok(checked > 150, `expected to check >150 pairs, checked ${checked}`);
	});
});

describe("dashboardActionForKey — precedence and pane-scoping", () => {
	it("mailbox-detail wins over select for Enter in the mailbox pane", () => {
		// \r and \n are in BOTH mailbox.openDetail and select. In mailbox pane
		// the pane-scoped binding must win.
		assert.equal(dashboardActionForKey("\r", "mailbox"), "mailbox-detail");
		assert.equal(dashboardActionForKey("\n", "mailbox"), "mailbox-detail");
		// Outside mailbox pane, Enter → select.
		assert.equal(dashboardActionForKey("\r", "agents"), "select");
		assert.equal(dashboardActionForKey("\r", undefined), "select");
	});

	it("'s' still selects in mailbox pane (not shadowed by mailbox-detail)", () => {
		// 's' is only in select, not in mailbox.openDetail, so it must still
		// resolve to select even inside the mailbox pane.
		assert.equal(dashboardActionForKey("s", "mailbox"), "select");
	});

	it("health-* bindings only fire in the health pane", () => {
		assert.equal(dashboardActionForKey("R", "health"), "health-recovery");
		assert.equal(dashboardActionForKey("R", undefined), undefined);
		assert.equal(dashboardActionForKey("R", "agents"), undefined);
		assert.equal(dashboardActionForKey("K", "health"), "health-kill-stale");
		assert.equal(dashboardActionForKey("D", "health"), "health-diagnostic-export");
	});

	it("plan-* bindings only fire in the progress pane (WP-3 H4)", () => {
		// "A" is plan-approve ONLY while the progress pane owns input.
		assert.equal(dashboardActionForKey("A", "progress"), "plan-approve");
		// Unscoped (no pane) it stays unclaimed at dashboard dispatch level.
		assert.equal(dashboardActionForKey("A", undefined), undefined);
		// In the mailbox pane "A" remains mailbox-overlay territory (ack) —
		// the pane-scoped plan binding must NOT claim it there.
		assert.equal(dashboardActionForKey("A", "mailbox"), undefined);
		// Lowercase "n" is plan-deny in the progress pane, unbound elsewhere
		// (and never confused with the "\n" select key — case-sensitive pass 1).
		assert.equal(dashboardActionForKey("n", "progress"), "plan-deny");
		assert.equal(dashboardActionForKey("n", "agents"), undefined);
		assert.equal(dashboardActionForKey("n", undefined), undefined);
	});

	it("returns undefined for unbound keys", () => {
		assert.equal(dashboardActionForKey("z", undefined), undefined);
		assert.equal(dashboardActionForKey("z", "mailbox"), undefined);
		assert.equal(dashboardActionForKey("", undefined), undefined);
	});
});

describe("M1-7 — phantom progressToggle binding removed (P1-5)", () => {
	const panes: (ActivePane | undefined)[] = [
		undefined,
		"agents",
		"progress",
		"mailbox",
		"output",
		"health",
		"metrics",
		"plan",
		"schedules",
	];

	// Compile-time proof: "progressToggle" is no longer a member of the
	// DashboardKeyAction union. If someone re-adds it, this annotation stops
	// type-checking (G1) — the test cannot silently pass.
	type ProgressToggleGone = "progressToggle" extends DashboardKeyAction ? false : true;
	const progressToggleGone: ProgressToggleGone = true;

	it("no longer declares progressToggle in DASHBOARD_KEYS.root", () => {
		assert.ok(!("progressToggle" in DASHBOARD_KEYS.root), "DASHBOARD_KEYS.root still declares progressToggle");
		assert.ok(
			!(Object.values(DASHBOARD_KEYS.root).flat() as readonly string[]).includes("p"),
			"key 'p' is still claimed by a root binding",
		);
	});

	it("no longer exposes progressToggle in the DashboardKeyAction union", () => {
		assert.equal(progressToggleGone, true);
	});

	it("'p' now resolves to undefined in every pane (was progressToggle)", () => {
		for (const pane of panes) {
			assert.equal(dashboardActionForKey("p", pane), undefined, `pane=${String(pane)}`);
		}
	});

	it("'p' is no longer a reserved key", () => {
		assert.ok(!KEY_RESERVED.has("p"), "KEY_RESERVED still reserves 'p'");
	});

	it("every OTHER golden key keeps its action (spot-check the 'p' neighbours)", () => {
		// The neighbours of the removed 'p' row in the golden table: 'o'→output
		// and 'q'→close must be untouched in every pane.
		for (const pane of panes) {
			assert.equal(dashboardActionForKey("o", pane), "output", `o in pane=${String(pane)}`);
			assert.equal(dashboardActionForKey("q", pane), "close", `q in pane=${String(pane)}`);
		}
	});
});

describe("KEY_RESERVED — derived key set", () => {
	it("contains all dispatched keys plus overlay-handled mailbox/health keys", () => {
		// Dispatched keys:
		assert.ok(KEY_RESERVED.has("q"));
		assert.ok(KEY_RESERVED.has("\u001b"));
		assert.ok(KEY_RESERVED.has("a"));
		assert.ok(KEY_RESERVED.has("1"));
		// Overlay-handled (NOT dispatched by dashboardActionForKey but reserved):
		assert.ok(KEY_RESERVED.has("A"), "mailbox ack key must be reserved");
		assert.ok(KEY_RESERVED.has("C"), "mailbox compose key must be reserved");
		assert.ok(KEY_RESERVED.has("N"), "mailbox nudge key must be reserved");
		assert.ok(KEY_RESERVED.has("P"), "mailbox preview key must be reserved");
		assert.ok(KEY_RESERVED.has("X"), "mailbox ackAll key must be reserved");
		// Plan-approval keys (WP-3 H4) — dispatched, progress-scoped:
		assert.ok(KEY_RESERVED.has("n"), "plan deny key must be reserved");
	});

	it("does NOT contain unbound keys", () => {
		assert.ok(!KEY_RESERVED.has("z"));
		assert.ok(!KEY_RESERVED.has("f"));
	});

	it("contains the agents-jobs browser root key (feat/agents-browser)", () => {
		// Root binding `b` → action "browser" — reserved AND dispatched in
		// every pane (unscoped root action, collision-free).
		assert.ok(KEY_RESERVED.has("b"), "browser key must be reserved");
		const panes: (ActivePane | undefined)[] = [
			undefined,
			"agents",
			"progress",
			"mailbox",
			"output",
			"health",
			"metrics",
			"plan",
			"schedules",
		];
		for (const pane of panes) {
			assert.equal(dashboardActionForKey("b", pane), "browser", `pane=${String(pane)}`);
		}
	});
});
