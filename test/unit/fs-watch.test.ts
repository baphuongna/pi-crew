import assert from "node:assert/strict";
import test from "node:test";
import { closeWatcher, watchWithErrorHandler } from "../../src/utils/fs-watch.ts";

test("closeWatcher handles null input", () => {
	closeWatcher(null);
});

test("watchWithErrorHandler invokes fallback when fs.watch throws", () => {
	let onErrorCalled = false;
	const nonExistent = `/tmp/pi-crew-watch-missing-${Date.now()}`;
	const watcher = watchWithErrorHandler(
		nonExistent,
		() => undefined,
		() => {
			onErrorCalled = true;
		},
	);
	assert.equal(watcher, null, "expected null watcher for a missing dir");
	assert.equal(onErrorCalled, true, "expected onError to be called");
});

// NOTE: createRecursiveWatcher / watchCrewState / runIdFromStateRelativePath
// were REMOVED (pts/2 hang fix) — the recursive watcher exploded to O(run
// history) inotify watches on Linux. The bounded RunWatcherRegistry replaces
// them; see test/unit/run-watcher-registry.test.ts. closeWatcher and
// watchWithErrorHandler are retained (still used by manifest-cache,
// result-watcher, and run-watcher-registry).
