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

import * as fs from "node:fs";
import * as path from "node:path";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { getCrewEnv } from "../config/env-vars.ts";
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
 * The default dispatch table. ORDER MATTERS — first match wins. These
 * hardcoded defaults may be overridden per-action via `.crew/config.json`
 * (`keybindings` section) and/or the `PI_CREW_KEYBINDINGS` env var — see
 * `getEffectiveBindings` below.
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
const DEFAULT_BINDINGS: readonly KeyBinding[] = [
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

// ─── Keybinding overrides (UI-2) ───────────────────────────────────────────
//
// The hardcoded DEFAULT_BINDINGS above can be overridden per-action via two
// layered sources (later wins):
//   1. `.crew/config.json` → top-level `keybindings` object, e.g.
//        { "keybindings": { "reload": ["z"], "events": ["E"] } }
//   2. `PI_CREW_KEYBINDINGS` env var — a JSON object string of the same shape
//      (highest precedence; handy for ad-hoc / test overrides).
//
// Each entry REPLACES the default key list for that action (the action keeps
// its original pane scope). Actions not listed keep their defaults, so the
// parity golden snapshot is unaffected when no override is configured.
//
// Collision validation: an overridden key that would clash with another
// (default or overridden) binding in a compatible pane scope is treated as a
// collision; the offending action's override is reverted to its default and a
// warning is recorded (getKeybindingOverrideWarnings). This keeps the
// first-match-wins dispatch unambiguous — a shadowed override never silently
// changes behaviour.

/** Override map: action → replacement keys. `Partial` ⇒ only listed actions. */
export type KeybindingOverride = Partial<Record<DashboardKeyAction, readonly string[]>>;

const KEYBINDINGS_ENV = "PI_CREW_KEYBINDINGS";

/** Every dispatched action is a valid override target. */
const VALID_OVERRIDE_ACTIONS: ReadonlySet<string> = new Set(DEFAULT_BINDINGS.map((b) => b.action));

/** Coerce an unknown parsed value into a safe {@link KeybindingOverride}. */
function parseKeybindingOverride(raw: unknown): KeybindingOverride {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const result: KeybindingOverride = {};
	for (const [action, keys] of Object.entries(raw as Record<string, unknown>)) {
		if (!VALID_OVERRIDE_ACTIONS.has(action)) continue;
		if (!Array.isArray(keys)) continue;
		const clean = keys.filter((k): k is string => typeof k === "string" && k.length > 0);
		if (clean.length > 0) result[action as DashboardKeyAction] = clean;
	}
	return result;
}

/**
 * Two pane scopes are "compatible" when some `activePane` could make both
 * bindings fire at once (so a shared key is genuinely ambiguous). Global
 * (`undefined`) matches anything; two different concrete panes never overlap.
 */
function paneScopesCompatible(a: ActivePane | undefined, b: ActivePane | undefined): boolean {
	if (a === undefined || b === undefined) return true;
	return a === b;
}

interface EffectiveBindingsResult {
	readonly bindings: readonly KeyBinding[];
	/** Actions whose override was rejected due to a collision. */
	readonly reverted: readonly DashboardKeyAction[];
}

/**
 * Apply `overrides` onto {@link DEFAULT_BINDINGS} (replace keys per action,
 * preserving each action's pane scope) and detect collisions. A colliding
 * override is reverted to its default so the dispatch stays unambiguous.
 */
function computeEffectiveBindings(overrides: KeybindingOverride): EffectiveBindingsResult {
	const applied = new Map<DashboardKeyAction, KeyBinding>();
	for (const def of DEFAULT_BINDINGS) {
		const ov = overrides[def.action];
		applied.set(def.action, ov && ov.length > 0 ? { keys: [...ov], action: def.action, pane: def.pane } : def);
	}
	const effective = [...applied.values()];
	const reverted = new Set<DashboardKeyAction>();
	for (const def of DEFAULT_BINDINGS) {
		const ov = overrides[def.action];
		if (!ov || ov.length === 0) continue; // not overridden
		const ob = applied.get(def.action);
		if (!ob) continue;
		for (const other of effective) {
			if (other.action === def.action) continue;
			if (!paneScopesCompatible(ob.pane, other.pane)) continue;
			if (ob.keys.some((k) => other.keys.includes(k))) {
				reverted.add(def.action);
				break;
			}
		}
	}
	const bindings =
		reverted.size > 0
			? effective.map((b) => (reverted.has(b.action) ? (DEFAULT_BINDINGS.find((d) => d.action === b.action) ?? b) : b))
			: effective;
	return { bindings, reverted: [...reverted] };
}

/** Read the `keybindings` section from `<cwd>/.crew/config.json`. */
function readConfigKeybindings(cwd: string): KeybindingOverride {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(cwd, ".crew", "config.json"), "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		return parseKeybindingOverride((raw as Record<string, unknown>).keybindings);
	} catch {
		return {};
	}
}

/** Read the `PI_CREW_KEYBINDINGS` env var (JSON object string). */
function readEnvKeybindings(): KeybindingOverride {
	const raw = getCrewEnv(KEYBINDINGS_ENV);
	if (!raw) return {};
	try {
		return parseKeybindingOverride(JSON.parse(raw));
	} catch {
		return {};
	}
}

function configKeybindingsMtime(cwd: string): number | undefined {
	try {
		return fs.statSync(path.join(cwd, ".crew", "config.json")).mtimeMs;
	} catch {
		return undefined;
	}
}

interface EffectiveCache {
	readonly env: string | undefined;
	readonly configMtime: number | undefined;
	readonly cwd: string;
	readonly bindings: readonly KeyBinding[];
}

let _effectiveCache: EffectiveCache | null = null;
let _overrideWarnings: readonly string[] = [];

/**
 * Resolve the effective dispatch table: {@link DEFAULT_BINDINGS} with config +
 * env overrides applied (env wins per action). Memoised on (env value, config
 * mtime, cwd); a single `statSync` per call detects on-disk config changes.
 */
function getEffectiveBindings(cwd: string = process.cwd()): readonly KeyBinding[] {
	const envRaw = getCrewEnv(KEYBINDINGS_ENV);
	const configMtime = configKeybindingsMtime(cwd);
	if (_effectiveCache && _effectiveCache.env === envRaw && _effectiveCache.configMtime === configMtime && _effectiveCache.cwd === cwd) {
		return _effectiveCache.bindings;
	}
	const merged: KeybindingOverride = { ...readConfigKeybindings(cwd), ...readEnvKeybindings() };
	const { bindings, reverted } = computeEffectiveBindings(merged);
	_overrideWarnings = reverted.map((a) => `keybinding override for '${a}' collides with another binding — reverting to default`);
	_effectiveCache = { env: envRaw, configMtime, cwd, bindings };
	return bindings;
}

/** Warnings from the most recent override resolution (e.g. collisions). */
export function getKeybindingOverrideWarnings(): readonly string[] {
	// Ensure a resolution has run so warnings are populated.
	getEffectiveBindings();
	return _overrideWarnings;
}

/** @internal — drop the memoised effective-binding cache (tests). */
export function __test__resetKeybindingCache(): void {
	_effectiveCache = null;
	_overrideWarnings = [];
}

/**
 * Resolve a raw input `data` string to a dashboard action.
 *
 * Data-driven dispatch: iterates the effective binding table (hardcoded
 * {@link DEFAULT_BINDINGS}, optionally overridden per-action via config/env —
 * see {@link getEffectiveBindings}) in order and returns the action of the
 * first binding whose `keys` contain `data` and whose optional `pane`
 * restriction matches `activePane`. With no override configured the result is
 * identical to the pre-L2 if-chain (verified by
 * `test/unit/keybinding-map.parity.test.ts`).
 *
 * @param data Raw key input (single char or escape sequence).
 * @param activePane Currently focused pane; pane-scoped bindings only fire
 *                   when this matches. `undefined` disables all pane-scoped
 *                   bindings (matching the old behavior where omitting the
 *                   arg skipped the `activePane === ...` branches).
 */
export function dashboardActionForKey(data: string, activePane?: ActivePane): DashboardKeyAction | undefined {
	// Effective table = hardcoded DEFAULT_BINDINGS with optional config/env
	// overrides applied (see getEffectiveBindings). Memoised; one statSync/call.
	const BINDINGS = getEffectiveBindings();
	// Two-pass dispatch to preserve case-sensitivity for plain ASCII keys
	// while still normalizing escape sequences via matchesKey().
	//
	// Background: pi-tui's matchesKey() is case-insensitive, so matchesKey("d",
	// "D") === true. A single-pass loop that intermixes exact + matchesKey
	// checks would let the pane-scoped health-diagnostic-export binding
	// (candidate "D") win over the unscoped agents binding (candidate "d")
	// when activePane === "health" — collapsing the d/D case distinction.
	//
	// Pass 1 — exact string match (case-sensitive). Handles literal ASCII
	// keystrokes ('d', 'D', 'q', 'S', …) and preserves their distinct meanings.
	for (const binding of BINDINGS) {
		if (binding.pane !== undefined && binding.pane !== activePane) continue;
		if (binding.keys.includes(data)) return binding.action;
	}
	// Pass 2 — terminal-aware match for escape sequences / canonical KeyIds.
	// Only reached when no exact ASCII match exists (data is e.g. '\x1b[A',
	// '\x1bOA', or an app-cursor-mode variant). Uses matchesKey() to normalize
	// legacy CSI, app-cursor-mode, and Kitty-protocol variants uniformly.
	const key = keyOf(data);
	for (const binding of BINDINGS) {
		if (binding.pane !== undefined && binding.pane !== activePane) continue;
		for (const candidate of binding.keys) {
			if (key === candidate) return binding.action;
			if (matchesKey(data, candidate as KeyId)) return binding.action;
		}
	}
	return undefined;
}
