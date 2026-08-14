import type { FSWatcher, WatchListener } from "node:fs";
import * as fs from "node:fs";

/**
 * Filesystem watcher helpers (slimmed down — pts/2 hang fix 2026-06-16).
 *
 * The recursive-watcher helpers (createRecursiveWatcher / watchCrewState /
 * runIdFromStateRelativePath) were REMOVED: a recursive fs.watch on the run
 * state tree exploded to O(total run history) inotify watches on Linux and
 * caused a permanent interactive-session busy-loop. The bounded
 * {@link RunWatcherRegistry} (one non-recursive watcher per ACTIVE run) now
 * replaces them. Only the two primitives below survive — they are still used by
 * manifest-cache and run-watcher-registry.
 */

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

export function watchWithErrorHandler(path: string, listener: WatchListener<string>, onError: (error?: unknown) => void): FSWatcher | null {
	try {
		const watcher = fs.watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch (error) {
		onError(error);
		return null;
	}
}
