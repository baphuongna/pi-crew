/**
 * Crash-recovery lazy import + sync purge helper.
 *
 * The session_start handler needs `cancelOrphanedRuns` and
 * `purgeStaleActiveRunIndex` from runtime/crash-recovery.ts, but that
 * module is ~14 KB and only relevant on the orphan-cleanup path.
 *
 * `importCrashRecovery` defers the actual `import()` until first use,
 * caches the result on a module-level slot, and `purgeStaleActiveRunIndexSyncIfLoaded`
 * fires the purge only if the cache has been populated (cleanup runs
 * synchronously and may not have triggered the lazy import yet).
 *
 * Module-level cache is intentional: it survives across multiple
 * `registerPiTeams` calls during dev hot-reload, so we don't reload
 * the heavy crash-recovery module on every reload.
 */
import type {
	cancelOrphanedRuns as CancelOrphanedRunsFn,
	detectInterruptedRuns as DetectInterruptedRunsFn,
	purgeStaleActiveRunIndex as PurgeStaleActiveRunIndexFn,
} from "../../runtime/crash-recovery.ts";
import { logInternalError } from "../../utils/internal-error.ts";

export type CrashRecoveryCache = {
	cancelOrphanedRuns: typeof CancelOrphanedRunsFn;
	detectInterruptedRuns: typeof DetectInterruptedRunsFn;
	purgeStaleActiveRunIndex: typeof PurgeStaleActiveRunIndexFn;
};

let _cachedCrashRecovery: CrashRecoveryCache | undefined;

/** Lazy-import crash-recovery. Cached after first call. */
export async function importCrashRecovery(): Promise<CrashRecoveryCache> {
	if (!_cachedCrashRecovery) {
		// LAZY: defer crash-recovery (~14 KB) until session_start cleanup runs.
		const mod = await import("../../runtime/crash-recovery.ts");
		_cachedCrashRecovery = {
			cancelOrphanedRuns: mod.cancelOrphanedRuns,
			detectInterruptedRuns: mod.detectInterruptedRuns,
			purgeStaleActiveRunIndex: mod.purgeStaleActiveRunIndex,
		};
	}
	return _cachedCrashRecovery;
}

/** Sync purge-if-loaded helper used by cleanup functions. */
export function purgeStaleActiveRunIndexSyncIfLoaded(): void {
	if (!_cachedCrashRecovery) return;
	try {
		_cachedCrashRecovery.purgeStaleActiveRunIndex();
	} catch (error) {
		logInternalError("register.cleanupRuntime.purgeStale", error);
	}
}
