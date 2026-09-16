/**
 * K-1 — dashboard keybinding cheatsheet overlay (RAIL design language, M4/E1).
 *
 * Toggled by `?` (bound in keybinding-map.ts). Renders the dashboard's
 * keybindings grouped by scope (general / navigation / panes / schedules /
 * plan / run actions / mailbox / health) directly from `DASHBOARD_KEYS`, so
 * adding a key in one place is reflected here automatically.
 *
 * Grammar (docs/UI-DESIGN-SYSTEM.md §2.E):
 *
 *   ┏ HELP ▸ dashboard
 *   ┣ GENERAL
 *   ┃ Q/Esc   close dashboard    Enter/S/Tab/Space   open run status
 *   ┗ ? toggle · Esc dismiss
 *
 * The legacy rounded box (`╭─╮│╰─╯├─┤`) is retired: the overlay is a canopy +
 * `┣ SECTION` group headers + `┃` rows. Each group title is a RAIL section
 * (replacing the old accent-only row), and the always-visible column key/token
 * pair now goes through the SHARED `keyToken()` from `src/ui/rail.ts`.
 *
 * Why that mattered: the old file-local `keyToken` had no `case "\t"` branch, so
 * `DASHBOARD_KEYS.select`'s raw tab byte was rendered verbatim into the table
 * and knocked the row's alignment out by one column (audit §4). The shared
 * tokenizer maps it to `Tab` (and `Esc`/`↑/↓`/`PgUp`/`Space` consistently).
 *
 * Width contract: `render(width)` — every line is built through `railLine`,
 * which owns the `glyph + space` separator and never emits a line wider than
 * the render width. Nothing is baked at build time.
 */

import { pad, truncate, visibleWidth } from "../../utils/visual.ts";
import { DASHBOARD_KEYS } from "../keybinding-map.ts";
import { canopyLine, formatHint, keyToken, RAIL, railLine, sectionLine } from "../rail.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

/** Translate a raw key sequence into a readable token for the cheatsheet.
 *  Delegates to the SHARED `keyToken` (rail.ts) so the cheatsheet, the footer
 *  hints and the tool cards can never drift apart. */
function keyList(keys: readonly string[]): string {
	return [...new Set(keys.map((key) => keyToken(key)))].join("/");
}

export interface HelpEntry {
	readonly keys: string;
	readonly label: string;
}

export interface HelpGroup {
	readonly title: string;
	readonly entries: readonly HelpEntry[];
}

const ROOT_LABELS: Record<string, string> = {
	summary: "summary",
	artifacts: "artifacts",
	api: "api",
	agents: "agents",
	mailbox: "mailbox",
	events: "events",
	output: "output",
	transcript: "transcript",
	liveConversation: "live conv",
	reload: "reload",
	// NOTE: `progressToggle` deliberately has no label here — the `p` binding
	// had no visible effect (P1-5, phantom key) and is being removed from
	// keybinding-map.ts. Entries derive from Object.entries(DASHBOARD_KEYS.root),
	// so the row disappears entirely once that key is gone.
};

const SCHEDULES_LABELS: Record<string, string> = {
	toggle: "toggle",
	runNow: "run now",
	details: "details",
	delete: "delete",
	refresh: "refresh",
};

const PLAN_LABELS: Record<string, string> = {
	approve: "approve",
	deny: "deny",
	diff: "diff",
};

const MAILBOX_LABELS: Record<string, string> = {
	ack: "ack",
	nudge: "nudge",
	compose: "compose",
	preview: "preview",
	ackAll: "ack all",
};

const HEALTH_LABELS: Record<string, string> = {
	recovery: "recover",
	killStale: "kill stale",
	diagnosticExport: "diag export",
};

function buildHelpGroups(): HelpGroup[] {
	const paneEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.pane).map(([name, keys]) => ({
		keys: keyList(keys),
		label: name,
	}));
	const rootEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.root).map(([name, keys]) => ({
		keys: keyList(keys),
		label: ROOT_LABELS[name] ?? name,
	}));
	// P1-14: pane 8 (schedules) and pane 7 (plan) have pane-scoped action keys
	// that were missing from this cheatsheet entirely.
	const scheduleEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.schedules).map(([name, keys]) => ({
		keys: keyList(keys),
		label: SCHEDULES_LABELS[name] ?? name,
	}));
	const planEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.plan).map(([name, keys]) => ({
		keys: keyList(keys),
		label: PLAN_LABELS[name] ?? name,
	}));
	const mailboxEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.mailbox)
		.filter(([name]) => name !== "openDetail")
		.map(([name, keys]) => ({
			keys: keyList(keys),
			label: MAILBOX_LABELS[name] ?? name,
		}));
	const healthEntries: HelpEntry[] = Object.entries(DASHBOARD_KEYS.health).map(([name, keys]) => ({
		keys: keyList(keys),
		label: HEALTH_LABELS[name] ?? name,
	}));
	return [
		{
			title: "General",
			entries: [
				{
					keys: keyList(DASHBOARD_KEYS.close),
					label: "close dashboard",
				},
				{
					keys: keyList(DASHBOARD_KEYS.select),
					label: "open run status",
				},
				{ keys: "?", label: "toggle this help" },
			],
		},
		{
			title: "Navigation",
			entries: [
				{
					// Union of the up/down aliases, deduped through the shared
					// `keyToken` (`k`/`up` and `j`/`down` collapse to one `↑/↓`).
					keys: [
						...new Set([...DASHBOARD_KEYS.navigation.up, ...DASHBOARD_KEYS.navigation.down].map((key) => keyToken(key))),
					].join("/"),
					label: "move selection",
				},
			],
		},
		{ title: "Panes", entries: paneEntries },
		{ title: "Schedules (pane 8)", entries: scheduleEntries },
		{ title: "Plan (pane 7)", entries: planEntries },
		{ title: "Run actions", entries: rootEntries },
		{ title: "Mailbox (pane 3)", entries: mailboxEntries },
		{
			title: "Health & notifications",
			entries: [
				...healthEntries,
				{
					keys: keyList(DASHBOARD_KEYS.notification.dismissAll),
					label: "dismiss notifs",
				},
			],
		},
	];
}

/** Test seam (mirrors `__test__openPane` / `__resetInlinePanelForTest`): the
 *  generated groups, so tests can assert keys/labels without parsing the
 *  rendered surface. The overlay itself renders through `buildHelpGroups()`. */
export function __test__buildHelpGroups(): HelpGroup[] {
	return buildHelpGroups();
}

/** Width of the key column: the widest rendered token list, capped at 20 so a
 *  future key set cannot push the labels off the row. Derived from the data —
 *  never a hand-tuned constant that silently misaligns when a key is added. */
function keyColumnWidth(groups: readonly HelpGroup[]): number {
	const widths = groups.flatMap((group) => group.entries.map((entry) => visibleWidth(entry.keys)));
	return Math.min(20, Math.max(1, ...widths));
}

export class HelpOverlay {
	private readonly theme: CrewTheme;

	constructor(theme: unknown = {}) {
		this.theme = asCrewTheme(theme);
	}

	invalidate(): void {
		// Stateless overlay.
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const theme = this.theme;
		const budget = width - 2;
		const groups = buildHelpGroups();
		const keyCol = keyColumnWidth(groups);
		const lines: string[] = [canopyLine({ word: "HELP", subject: "dashboard", theme, budget })];
		for (const group of groups) {
			lines.push(sectionLine({ name: group.title, theme, budget }));
			for (let i = 0; i < group.entries.length; i += 2) {
				const pair = group.entries.slice(i, i + 2);
				const cell = (entry: HelpEntry) =>
					`${theme.bold(pad(truncate(entry.keys, keyCol), keyCol))} ${theme.fg("dim", truncate(entry.label, 16))}`;
				lines.push(railLine(RAIL.body, "border", truncate(pair.map(cell).join("   "), budget), theme, budget));
			}
		}
		lines.push(
			railLine(
				RAIL.close,
				"border",
				theme.fg(
					"dim",
					formatHint([
						["?", "toggle"],
						["escape", "dismiss"],
					]),
				),
				theme,
				budget,
			),
		);
		return lines;
	}
}
