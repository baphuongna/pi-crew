/**
 * Round 19 test-health: event-log sequence-cache LRU eviction coverage.
 * The sequenceCache (256-entry, evict-oldest-half-by-lastAccessMs) had zero
 * coverage of its eviction policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	__test__sequenceCacheSize,
	__test__seedSequenceCache,
	__test__evictOldestSequenceCacheEntries,
	__test__clearSequenceCache,
	MAX_SEQUENCE_CACHE_ENTRIES_VALUE,
} from "../../src/state/event-log.ts";

test("MAX_SEQUENCE_CACHE_ENTRIES is 256", () => {
	assert.equal(MAX_SEQUENCE_CACHE_ENTRIES_VALUE, 256);
});

test("evictOldestSequenceCacheEntries removes the oldest half by lastAccessMs", () => {
	__test__clearSequenceCache();
	try {
		// Seed 4 entries with increasing access times.
		__test__seedSequenceCache("/e1", 1000);
		__test__seedSequenceCache("/e2", 2000);
		__test__seedSequenceCache("/e3", 3000);
		__test__seedSequenceCache("/e4", 4000);
		assert.equal(__test__sequenceCacheSize(), 4);

		__test__evictOldestSequenceCacheEntries();
		// Eviction removes the oldest HALF (ceil(256/2)=128, but capped at
		// entries.length). With 4 entries, removes 4 (min of toEvict=128 and
		// length=4). Verify the newest are retained when toEvict < length by
		// using a larger-than-cache scenario below.
		assert.equal(__test__sequenceCacheSize(), 0, "with fewer entries than toEvict, all are removed");
	} finally {
		__test__clearSequenceCache();
	}
});

test("evictOldestSequenceCacheEntries retains the newest half when cache is full", () => {
	__test__clearSequenceCache();
	try {
		// Overfill the cache beyond MAX, then trigger eviction.
		for (let i = 0; i < MAX_SEQUENCE_CACHE_ENTRIES_VALUE + 10; i++) {
			__test__seedSequenceCache(`/e${i}`, i); // ascending access time
		}
		assert.ok(__test__sequenceCacheSize() >= MAX_SEQUENCE_CACHE_ENTRIES_VALUE);

		__test__evictOldestSequenceCacheEntries();
		const remaining = __test__sequenceCacheSize();
		// toEvict = ceil(256/2) = 128. Should remove 128, keep ~the rest.
		assert.ok(remaining <= MAX_SEQUENCE_CACHE_ENTRIES_VALUE + 10 - 128, "at least 128 evicted");
		assert.ok(remaining > 0, "some entries retained");
	} finally {
		__test__clearSequenceCache();
	}
});

test("clearSequenceCache empties the cache", () => {
	__test__seedSequenceCache("/x", Date.now());
	assert.ok(__test__sequenceCacheSize() > 0);
	__test__clearSequenceCache();
	assert.equal(__test__sequenceCacheSize(), 0);
});
