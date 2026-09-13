/**
 * Tier D (schedules UI): bridge ScheduleChangeEvent → terminal-status toasts.
 *
 * Bounded like the hung-notice pattern (foreground-watchdog): at most ONE
 * notice per event, no drip. Mapping (approved design):
 *   • fired  → `⏰ <name> fired → <agentId>`            (info)
 *   • error  → `⏰ scheduled job <jobId> failed: …`     (error — red)
 *   • run completion is NOT an event of its own — it surfaces as an `updated`
 *     event whose job.lastStatus transitions INTO "success" (tracked per job,
 *     the "if trackable" clause), so repeated `updated` emissions
 *     (enable/disable patches, runCount bumps) stay silent.
 *   • run FAILURE has two producers: the scheduler's synchronous `error`
 *     event (fire()'s catch) AND — the common path — the ASYNC executor
 *     rejection, which lifecycle-handlers records as an `updated` event whose
 *     lastStatus moves running→error with no `error` event at all. That
 *     transition gets the red `✗ failed` toast. A per-job `failedNotified`
 *     set de-dupes the two producers (fire() marks running → clears the flag;
 *     whichever failure notice lands first claims it) so a sync-throwing
 *     executor still yields exactly ONE notice per attempt.
 *
 * All interpolated fields pass through sanitizeLine (untrusted job fields
 * and LLM-derived error strings must never inject line breaks / control
 * chars into the terminal status area).
 *
 * Headless-safe: hasUI is probed defensively (the getter THROWS on a stale
 * context) and ui.notify failures are swallowed — the bridge is a no-op, never
 * a crash path, inside the scheduler's emit callback.
 */
import type { ScheduleChangeEvent } from "../../runtime/scheduling/scheduler.ts";
import { sanitizeLine } from "../../utils/visual.ts";

export interface ScheduleToastTarget {
	notify(text: string, level: "info" | "warning" | "error"): unknown;
}

export interface ScheduleToastDeps {
	/** hasUI probe — may throw on a stale ctx; a throw counts as "no UI". */
	hasUI(): boolean;
	ui: ScheduleToastTarget | undefined;
}

/** Error-toast payload cap: first line only, at most ~200 chars (toast
 * convention — tighter than the 800-char command text block). */
const ERROR_TEXT_MAX = 200;

export function createScheduleEventNotifier(deps: ScheduleToastDeps): (event: ScheduleChangeEvent) => void {
	/** Per-job lastStatus tracker — the "transition" memory for success toasts. */
	const lastStatusByJob = new Map<string, string | undefined>();
	/** Per-job "failure already noticed" marker — de-dupes the error-event and
	 *  running→error-transition producers so one failed attempt = one notice. */
	const failedNotified = new Set<string>();
	const deliver = (text: string, level: "info" | "error"): void => {
		try {
			if (!deps.hasUI() || !deps.ui) return;
			deps.ui.notify(text, level);
		} catch {
			/* toasts are best-effort — never break the scheduler path */
		}
	};
	return (event: ScheduleChangeEvent): void => {
		switch (event.type) {
			case "fired":
				deliver(`⏰ ${sanitizeLine(event.name)} fired → ${sanitizeLine(event.agentId)}`, "info");
				return;
			case "error": {
				// Sync producer (fire()'s catch / past-time once-job). Skipped only
				// when the running→error transition already claimed this attempt.
				if (failedNotified.has(event.jobId)) return;
				failedNotified.add(event.jobId);
				const firstLine = event.error.split("\n")[0] ?? "";
				const clipped = firstLine.length > ERROR_TEXT_MAX ? `${firstLine.slice(0, ERROR_TEXT_MAX - 1)}…` : firstLine;
				deliver(`⏰ scheduled job ${sanitizeLine(event.jobId)} failed: ${sanitizeLine(clipped)}`, "error");
				return;
			}
			case "added":
				// Persisted jobs re-register here at session start — record, never
				// toast (otherwise every session boot would spam one line per job).
				lastStatusByJob.set(event.job.id, event.job.lastStatus);
				return;
			case "updated": {
				const previous = lastStatusByJob.get(event.job.id);
				lastStatusByJob.set(event.job.id, event.job.lastStatus);
				// A new attempt underway: re-arm the failure notice for it.
				if (event.job.lastStatus === "running") {
					failedNotified.delete(event.job.id);
					return;
				}
				// Async executor rejection (lifecycle finalization path): running →
				// error with NO scheduler `error` event — the most common failure
				// route. Guarded on previous === "running" so a persisted
				// error-status re-registration (undefined/"error" → "error") stays
				// silent and cannot double-toast with the sync producer.
				if (event.job.lastStatus === "error" && previous === "running") {
					failedNotified.add(event.job.id);
					deliver(`⏰ ${sanitizeLine(event.job.name)} ✗ failed`, "error");
					return;
				}
				if (event.job.lastStatus === "success" && previous !== "success") {
					deliver(`⏰ ${sanitizeLine(event.job.name)} ✓ succeeded`, "info");
				}
				return;
			}
			case "removed":
				lastStatusByJob.delete(event.jobId);
				failedNotified.delete(event.jobId);
				return;
		}
	};
}
