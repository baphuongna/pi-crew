/**
 * Dashboard keybinding map (L2 refactor: data-driven dispatch).
 *
 * Before L2 this module exposed `DASHBOARD_KEYS` (a data table) but dispatched
 * via a 30-line `if (includes(...)) return "..."` chain — adding a key meant
 * editing BOTH the table AND the dispatch, a DRY violation. L2 collapses the
 * dispatch into a single `for (const b of BINDINGS)` loop driven by the
 * `BINDINGS` table below. `DASHBOARD_KEYS` is retained as the raw key data so
 * existing imports and the dead-but-intentional `KEY_RESERVED` set keep working.
 *
 * Recalibration vs. the original L2 plan: the plan also called for an
 * `inTextInput` guard to prevent letter-key leaks into TUI text inputs.
 * Verified during implementation that this is NOT needed — overlays are
 * mutually exclusive and each has its own `handleInput`. `mailbox-compose-overlay.ts:111`
 * captures every single-char key via `appendText(data)` and never delegates to
 * `dashboardActionForKey`, so there is no leak path. Adding the guard would
 * complicate the API (`run-dashboard.ts:485` has no text-input state to pass)
 * for zero benefit. The input-guard half of L2 is therefore intentionally
 * skipped; only the DRY/data-driven dispatch refactor landed.
 *
 * Origin pattern: deer-flow `frontend/src/components/workspace/command-palette.tsx:39-50`
 * drives shortcuts from a single data array consumed by one loop in
 * `use-global-shortcuts.ts:38-61`.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { keyOf } from "./key-utils.ts";

export const DASHBOARD_KEYS = {
	close: ["q", "escape", "\u001b"],
	select: ["enter", "s", "\r", "\n", "tab", "\t", " "],
	help: ["?"],
	root: {
		summary: ["u"],
		artifacts: ["a"],
		api: ["i"],
		agents: ["d"],
		mailbox: ["m"],
		events: ["e"],
		output: ["o"],
		transcript: ["v"],
		liveConversation: ["V"],
		reload: ["r"],
		progressToggle: ["p"],
	},
	pane: {
		agents: ["1"],
		progress: ["2"],
		mailbox: ["3"],
		output: ["4"],
		health: ["5"],
		metrics: ["6"],
	},
	navigation: { up: ["k", "up"], down: ["j", "down"] },
	mailbox: {
		ack: ["A"],
		nudge: ["N"],
		compose: ["C"],
		preview: ["P"],
		ackAll: ["X"],
		openDetail: ["\r", "\n"],
	},
	health: { recovery: ["R"], killStale: ["K"], diagnosticExport: ["D"] },
	notification: { dismissAll: ["H"] },
} as const;

/**
 * Pane identifiers that can scope a binding. `undefined` means the binding
 * fires in every pane.
 */
export type ActivePane = "agents" | "progress" | "mailbox" | "output" | "health" | "metrics";

/**
 * A single keybinding: the keys that trigger it, the action it produces, and
 * an optional pane restriction. The dispatch loop returns the FIRST matching
 * binding, so table ORDER IS SIGNIFICANT and must mirror the old if-chain
 * precedence (pane-specific overrides before their generic competitors).
 */
export interface KeyBinding {
	readonly keys: readonly string[];
	readonly action: DashboardKeyAction;
	/** When set, the binding only fires when `activePane === pane`. */
	readonly pane?: ActivePane;
}

export type DashboardKeyAction =
	| "close"
	| "help"
	| "select"
	| "summary"
	| "artifacts"
	| "api"
	| "agents"
	| "mailbox"
	| "events"
	| "output"
	| "transcript"
	| "live-conversation"
	| "reload"
	| "progressToggle"
	| "pane-agents"
	| "pane-progress"
	| "pane-mailbox"
	| "pane-output"
	| "pane-health"
	| "pane-metrics"
	| "up"
	| "down"
	| "mailbox-detail"
	| "health-recovery"
	| "health-kill-stale"
	| "health-diagnostic-export"
	| "notifications-dismiss";

/**
 * The dispatch table. ORDER MATTERS — first match wins.
 *
 * Precedence notes (must match the pre-L2 if-chain exactly):
 *   1. `close` always wins (q / Esc).
 *   2. `mailbox-detail` (\r, \n) is pane-scoped to mailbox and MUST precede
 *      `select` (which also binds \r, \n) so Enter opens the detail instead of
 *      triggering select while in the mailbox pane.
 *   3. `health-*` are pane-scoped to health.
 *   4. `notifications-dismiss` (H) is global.
 *   5. `select`, then the root actions, pane switches, and navigation.
 *
 * NOTE: mailbox action keys A/N/C/P/X (ack/nudge/compose/preview/ackAll) are
 * intentionally NOT in this table. They live in `DASHBOARD_KEYS.mailbox` for
 * reservation but are handled by the mailbox overlay's own `handleInput`,
 * not by the dashboard dispatch. Adding them here would change behavior.
 */
const BINDINGS: readonly KeyBinding[] = [
	{ keys: DASHBOARD_KEYS.close, action: "close" },
	{ keys: DASHBOARD_KEYS.help, action: "help" },
	{
		keys: DASHBOARD_KEYS.mailbox.openDetail,
		action: "mailbox-detail",
		pane: "mailbox",
	},
	{
		keys: DASHBOARD_KEYS.health.recovery,
		action: "health-recovery",
		pane: "health",
	},
	{
		keys: DASHBOARD_KEYS.health.killStale,
		action: "health-kill-stale",
		pane: "health",
	},
	{
		keys: DASHBOARD_KEYS.health.diagnosticExport,
		action: "health-diagnostic-export",
		pane: "health",
	},
	{
		keys: DASHBOARD_KEYS.notification.dismissAll,
		action: "notifications-dismiss",
	},
	{ keys: DASHBOARD_KEYS.select, action: "select" },
	{ keys: DASHBOARD_KEYS.root.summary, action: "summary" },
	{ keys: DASHBOARD_KEYS.root.artifacts, action: "artifacts" },
	{ keys: DASHBOARD_KEYS.root.api, action: "api" },
	{ keys: DASHBOARD_KEYS.root.agents, action: "agents" },
	{ keys: DASHBOARD_KEYS.root.mailbox, action: "mailbox" },
	{ keys: DASHBOARD_KEYS.root.events, action: "events" },
	{ keys: DASHBOARD_KEYS.root.output, action: "output" },
	{ keys: DASHBOARD_KEYS.root.transcript, action: "transcript" },
	{ keys: DASHBOARD_KEYS.root.liveConversation, action: "live-conversation" },
	{ keys: DASHBOARD_KEYS.root.reload, action: "reload" },
	{ keys: DASHBOARD_KEYS.root.progressToggle, action: "progressToggle" },
	{ keys: DASHBOARD_KEYS.pane.agents, action: "pane-agents" },
	{ keys: DASHBOARD_KEYS.pane.progress, action: "pane-progress" },
	{ keys: DASHBOARD_KEYS.pane.mailbox, action: "pane-mailbox" },
	{ keys: DASHBOARD_KEYS.pane.output, action: "pane-output" },
	{ keys: DASHBOARD_KEYS.pane.health, action: "pane-health" },
	{ keys: DASHBOARD_KEYS.pane.metrics, action: "pane-metrics" },
	{ keys: DASHBOARD_KEYS.navigation.up, action: "up" },
	{ keys: DASHBOARD_KEYS.navigation.down, action: "down" },
];

/**
 * Reserved keys — every key the dashboard claims, including mailbox/health
 * action keys that are NOT dispatched here but are handled by their own
 * overlays. Derived from `DASHBOARD_KEYS` (the full key set) rather than from
 * `BINDINGS` (the dispatched subset) so overlay-handled keys stay reserved.
 *
 * @internal Consumed by `test/unit/keybinding-map.parity.test.ts` (asserts
 * reserved-key membership) and the L2 dispatch smoke script. It is the
 * canonical "keys the dashboard ecosystem owns" set — NOT dead code.
 */
const KEY_RESERVED = new Set<string>([
	...DASHBOARD_KEYS.close,
	...DASHBOARD_KEYS.select,
	...DASHBOARD_KEYS.help,
	...Object.values(DASHBOARD_KEYS.root).flat(),
	...Object.values(DASHBOARD_KEYS.pane).flat(),
	...Object.values(DASHBOARD_KEYS.navigation).flat(),
	...Object.values(DASHBOARD_KEYS.mailbox).flat(),
	...Object.values(DASHBOARD_KEYS.health).flat(),
	...Object.values(DASHBOARD_KEYS.notification).flat(),
]);

export { KEY_RESERVED };

/**
 * Resolve a raw input `data` string to a dashboard action.
 *
 * Data-driven dispatch: iterates `BINDINGS` in order and returns the action of
 * the first binding whose `keys` contain `data` and whose optional `pane`
 * restriction matches `activePane`. Behavior is identical to the pre-L2
 * if-chain (verified by `test/unit/keybinding-map.parity.test.ts`).
 *
 * @param data Raw key input (single char or escape sequence).
 * @param activePane Currently focused pane; pane-scoped bindings only fire
 *                   when this matches. `undefined` disables all pane-scoped
 *                   bindings (matching the old behavior where omitting the
 *                   arg skipped the `activePane === ...` branches).
 */
export function dashboardActionForKey(data: string, activePane?: ActivePane): DashboardKeyAction | undefined {
	// Terminal-aware dispatch: first resolve the raw key bytes to a canonical
	// KeyId (`up`, `escape`, `space`, …) using pi-tui's matchesKey(), then
	// match each candidate id against that. For pure-ASCII candidates like
	// `q`, `s`, etc. the data string itself is the candidate. This single
	// pass handles legacy CSI escapes (`\x1b[A`), application-cursor-mode
	// escapes (`\x1bOA`), and Kitty-protocol variants (`\x1b[A;1:u`) the
	// same way.
	const key = keyOf(data);
	for (const binding of BINDINGS) {
		if (binding.pane !== undefined && binding.pane !== activePane) continue;
		for (const candidate of binding.keys) {
			if (data === candidate) return binding.action;
			if (key === candidate) return binding.action;
			if (matchesKey(data, candidate as KeyId)) return binding.action;
		}
	}
	return undefined;
}
