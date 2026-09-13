/**
 * Pure relative-time formatter (dialect D6-T4): takes an INJECTED clock
 * (`now`) plus a target date — never reads `Date.now()`/`new Date()` itself.
 * Render paths must stay clock-free so tests can pin time and future
 * volatile-input tripwires see deterministic output.
 *
 * Ladder (both examples come from the approved schedules-UI design):
 *   |delta| < 60s  → "45s"
 *   |delta| < 2h   → "84m"
 *   |delta| < 48h  → "14h"
 *   |delta| ≥ 48h  → "2d14h" (zero-hour remainder collapses: "3d")
 * Future targets render "in X"; past targets render "X ago"; equal → "now".
 * Rounding is floor on each bucket.
 */
export function formatRelativeTime(now: Date, target: Date): string {
	const deltaMs = target.getTime() - now.getTime();
	if (deltaMs === 0) return "now";
	if (deltaMs > 0) return `in ${formatDurationCompact(deltaMs)}`;
	return `${formatDurationCompact(-deltaMs)} ago`;
}

function formatDurationCompact(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 120) return `${totalMinutes}m`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 48) return `${totalHours}h`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	if (hours === 0) return `${days}d`;
	return `${days}d${hours}h`;
}
