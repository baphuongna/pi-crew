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
 * M2-1 (P1-9) adds the sibling `overlay:*` keyspace below. The migrated
 * overlays dispatch through `overlayActionForKey("<name>", data)` — the same
 * data-driven + override pipeline as the dashboard, but a SEPARATE namespace:
 * an overlay never consults `dashboardActionForKey`, so the no-leak argument
 * above is unchanged.
 *
 * Origin pattern: deer-flow `frontend/src/components/workspace/command-palette.tsx:39-50`
 * drives shortcuts from a single data array consumed by one loop in
 * `use-global-shortcuts.ts:38-61`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { getCrewEnv } from "../config/env-vars.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { keyOf } from "./key-utils.ts";

export const DASHBOARD_KEYS = {
	close: ["q", "escape", "\u001b"],
	select: ["enter", "s", "\r", "\n", "tab", "\t", " "],
	help: ["?"],
	root: {
		summary: ["u"],
		/** US-020: cancel the selected run (2-step confirm in the dashboard). */
		cancel: ["x"],
		artifacts: ["a"],
		api: ["i"],
		agents: ["d"],
		mailbox: ["m"],
		events: ["e"],
		output: ["o"],
		transcript: ["v"],
		liveConversation: ["V"],
		reload: ["r"],
		browser: ["b"],
	},
	pane: {
		agents: ["1"],
		progress: ["2"],
		mailbox: ["3"],
		output: ["4"],
		health: ["5"],
		metrics: ["6"],
		plan: ["7"],
		schedules: ["8"],
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
	plan: { approve: ["A"], deny: ["n"], diff: ["X"] },
	/** Tier A (schedules pane, pane 8): pane-scoped action keys. */
	schedules: { toggle: ["T"], runNow: ["N"], details: ["V"], delete: ["X"], refresh: ["R"] },
	notification: { dismissAll: ["H"] },
} as const;

/**
 * Pane identifiers that can scope a binding. `undefined` means the binding
 * fires in every pane.
 */
export type ActivePane = "agents" | "progress" | "mailbox" | "output" | "health" | "metrics" | "plan" | "schedules";

/**
 * A single keybinding: the keys that trigger it, the action it produces, and
 * an optional pane restriction. The dispatch loop returns the FIRST matching
 * binding, so table ORDER IS SIGNIFICANT and must mirror the old if-chain
 * precedence (pane-specific overrides before their generic competitors).
 */
export interface KeyBinding {
	readonly keys: readonly string[];
	readonly action: DashboardKeyAction;
	/** When set, the binding fires only in these pane(s). */
	readonly pane?: PaneScope;
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
	| "browser"
	| "cancel"
	| "pane-agents"
	| "pane-progress"
	| "pane-mailbox"
	| "pane-output"
	| "pane-health"
	| "pane-metrics"
	| "pane-plan"
	| "pane-schedules"
	| "plan-diff"
	| "schedule-toggle"
	| "schedule-run-now"
	| "schedule-details"
	| "schedule-delete"
	| "schedule-refresh"
	| "up"
	| "down"
	| "mailbox-detail"
	| "health-recovery"
	| "health-kill-stale"
	| "health-diagnostic-export"
	| "plan-approve"
	| "plan-deny"
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
 *   3. `health-*`, `schedule-*`, and `plan-*` are pane-scoped (health /
 *      schedules / progress+plan).
 *   4. `notifications-dismiss` (H) is global.
 *   5. `select`, then the root actions, pane switches, and navigation.
 *   6. `schedule-*` V precedes the unscoped root `liveConversation` (V) so the
 *      schedules-scoped binding wins first-match-wins in pane 8.
 *
 * NOTE: mailbox action keys A/N/C/P/X (ack/nudge/compose/preview/ackAll) are
 * intentionally NOT dispatched for the mailbox pane by this table. They live
 * in `DASHBOARD_KEYS.mailbox` for reservation and are resolved by the mailbox
 * overlays' own input handling — since M2-1 through the sibling `overlay:*`
 * keyspace (`OVERLAY_KEYS["mailbox-detail"]` / `OVERLAY_KEYS["mailbox-compose"]`),
 * never by `dashboardActionForKey`. The `plan` group reuses uppercase "A"
 * (approve) pane-scoped to "progress" — it never fires while the mailbox pane
 * (or the mailbox-detail overlay) owns input, so `mailbox.ack` behavior is
 * unchanged.
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
	// Tier A: schedules-pane action keys (pane 8). ALL pane-scoped so they
	// never leak into other panes. Collision analysis (explorer-verified):
	//   T — unbound elsewhere; N — mailbox.nudge is overlay-owned, NOT dispatched
	//   here; X — plan.diff is plan-scoped, mailbox.ackAll overlay-owned; R —
	//   health.recovery is health-scoped; V — COLLIDES with the unscoped root
	//   liveConversation ["V"]: this entry MUST stay above it (first-match-wins
	//   pass-1 honors table order after paneScopeMatches), so V = details in
	//   the schedules pane and live-conversation everywhere else.
	{
		keys: DASHBOARD_KEYS.schedules.toggle,
		action: "schedule-toggle",
		pane: "schedules",
	},
	{
		keys: DASHBOARD_KEYS.schedules.runNow,
		action: "schedule-run-now",
		pane: "schedules",
	},
	{
		keys: DASHBOARD_KEYS.schedules.details,
		action: "schedule-details",
		pane: "schedules",
	},
	{
		keys: DASHBOARD_KEYS.schedules.delete,
		action: "schedule-delete",
		pane: "schedules",
	},
	{
		keys: DASHBOARD_KEYS.schedules.refresh,
		action: "schedule-refresh",
		pane: "schedules",
	},
	{
		keys: DASHBOARD_KEYS.plan.approve,
		action: "plan-approve",
		// WP-7: shared by the progress banner and the Plan pane (pane 7).
		pane: ["progress", "plan"],
	},
	{
		keys: DASHBOARD_KEYS.plan.deny,
		action: "plan-deny",
		pane: ["progress", "plan"],
	},
	{
		keys: DASHBOARD_KEYS.plan.diff,
		action: "plan-diff",
		pane: "plan",
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
	// Agents & Jobs browser (one-keypress overlay, mirrors live-conversation).
	// Collision analysis: "b" is unbound everywhere else — root-unscoped is
	// safe; inside the browser overlay itself "p" is free because overlays
	// are mutually exclusive (see keybinding-map.ts header note).
	{ keys: DASHBOARD_KEYS.root.browser, action: "browser" },
	// US-020: x → cancel the selected run (unscoped; the schedules pane's X
	// delete is pane-scoped uppercase — pass-1 exact match keeps them distinct).
	{ keys: DASHBOARD_KEYS.root.cancel, action: "cancel" },
	{ keys: DASHBOARD_KEYS.pane.agents, action: "pane-agents" },
	{ keys: DASHBOARD_KEYS.pane.progress, action: "pane-progress" },
	{ keys: DASHBOARD_KEYS.pane.mailbox, action: "pane-mailbox" },
	{ keys: DASHBOARD_KEYS.pane.output, action: "pane-output" },
	{ keys: DASHBOARD_KEYS.pane.health, action: "pane-health" },
	{ keys: DASHBOARD_KEYS.pane.metrics, action: "pane-metrics" },
	{ keys: DASHBOARD_KEYS.pane.plan, action: "pane-plan" },
	{ keys: DASHBOARD_KEYS.pane.schedules, action: "pane-schedules" },
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
	...Object.values(DASHBOARD_KEYS.plan).flat(),
	...Object.values(DASHBOARD_KEYS.schedules).flat(),
	...Object.values(DASHBOARD_KEYS.notification).flat(),
]);

export { KEY_RESERVED };

// ─── Overlay keybindings (P1-9 / M2-1) ─────────────────────────────────────
//
// Overlays used to hardcode their own key chains — the SAME
// "↑/↓/Enter/Esc" concept re-implemented in every overlay file, none of them
// remappable. M2-1 centralises them into an `overlay:<name>:<action>`
// keyspace that rides the SAME override pipeline as the dashboard table
// above: `.crew/config.json` → `keybindings` and `PI_CREW_KEYBINDINGS` both
// accept `"overlay:<name>:<action>": ["<key>", …]`, a colliding override is
// reverted to its default, and the revert is reported by
// `getKeybindingOverrideWarnings()`.
//
// Overlay bindings are validated INDEPENDENTLY of dashboard bindings: the two
// namespaces are never live at the same time (the host hands input to exactly
// one component — an open overlay or the dashboard), so a shared key such as
// `q`/`escape`/`A` is not a real ambiguity. Within one overlay a shared key IS
// ambiguous and is treated as a collision.

export const OVERLAY_KEYS = {
	"agent-picker": {
		close: ["escape", "q"],
		up: ["k", "up"],
		down: ["j", "down"],
		select: ["return"],
	},
	confirm: {
		confirm: ["y", "Y"],
		/** Enter is dual-role: the overlay resolves it with `defaultAction`. */
		submit: ["return"],
		cancel: ["n", "N", "escape", "q"],
	},
	"mailbox-detail": {
		close: ["escape", "q"],
		toggleSide: ["tab", "\t"],
		up: ["k", "up"],
		down: ["j", "down"],
		toggleDetail: ["return"],
		ack: ["A"],
		nudge: ["N"],
		compose: ["C"],
		ackAll: ["X"],
	},
	"mailbox-compose": {
		cancel: ["escape"],
		preview: ["P"],
		nextField: ["tab", "\t"],
		space: [" "],
		backspace: ["backspace"],
		submit: ["return"],
	},
} as const;

type OverlayDefs = typeof OVERLAY_KEYS;

/** Overlay namespaces that opt into the central keybinding map. */
export type OverlayName = keyof OverlayDefs;

/** Every action across every overlay (union). */
export type OverlayAction = { [N in OverlayName]: keyof OverlayDefs[N] & string }[OverlayName];

/** Actions of ONE overlay — the precise return type of `overlayActionForKey`. */
export type OverlayActionOf<N extends OverlayName> = keyof OverlayDefs[N] & string;

/** Override key as written in config/env: `overlay:<name>:<action>`. */
export type OverlayBindingKey = { [N in OverlayName]: `overlay:${N & string}:${keyof OverlayDefs[N] & string}` }[OverlayName];

/** A resolved overlay binding (one action of one overlay). */
export interface OverlayBinding {
	readonly overlay: OverlayName;
	readonly action: OverlayAction;
	readonly keys: readonly string[];
}

/** Compose the config/env override key for one overlay action. */
function overlayBindingKey(overlay: OverlayName, action: OverlayAction): OverlayBindingKey {
	return `overlay:${overlay}:${action}` as OverlayBindingKey;
}

// `Object.entries` widens the const-typed tables; this cast restores the exact
// shape (no `any`; the `OverlayBinding` annotation below still checks it).
type OverlayTableEntry = readonly [OverlayName, Readonly<Record<string, readonly string[]>>];

const OVERLAY_TABLE = Object.entries(OVERLAY_KEYS) as readonly OverlayTableEntry[];

/** Every valid `overlay:<name>:<action>` override key. */
const OVERLAY_BINDING_KEYS: ReadonlySet<string> = new Set(
	OVERLAY_TABLE.flatMap(([overlay, actions]) =>
		Object.keys(actions).map((action) => overlayBindingKey(overlay, action as OverlayAction)),
	),
);

const DEFAULT_OVERLAY_BINDINGS: ReadonlyMap<OverlayName, readonly OverlayBinding[]> = new Map<OverlayName, readonly OverlayBinding[]>(
	OVERLAY_TABLE.map(([overlay, actions]) => [
		overlay,
		Object.entries(actions).map(([action, keys]): OverlayBinding => ({ overlay, action: action as OverlayAction, keys })),
	]),
);

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

/** Override map: action → replacement keys. `Partial` ⇒ only listed actions.
 *  Keys are dashboard actions plus `overlay:<name>:<action>` binding keys. */
export type KeybindingOverride = Partial<Record<DashboardKeyAction | OverlayBindingKey, readonly string[]>>;

const KEYBINDINGS_ENV = "PI_CREW_KEYBINDINGS";

/** Every dispatched action + every `overlay:*` binding is a valid override target. */
export const VALID_OVERRIDE_ACTIONS: ReadonlySet<string> = new Set<string>([
	...DEFAULT_BINDINGS.map((b) => b.action),
	...OVERLAY_BINDING_KEYS,
]);

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
/** Pane scopes — a binding may fire in ONE pane, SEVERAL panes (WP-7: plan
 *  approval keys are shared by progress + plan panes), or every pane
 *  (undefined). */
export type PaneScope = ActivePane | readonly ActivePane[];

function paneScopeMatches(scope: PaneScope | undefined, pane: ActivePane | undefined): boolean {
	if (scope === undefined) return true;
	if (Array.isArray(scope)) return pane !== undefined && scope.includes(pane);
	return scope === pane;
}

function paneScopesCompatible(a: PaneScope | undefined, b: PaneScope | undefined): boolean {
	if (a === undefined || b === undefined) return true;
	const as = Array.isArray(a) ? a : [a];
	const bs = Array.isArray(b) ? b : [b];
	return as.some((x) => bs.includes(x));
}

interface EffectiveBindingsResult {
	readonly bindings: readonly KeyBinding[];
	/** Resolved bindings per overlay (defaults + non-colliding overrides). */
	readonly overlayBindings: ReadonlyMap<OverlayName, readonly OverlayBinding[]>;
	/** Override targets whose override was rejected due to a collision. */
	readonly reverted: readonly string[];
}

/**
 * Does `candidate` share a key with any `other` binding that could be live at
 * the same time? Shared by the dashboard and the overlay namespaces so the
 * collision rule (and its revert semantics) has ONE implementation.
 */
function collidesWithOthers<B extends { readonly keys: readonly string[]; readonly action: string }>(
	candidate: B,
	others: readonly B[],
	compatible: (a: B, b: B) => boolean,
): boolean {
	for (const other of others) {
		if (other.action === candidate.action) continue;
		if (!compatible(candidate, other)) continue;
		if (candidate.keys.some((k) => other.keys.includes(k))) return true;
	}
	return false;
}

/**
 * Apply `overrides` onto {@link DEFAULT_BINDINGS} + {@link DEFAULT_OVERLAY_BINDINGS}
 * (replace keys per target, preserving each binding's pane scope / overlay) and
 * detect collisions. A colliding override is reverted to its default so the
 * dispatch stays unambiguous. Dashboard and overlay namespaces are validated
 * separately (they are never live simultaneously).
 */
function computeEffectiveBindings(overrides: KeybindingOverride): EffectiveBindingsResult {
	// ── dashboard namespace (semantics unchanged since UI-2) ──
	const applied = new Map<DashboardKeyAction, KeyBinding>();
	for (const def of DEFAULT_BINDINGS) {
		const ov = overrides[def.action];
		applied.set(def.action, ov && ov.length > 0 ? { keys: [...ov], action: def.action, pane: def.pane } : def);
	}
	const effective = [...applied.values()];
	const reverted = new Set<string>();
	for (const def of DEFAULT_BINDINGS) {
		const ov = overrides[def.action];
		if (!ov || ov.length === 0) continue; // not overridden
		const ob = applied.get(def.action);
		if (!ob) continue;
		if (collidesWithOthers(ob, effective, (a, b) => paneScopesCompatible(a.pane, b.pane))) reverted.add(def.action);
	}
	const bindings =
		reverted.size > 0
			? effective.map((b) => (reverted.has(b.action) ? (DEFAULT_BINDINGS.find((d) => d.action === b.action) ?? b) : b))
			: effective;

	// ── overlay namespace (M2-1) ──
	const overlayBindings = new Map<OverlayName, readonly OverlayBinding[]>();
	for (const [overlay, defaults] of DEFAULT_OVERLAY_BINDINGS) {
		const perOverlay: OverlayBinding[] = defaults.map((def) => {
			const ov = overrides[overlayBindingKey(overlay, def.action)];
			return ov && ov.length > 0 ? { overlay, action: def.action, keys: [...ov] } : def;
		});
		for (const def of defaults) {
			const key = overlayBindingKey(overlay, def.action);
			const ov = overrides[key];
			if (!ov || ov.length === 0) continue; // not overridden
			const ob = perOverlay.find((b) => b.action === def.action);
			if (!ob) continue;
			// Same overlay ⇒ same input lineage ⇒ any shared key is ambiguous.
			if (collidesWithOthers(ob, perOverlay, () => true)) reverted.add(key);
		}
		if (reverted.size === 0) {
			overlayBindings.set(overlay, perOverlay);
			continue;
		}
		overlayBindings.set(
			overlay,
			perOverlay.map((b) =>
				reverted.has(overlayBindingKey(overlay, b.action)) ? (defaults.find((d) => d.action === b.action) ?? b) : b,
			),
		);
	}

	return { bindings, overlayBindings, reverted: [...reverted] };
}

/**
 * Read the `keybindings` section from the project config.
 *
 * RR-020 Fix 4: resolve via `projectCrewRoot(cwd)` instead of a literal
 * `<cwd>/.crew` — the config lives in whichever layout the project actually
 * uses (`.crew/` or `.pi/teams/`), so a `.pi/teams` project's keybinding
 * overrides are no longer silently ignored.
 */
function readConfigKeybindings(cwd: string): KeybindingOverride {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(projectCrewRoot(cwd), "config.json"), "utf-8"));
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
		// RR-020 Fix 4: same layout-resolved config path as readConfigKeybindings.
		return fs.statSync(path.join(projectCrewRoot(cwd), "config.json")).mtimeMs;
	} catch {
		return undefined;
	}
}

interface EffectiveCache {
	readonly env: string | undefined;
	readonly configMtime: number | undefined;
	readonly cwd: string;
	readonly bindings: readonly KeyBinding[];
	readonly overlayBindings: ReadonlyMap<OverlayName, readonly OverlayBinding[]>;
}

let _effectiveCache: EffectiveCache | null = null;
let _overrideWarnings: readonly string[] = [];

/**
 * Resolve the effective dispatch tables: {@link DEFAULT_BINDINGS} and
 * {@link DEFAULT_OVERLAY_BINDINGS} with config + env overrides applied (env
 * wins per target). Memoised on (env value, config mtime, cwd); a single
 * `statSync` per call detects on-disk config changes.
 */
function getEffectiveBindings(cwd: string = process.cwd()): readonly KeyBinding[] {
	const envRaw = getCrewEnv(KEYBINDINGS_ENV);
	const configMtime = configKeybindingsMtime(cwd);
	if (_effectiveCache && _effectiveCache.env === envRaw && _effectiveCache.configMtime === configMtime && _effectiveCache.cwd === cwd) {
		return _effectiveCache.bindings;
	}
	const merged: KeybindingOverride = { ...readConfigKeybindings(cwd), ...readEnvKeybindings() };
	const { bindings, overlayBindings, reverted } = computeEffectiveBindings(merged);
	_overrideWarnings = reverted.map((a) => `keybinding override for '${a}' collides with another binding — reverting to default`);
	_effectiveCache = { env: envRaw, configMtime, cwd, bindings, overlayBindings };
	return bindings;
}

/** Resolved overlay bindings for one overlay (defaults + non-colliding overrides). */
function getEffectiveOverlayBindings(overlay: OverlayName): readonly OverlayBinding[] {
	getEffectiveBindings(); // ensures the memo is warm + warnings are populated
	return _effectiveCache?.overlayBindings.get(overlay) ?? DEFAULT_OVERLAY_BINDINGS.get(overlay) ?? [];
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
		if (!paneScopeMatches(binding.pane, activePane)) continue;
		if (binding.keys.includes(data)) return binding.action;
	}
	// Pass 2 — terminal-aware match for escape sequences / canonical KeyIds.
	// Only reached when no exact ASCII match exists (data is e.g. '\x1b[A',
	// '\x1bOA', or an app-cursor-mode variant). Uses matchesKey() to normalize
	// legacy CSI, app-cursor-mode, and Kitty-protocol variants uniformly.
	const key = keyOf(data);
	for (const binding of BINDINGS) {
		if (!paneScopeMatches(binding.pane, activePane)) continue;
		for (const candidate of binding.keys) {
			if (key === candidate) return binding.action;
			if (matchesKey(data, candidate as KeyId)) return binding.action;
		}
	}
	return undefined;
}

/**
 * Resolve a raw input `data` string to an OVERLAY action (M2-1 / P1-9).
 *
 * Mirror image of {@link dashboardActionForKey} over the overlay keyspace:
 * same two-pass dispatch (case-sensitive exact match first, then the
 * terminal-aware `matchesKey` normalization), same override pipeline
 * (`.crew/config.json` → `keybindings["overlay:<name>:<action>"]`, then the
 * `PI_CREW_KEYBINDINGS` env var, collision → revert to default).
 *
 * With no override configured the result is identical to the key chains the
 * overlays used to hardcode (asserted by
 * `test/unit/ui/overlay-keybindings.test.ts`).
 *
 * @param overlay Overlay namespace, e.g. `"confirm"`.
 * @param data Raw key input (single char or escape sequence).
 */
export function overlayActionForKey<N extends OverlayName>(overlay: N, data: string): OverlayActionOf<N> | undefined {
	const bindings = getEffectiveOverlayBindings(overlay);
	// Pass 1 — exact, case-sensitive match (keeps "y"/"Y" and "A"/"a" distinct).
	for (const binding of bindings) {
		if (binding.keys.includes(data)) return binding.action as OverlayActionOf<N>;
	}
	// Pass 2 — escape-sequence / canonical KeyId normalisation.
	//
	// Single-character candidates are deliberately EXCLUDED here: pi-tui's
	// `matchesKey()` is case-INSENSITIVE for plain ASCII
	// (`matchesKey("a", "A") === true`), which would collapse the deliberate
	// case distinctions this keyspace relies on ("A"=ack vs lowercase "a"=free
	// text in mailbox-compose; "y"/"Y" in confirm). Pass 1 already matched
	// single chars exactly and case-sensitively, mirroring the pre-M2-1 chains
	// (`data === "A"`, `data === "P"`, …).
	const key = keyOf(data);
	for (const binding of bindings) {
		for (const candidate of binding.keys) {
			if (candidate.length === 1) continue;
			if (key === candidate) return binding.action as OverlayActionOf<N>;
			if (matchesKey(data, candidate as KeyId)) return binding.action as OverlayActionOf<N>;
		}
	}
	return undefined;
}
