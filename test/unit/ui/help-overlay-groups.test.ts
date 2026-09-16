/**
 * M1-11 (audit P1-14) + M1-7 (audit P1-5, help-overlay half).
 *
 * M1-11: the `?` cheatsheet only built the General / Navigation / Panes / Run
 * actions / Mailbox / Health groups, so the pane-scoped action keys of pane 8
 * (schedules) and pane 7 (plan) were undiscoverable.
 *
 * M1-7: ROOT_LABELS carried a friendly "progress" label for the `progressToggle`
 * (`p`) binding, which advertised a phantom key (the flag never changed any
 * rendered content). The label is gone; the row itself disappears once lane L3
 * removes `progressToggle` from DASHBOARD_KEYS.root (help rows are derived from
 * `Object.entries(DASHBOARD_KEYS.root)`, so the two halves are order-independent).
 *
 * E1 / M4 (2026-09-16): the cheatsheet moved to the RAIL design language
 * (`docs/UI-DESIGN-SYSTEM.md` §2.E) — the `│ …│` rounded frame is retired and
 * group titles are `┣ SECTION` rows (upper-cased by `sectionLine`), while every
 * key token now goes through the SHARED `keyToken()` from `src/ui/rail.ts`
 * (`n` renders as `N`, and the raw `\t` byte as `Tab`). The assertions below were
 * adapted to that grammar; every intent (group order, keys derived from
 * DASHBOARD_KEYS, no phantom `p` row) is unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DASHBOARD_KEYS } from "../../../src/ui/keybinding-map.ts";
import { __test__buildHelpGroups, HelpOverlay } from "../../../src/ui/overlays/help-overlay.ts";
import { keyToken } from "../../../src/ui/rail.ts";
import { asCrewTheme } from "../../../src/ui/theme-adapter.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

const WIDTH = 100;

function renderHelp(): string {
	return new HelpOverlay(asCrewTheme({})).render(WIDTH).join("\n");
}

/** The rendered body rows (`┃ …`) with the rail glyph and trailing padding
 *  stripped — the cells are then asserted verbatim. */
function renderedRows(): string[] {
	return renderHelp()
		.split("\n")
		.filter((line) => line.startsWith("┃ "))
		.map((line) => line.slice(2).replace(/\s+$/, ""));
}

/** Mirrors the overlay's key column (`keyColumnWidth`, help-overlay.ts): the
 *  widest rendered token list, capped at 20. */
function keyCol(): number {
	const widths = __test__buildHelpGroups().flatMap((group) => group.entries.map((entry) => visibleWidth(entry.keys)));
	return Math.min(20, Math.max(1, ...widths));
}

/** A rendered `keys label` cell: the key token padded to the key column, one
 *  space, then the label. */
function hasCell(keys: string, label: string): boolean {
	const cell = `${keys}${" ".repeat(Math.max(0, keyCol() - visibleWidth(keys)))} ${label}`;
	return renderedRows().some((row) => row.includes(cell));
}

function groupTitles(): string[] {
	return __test__buildHelpGroups().map((group) => group.title);
}

// ── M1-11 ──────────────────────────────────────────────────────────────

test("M1-11: help overlay has Schedules (pane 8) and Plan (pane 7) groups", () => {
	assert.deepEqual(groupTitles(), [
		"General",
		"Navigation",
		"Panes",
		"Schedules (pane 8)",
		"Plan (pane 7)",
		"Run actions",
		"Mailbox (pane 3)",
		"Health & notifications",
	]);
});

test("M1-11: schedules + plan groups are generated from DASHBOARD_KEYS", () => {
	const groups = __test__buildHelpGroups();
	const schedules = groups.find((group) => group.title === "Schedules (pane 8)");
	const plan = groups.find((group) => group.title === "Plan (pane 7)");
	assert.ok(schedules && plan, "schedules/plan groups missing");

	assert.deepEqual(
		schedules.entries.map((entry) => entry.keys),
		Object.keys(DASHBOARD_KEYS.schedules).map((name) =>
			keyToken((DASHBOARD_KEYS.schedules as Record<string, readonly string[]>)[name]![0]!),
		),
	);
	assert.deepEqual(
		plan.entries.map((entry) => entry.keys),
		Object.keys(DASHBOARD_KEYS.plan).map((name) => keyToken((DASHBOARD_KEYS.plan as Record<string, readonly string[]>)[name]![0]!)),
	);
});

test("M1-11: rendered help output contains the schedules keys T N V X R", () => {
	const help = renderHelp();
	assert.ok(help.includes("┣ SCHEDULES (PANE 8)"), "schedules section header missing from rendered help");
	for (const [keys, label] of [
		["T", "toggle"],
		["N", "run now"],
		["V", "details"],
		["X", "delete"],
		["R", "refresh"],
	] as const) {
		assert.ok(hasCell(keys, label), `${keys} ${label} row missing:\n${help}`);
	}
});

test("M1-11: rendered help output contains the plan keys A N X", () => {
	const help = renderHelp();
	assert.ok(help.includes("┣ PLAN (PANE 7)"), "plan section header missing from rendered help");
	for (const [keys, label] of [
		["A", "approve"],
		["N", "deny"],
		["X", "diff"],
	] as const) {
		assert.ok(hasCell(keys, label), `${keys} ${label} row missing:\n${help}`);
	}
});

// ── M1-7 ───────────────────────────────────────────────────────────────

test("M1-7: no help entry advertises the phantom `p` key with the stale 'progress' label", () => {
	const entries = __test__buildHelpGroups().flatMap((group) => group.entries);
	const stale = entries.filter((entry) => entry.keys.split("/").includes("p") && entry.label === "progress");
	assert.deepEqual(stale, [], "ROOT_LABELS.progressToggle still maps `p` to the 'progress' label");
});

test("M1-7: help output no longer mentions progressToggle once the key is gone", () => {
	if ("progressToggle" in DASHBOARD_KEYS.root) {
		// Lane L3 has not removed the binding yet: the row now falls back to the
		// raw key name — it just must not keep the friendly stale label, which is
		// asserted above. Nothing else to check in this tree state.
		const entries = __test__buildHelpGroups().flatMap((group) => group.entries);
		assert.equal(
			entries.some((entry) => entry.label === "progressToggle" && entry.keys.split("/").includes("p")),
			true,
			"unexpected: key exists but no fallback row rendered",
		);
		return;
	}
	const help = renderHelp();
	assert.equal(help.includes("progressToggle"), false, "phantom progressToggle row still advertised");
	assert.equal(hasCell("P", "progress"), false, "stale `p → progress` row still advertised");
});
