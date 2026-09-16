/**
 * Widget formatting utilities.
 *
 * Extracted from crew-widget.ts for reuse and testability.
 */

// module init; `notificationBadge`'s emoji decision consults
// `colorEnabled`, so `notificationBadge` emits a plain string when the
// mode is active.

function computeColorEnabled(): boolean {
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
	// Treat both `false` and `undefined` (piped/redirected/captured) as non-TTY:
	// color is only enabled when stdout is positively a TTY.
	if (process.stdout?.isTTY !== true) return false;
	return true;
}

let colorEnabled = computeColorEnabled();

/** Re-evaluate the color mode from the current env/stdout (repeat of init). */
export function __resetColorMode(): void {
	colorEnabled = computeColorEnabled();
}

/** Test-only: force the color mode into a known state. */
export function __setColorModeForTest(enabled: boolean): void {
	colorEnabled = enabled;
}

// ── Token formatting ──────────────────────────────────────────────────

export function formatTokensCompact(count: number): string {
	// Display-layer guard: state records have at least once carried the
	// literal "***" in a numeric field (redaction false-positive, fixed at
	// the source). A string here would print `*** tok` verbatim, so non-
	// numeric/undefined input renders as an empty metric instead.
	if (typeof count !== "number" || !Number.isFinite(count)) return "";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
	return `${count} tok`;
}

// ── Elapsed time ──────────────────────────────────────────────────────

export function elapsed(iso: string | undefined, now = Date.now()): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, now - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

// ── Notification badge ────────────────────────────────────────────────

// Bug 021: the bell glyph 🔔 was misread as "queued messages" — users saw
// `🔔227` and concluded there were 227 pending items, when the value is a
// CUMULATIVE warning/error/critical count with zero actual queue behind it.
// Fix: relabel to an explicit "alerts" segment (no bell) and cap the display
// at 99+ (standard badge practice). The cumulative count stays accurate
// internally (widgetState.notificationCount) and remains fully logged in
// .crew/state/notifications/YYYY-MM-DD.jsonl — this bounds presentation only.
// Deeper fixes (decay window, owner-scope, auto-reset on all-runs-terminal,
// full deprecation) are product decisions documented in
// docs/bugs/bug-021-notification-badge-counter-misleading.md.
export const NOTIFICATION_BADGE_CAP = 99;

export function notificationBadge(count: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!count || count <= 0) return "";
	const term = `${env.TERM ?? ""} ${env.WT_SESSION ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
	// UI-10: emoji is formatting too — gate it on the comprehensive color mode
	// (NO_COLOR / non-TTY) in addition to a per-call env NO_COLOR check (standard:
	// any non-empty value disables) and the dumb-terminal fallback.
	const envNoColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
	const supportsEmoji = colorEnabled && !envNoColor && !term.includes("dumb");
	const label = count > NOTIFICATION_BADGE_CAP ? `${NOTIFICATION_BADGE_CAP}+ alerts` : `${count} alerts`;
	return supportsEmoji ? ` · ${label}` : ` [${label}]`;
}
