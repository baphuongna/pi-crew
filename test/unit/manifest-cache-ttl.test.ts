/**
 * Round 19 test-health: manifest-cache TTL eviction coverage.
 * Previously only LRU size-eviction was tested; the time-based expiry path
 * (setManifestCache evicts entries older than MANIFEST_CACHE_TTL_MS) had
 * zero coverage.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ManifestCacheEntry } from "../../src/state/stores/state-store.ts";
import {
	__test__clearManifestCache,
	__test__getManifestCacheEntry,
	__test__manifestCacheSize,
	__test__setManifestCache,
	MANIFEST_CACHE_TTL_MS_VALUE,
} from "../../src/state/stores/state-store.ts";

function makeEntry(cachedAt: number): ManifestCacheEntry {
	return {
		manifest: {
			schemaVersion: 1,
			runId: "team_test",
			team: "t",
			status: "running",
			goal: "g",
			workspaceMode: "single",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			stateRoot: "/s",
			artifactsRoot: "/a",
			tasksPath: "/t",
			eventsPath: "/e",
			artifacts: [],
			cwd: "/c",
		},
		tasks: [],
		cachedAt,
		generation: 0,
	} as unknown as ManifestCacheEntry;
}

test("setManifestCache evicts entries older than the TTL on the next set", () => {
	__test__clearManifestCache();
	try {
		// Insert a fresh entry (within TTL).
		__test__setManifestCache("/run/fresh", makeEntry(Date.now()));
		assert.equal(__test__manifestCacheSize(), 1);

		// Insert a second entry, then backdate its cachedAt beyond the TTL.
		// (setManifestCache always stamps cachedAt=now, so we mutate the stored
		// entry directly to simulate an entry that has aged out.)
		__test__setManifestCache("/run/stale", makeEntry(Date.now()));
		const stored = __test__getManifestCacheEntry("/run/stale");
		assert.ok(stored, "entry should be in cache");
		stored!.cachedAt = Date.now() - MANIFEST_CACHE_TTL_MS_VALUE - 1000;

		// Now insert a third entry; the sweep should evict the stale one.
		__test__setManifestCache("/run/trigger", makeEntry(Date.now()));
		assert.ok(!__test__getManifestCacheEntry("/run/stale"), "stale (TTL-expired) entry must be evicted when a new entry is set");
		assert.ok(__test__getManifestCacheEntry("/run/fresh"), "fresh entry survives");
		assert.ok(__test__getManifestCacheEntry("/run/trigger"), "new entry present");
	} finally {
		__test__clearManifestCache();
	}
});

test("setManifestCache keeps entries within the TTL", () => {
	__test__clearManifestCache();
	try {
		__test__setManifestCache("/run/young", makeEntry(Date.now()));
		__test__setManifestCache("/run/another", makeEntry(Date.now()));
		assert.ok(__test__getManifestCacheEntry("/run/young"), "young entry not evicted");
		assert.ok(__test__getManifestCacheEntry("/run/another"), "young entry not evicted");
	} finally {
		__test__clearManifestCache();
	}
});

test("MANIFEST_CACHE_TTL_MS is a sane positive value (60s)", () => {
	assert.ok(MANIFEST_CACHE_TTL_MS_VALUE > 0);
	assert.equal(MANIFEST_CACHE_TTL_MS_VALUE, 60_000);
});
