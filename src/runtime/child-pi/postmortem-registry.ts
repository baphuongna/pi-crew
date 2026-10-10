/**
 * postmortem-registry.ts — U15: postmortem cleanup registry (pi-crew port).
 *
 * Ported from gajae-code `packages/utils/src/postmortem.ts` (fork pi-mono
 * v0.8.2, spec U15 of pi-crew-upgrade-spec-2026-10-09.md), reduced to the
 * ~80-line core pi-crew needs: reap still-live owned process groups on fatal
 * or normal shutdown. Owners deregister from this registry only AFTER their
 * teardown completed (owned-process.ts owns that discipline).
 *
 * Divergence from the gajae-code original (deliberate, reviewed against the
 * spec's "guest in host process" constraint):
 *   - The original OWNS its process: after cleanup it calls
 *     `process.exit(128+sig)` / `process.exit(1)`. pi-crew runs as an EXTENSION
 *     inside the pi host process (and standalone inside background-runner),
 *     where other pi-crew modules already register SIGINT/SIGTERM/SIGHUP/
 *     uncaught/unhandled listeners (event-log.ts, atomic-write.ts,
 *     crew-cleanup.ts, background-runner.ts) without forcing exit. Forcing
 *     exit here would race the host's own shutdown path, so this port NEVER
 *     calls process.exit — hooks reap best-effort while the real exit path
 *     drains, and the 'exit' listener fires a last sync-effort kick.
 *   - "run once per process" is relaxed to "concurrent runs share one
 *     in-flight promise" because a host can survive a SIGTERM-like signal and
 *     must stay re-armable; per-process once-only semantics are the caller's
 *     (owned groups deregister themselves after teardown, so a second run has
 *     nothing left to reap).
 *
 * Listener model (installed lazily on first registration):
 *   - exit                  → fire-and-forget async run (cannot await; hooks
 *                             whose sync prefix sends SIGTERM still deliver).
 *   - SIGINT/SIGTERM/SIGHUP → setImmediate kick (house pattern from
 *                             event-log.ts) so sync flush handlers run first.
 *   - uncaughtException/unhandledRejection → setImmediate kick, never swallow:
 *                             we add no output and no exit; existing pi-crew
 *                             fatal handlers already own crash reporting (and
 *                             already suppress Node's default, see event-log).
 */

import { logInternalError } from "../../utils/internal-error.ts";

export type PostmortemReason = "exit" | "SIGINT" | "SIGTERM" | "SIGHUP" | "uncaughtException" | "unhandledRejection" | "manual";

export type PostmortemHook = (reason: PostmortemReason) => void | Promise<void>;

// Registered hooks, keyed by owner name. Last-wins on re-registration (same
// discipline as gajae-code's resource-owner map): a re-adopt with the same name
// replaces the prior hook instead of accumulating duplicates.
const postmortemHooks = new Map<string, PostmortemHook>();

let listenersInstalled = false;
let inFlightRun: Promise<void> | undefined;

/**
 * Run every registered postmortem hook for `reason`. Concurrent invocations
 * share the single in-flight run (recursion/reentry guard); failures are
 * isolated per hook and logged, never propagated — one bad owner must not
 * block the others from reaping.
 */
export function runPostmortemCleanup(reason: PostmortemReason): Promise<void> {
	if (inFlightRun) return inFlightRun;
	inFlightRun = (async () => {
		try {
			await Promise.allSettled(
				[...postmortemHooks.entries()].map(async ([name, hook]) => {
					try {
						await hook(reason);
					} catch (err) {
						logInternalError(
							"child-pi.postmortem-hook",
							err instanceof Error ? err : new Error(String(err)),
							`name=${name} reason=${reason}`,
						);
					}
				}),
			);
		} finally {
			inFlightRun = undefined;
		}
	})();
	return inFlightRun;
}

/**
 * Register a postmortem cleanup hook. Idempotent by `name`: re-registering
 * replaces the prior hook (last wins). Returns an unregister function that
 * removes the owner only while it is still the active registration for that
 * name — a stale unregister cannot remove a newer registration.
 */
export function registerPostmortemCleanup(name: string, hook: PostmortemHook): () => void {
	postmortemHooks.set(name, hook);
	ensurePostmortemListeners();
	let unregistered = false;
	return () => {
		if (unregistered) return;
		unregistered = true;
		// Only remove when this exact hook is still the active registration —
		// guards the "late unregister must not evict a newer adopter" case.
		if (postmortemHooks.get(name) === hook) postmortemHooks.delete(name);
	};
}

/** Number of registered postmortem hooks. Exposed for leak assertions/tests. */
export function postmortemHookCount(): number {
	return postmortemHooks.size;
}

/** Install the process-level listeners exactly once, on first registration. */
function ensurePostmortemListeners(): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	// 'exit' is synchronous: an async hook can only run its sync prefix here
	// (e.g. signalTree("SIGTERM") inside dispose()) before the process dies.
	// The remaining escalation is covered owner-side while alive + child-side
	// by the PI_CREW_PARENT_PID guard (complementary per spec U15).
	process.on("exit", () => {
		void runPostmortemCleanup("exit");
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			setImmediate(() => {
				void runPostmortemCleanup(signal);
			});
		});
	}
	process.on("uncaughtException", () => {
		setImmediate(() => {
			void runPostmortemCleanup("uncaughtException");
		});
	});
	process.on("unhandledRejection", () => {
		setImmediate(() => {
			void runPostmortemCleanup("unhandledRejection");
		});
	});
}
