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
 *     const panes=[undefined,'agents','progress','mailbox','output','health','metrics'];
 *     const allKeys=new Set([...DASHBOARD_KEYS.close,...DASHBOARD_KEYS.select,
 *       ...Object.values(DASHBOARD_KEYS.root).flat(),...Object.values(DASHBOARD_KEYS.pane).flat(),
 *       ...Object.values(DASHBOARD_KEYS.navigation).flat(),...Object.values(DASHBOARD_KEYS.mailbox).flat(),
 *       ...Object.values(DASHBOARD_KEYS.health).flat(),...Object.values(DASHBOARD_KEYS.notification).flat()]);
 *     const g={};for(const p of panes)for(const k of [...allKeys].sort())
 *       g[String(p)+'|'+JSON.stringify(k)]=dashboardActionForKey(k,p)??null;
 *     console.log(JSON.stringify(g));"
 *
 * Format: "<pane>|<JSON.stringify(key)>" → action | null (null means undefined).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActivePane, DASHBOARD_KEYS, dashboardActionForKey, KEY_RESERVED } from "../../src/ui/keybinding-map.ts";

// Golden snapshot from the pre-L2 implementation. DO NOT edit by hand —
// regenerate with the snippet above if the dispatch contract intentionally
// changes, and document WHY in the commit message.
const GOLDEN: Record<string, string | null> = {
	'agents|" "': "select",
	'agents|"1"': "pane-agents",
	'agents|"2"': "pane-progress",
	'agents|"3"': "pane-mailbox",
	'agents|"4"': "pane-output",
	'agents|"5"': "pane-health",
	'agents|"6"': "pane-metrics",
	'agents|"A"': null,
	'agents|"C"': null,
	'agents|"D"': null,
	'agents|"H"': "notifications-dismiss",
	'agents|"K"': null,
	'agents|"N"': null,
	'agents|"P"': null,
	'agents|"R"': null,
	'agents|"V"': "live-conversation",
	'agents|"X"': null,
	'agents|"\\n"': "select",
	'agents|"\\r"': "select",
	'agents|"\\t"': "select",
	'agents|"\\u001b"': "close",
	'agents|"a"': "artifacts",
	'agents|"d"': "agents",
	'agents|"down"': "down",
	'agents|"e"': "events",
	'agents|"enter"': "select",
	'agents|"escape"': "close",
	'agents|"i"': "api",
	'agents|"j"': "down",
	'agents|"k"': "up",
	'agents|"m"': "mailbox",
	'agents|"o"': "output",
	'agents|"p"': "progressToggle",
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
	'health|"A"': null,
	'health|"C"': null,
	'health|"D"': "health-diagnostic-export",
	'health|"H"': "notifications-dismiss",
	'health|"K"': "health-kill-stale",
	'health|"N"': null,
	'health|"P"': null,
	'health|"R"': "health-recovery",
	'health|"V"': "live-conversation",
	'health|"X"': null,
	'health|"\\n"': "select",
	'health|"\\r"': "select",
	'health|"\\t"': "select",
	'health|"\\u001b"': "close",
	'health|"a"': "artifacts",
	'health|"d"': "agents",
	'health|"down"': "down",
	'health|"e"': "events",
	'health|"enter"': "select",
	'health|"escape"': "close",
	'health|"i"': "api",
	'health|"j"': "down",
	'health|"k"': "up",
	'health|"m"': "mailbox",
	'health|"o"': "output",
	'health|"p"': "progressToggle",
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
	'mailbox|"A"': null,
	'mailbox|"C"': null,
	'mailbox|"D"': null,
	'mailbox|"H"': "notifications-dismiss",
	'mailbox|"K"': null,
	'mailbox|"N"': null,
	'mailbox|"P"': null,
	'mailbox|"R"': null,
	'mailbox|"V"': "live-conversation",
	'mailbox|"X"': null,
	'mailbox|"\\n"': "mailbox-detail",
	'mailbox|"\\r"': "mailbox-detail",
	'mailbox|"\\t"': "select",
	'mailbox|"\\u001b"': "close",
	'mailbox|"a"': "artifacts",
	'mailbox|"d"': "agents",
	'mailbox|"down"': "down",
	'mailbox|"e"': "events",
	'mailbox|"enter"': "select",
	'mailbox|"escape"': "close",
	'mailbox|"i"': "api",
	'mailbox|"j"': "down",
	'mailbox|"k"': "up",
	'mailbox|"m"': "mailbox",
	'mailbox|"o"': "output",
	'mailbox|"p"': "progressToggle",
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
	'metrics|"A"': null,
	'metrics|"C"': null,
	'metrics|"D"': null,
	'metrics|"H"': "notifications-dismiss",
	'metrics|"K"': null,
	'metrics|"N"': null,
	'metrics|"P"': null,
	'metrics|"R"': null,
	'metrics|"V"': "live-conversation",
	'metrics|"X"': null,
	'metrics|"\\n"': "select",
	'metrics|"\\r"': "select",
	'metrics|"\\t"': "select",
	'metrics|"\\u001b"': "close",
	'metrics|"a"': "artifacts",
	'metrics|"d"': "agents",
	'metrics|"down"': "down",
	'metrics|"e"': "events",
	'metrics|"enter"': "select",
	'metrics|"escape"': "close",
	'metrics|"i"': "api",
	'metrics|"j"': "down",
	'metrics|"k"': "up",
	'metrics|"m"': "mailbox",
	'metrics|"o"': "output",
	'metrics|"p"': "progressToggle",
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
	'output|"A"': null,
	'output|"C"': null,
	'output|"D"': null,
	'output|"H"': "notifications-dismiss",
	'output|"K"': null,
	'output|"N"': null,
	'output|"P"': null,
	'output|"R"': null,
	'output|"V"': "live-conversation",
	'output|"X"': null,
	'output|"\\n"': "select",
	'output|"\\r"': "select",
	'output|"\\t"': "select",
	'output|"\\u001b"': "close",
	'output|"a"': "artifacts",
	'output|"d"': "agents",
	'output|"down"': "down",
	'output|"e"': "events",
	'output|"enter"': "select",
	'output|"escape"': "close",
	'output|"i"': "api",
	'output|"j"': "down",
	'output|"k"': "up",
	'output|"m"': "mailbox",
	'output|"o"': "output",
	'output|"p"': "progressToggle",
	'output|"q"': "close",
	'output|"r"': "reload",
	'output|"s"': "select",
	'output|"tab"': "select",
	'output|"u"': "summary",
	'output|"up"': "up",
	'output|"v"': "transcript",
	'progress|" "': "select",
	'progress|"1"': "pane-agents",
	'progress|"2"': "pane-progress",
	'progress|"3"': "pane-mailbox",
	'progress|"4"': "pane-output",
	'progress|"5"': "pane-health",
	'progress|"6"': "pane-metrics",
	'progress|"A"': null,
	'progress|"C"': null,
	'progress|"D"': null,
	'progress|"H"': "notifications-dismiss",
	'progress|"K"': null,
	'progress|"N"': null,
	'progress|"P"': null,
	'progress|"R"': null,
	'progress|"V"': "live-conversation",
	'progress|"X"': null,
	'progress|"\\n"': "select",
	'progress|"\\r"': "select",
	'progress|"\\t"': "select",
	'progress|"\\u001b"': "close",
	'progress|"a"': "artifacts",
	'progress|"d"': "agents",
	'progress|"down"': "down",
	'progress|"e"': "events",
	'progress|"enter"': "select",
	'progress|"escape"': "close",
	'progress|"i"': "api",
	'progress|"j"': "down",
	'progress|"k"': "up",
	'progress|"m"': "mailbox",
	'progress|"o"': "output",
	'progress|"p"': "progressToggle",
	'progress|"q"': "close",
	'progress|"r"': "reload",
	'progress|"s"': "select",
	'progress|"tab"': "select",
	'progress|"u"': "summary",
	'progress|"up"': "up",
	'progress|"v"': "transcript",
	'undefined|" "': "select",
	'undefined|"1"': "pane-agents",
	'undefined|"2"': "pane-progress",
	'undefined|"3"': "pane-mailbox",
	'undefined|"4"': "pane-output",
	'undefined|"5"': "pane-health",
	'undefined|"6"': "pane-metrics",
	'undefined|"A"': null,
	'undefined|"C"': null,
	'undefined|"D"': null,
	'undefined|"H"': "notifications-dismiss",
	'undefined|"K"': null,
	'undefined|"N"': null,
	'undefined|"P"': null,
	'undefined|"R"': null,
	'undefined|"V"': "live-conversation",
	'undefined|"X"': null,
	'undefined|"\\n"': "select",
	'undefined|"\\r"': "select",
	'undefined|"\\t"': "select",
	'undefined|"\\u001b"': "close",
	'undefined|"\\u001bOA"': "up",
	'undefined|"\\u001bOB"': "down",
	'undefined|"a"': "artifacts",
	'undefined|"d"': "agents",
	'undefined|"down"': "down",
	'undefined|"e"': "events",
	'undefined|"enter"': "select",
	'undefined|"escape"': "close",
	'undefined|"i"': "api",
	'undefined|"j"': "down",
	'undefined|"k"': "up",
	'undefined|"m"': "mailbox",
	'undefined|"o"': "output",
	'undefined|"p"': "progressToggle",
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
		const panes: (ActivePane | undefined)[] = [undefined, "agents", "progress", "mailbox", "output", "health", "metrics"];
		const allKeys = new Set<string>([
			...DASHBOARD_KEYS.close,
			...DASHBOARD_KEYS.select,
			...Object.values(DASHBOARD_KEYS.root).flat(),
			...Object.values(DASHBOARD_KEYS.pane).flat(),
			...Object.values(DASHBOARD_KEYS.navigation).flat(),
			...Object.values(DASHBOARD_KEYS.mailbox).flat(),
			...Object.values(DASHBOARD_KEYS.health).flat(),
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

	it("returns undefined for unbound keys", () => {
		assert.equal(dashboardActionForKey("z", undefined), undefined);
		assert.equal(dashboardActionForKey("z", "mailbox"), undefined);
		assert.equal(dashboardActionForKey("", undefined), undefined);
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
	});

	it("does NOT contain unbound keys", () => {
		assert.ok(!KEY_RESERVED.has("z"));
		assert.ok(!KEY_RESERVED.has("b"));
		assert.ok(!KEY_RESERVED.has("f"));
	});
});
