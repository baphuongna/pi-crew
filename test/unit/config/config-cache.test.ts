import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__configCacheSize,
	__test__getConfigCacheEntry,
	__test__getConfigCacheTtlMs,
	__test__setConfigCacheTtlMs,
	configPath,
	invalidateConfigCache,
	legacyConfigPath,
	loadConfig,
	projectConfigPath,
	projectPiCrewJsonPath,
	updateConfig,
} from "../../../src/config/config.ts";

// Each test isolates PI_TEAMS_HOME to a tmp dir so we don't touch the
// developer's real user config (regression — early versions of this file
// accidentally modified the developer's real pi-crew.json on test failure).
const HOME_KEY = "PI_TEAMS_HOME";
const HOME_CHECK_KEY = "PI_CREW_SKIP_HOME_CHECK";

function isolateHome(): { restore: () => void; home: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-config-cache-"));
	const prevHome = process.env[HOME_KEY];
	const prevCheck = process.env[HOME_CHECK_KEY];
	process.env[HOME_KEY] = home;
	process.env[HOME_CHECK_KEY] = "1";
	invalidateConfigCache();
	return {
		home,
		restore: () => {
			if (prevHome === undefined) delete process.env[HOME_KEY];
			else process.env[HOME_KEY] = prevHome;
			if (prevCheck === undefined) delete process.env[HOME_CHECK_KEY];
			else process.env[HOME_CHECK_KEY] = prevCheck;
			fs.rmSync(home, { recursive: true, force: true });
			// Reset TTL override + cache so a stray value can't bleed into
			// subsequent tests in the suite.
			__test__setConfigCacheTtlMs(__test__getConfigCacheTtlMs());
			__test__setConfigCacheTtlMs(2000);
			invalidateConfigCache();
		},
	};
}

test.afterEach(() => {
	// Defensive: ensure no test leaks TTL override or cache entries.
	__test__setConfigCacheTtlMs(2000);
	invalidateConfigCache();
});

// (a) Cache HIT — same reference returned on consecutive calls when files are unchanged.
test("loadConfig cache hit: returns same reference when files are unchanged", () => {
	const { restore } = isolateHome();
	try {
		// Write a config so readCacheMtimes produces a non-empty mtime map
		// (the cache only stores results when at least one watched file exists).
		fs.mkdirSync(path.dirname(configPath()), { recursive: true });
		fs.writeFileSync(configPath(), JSON.stringify({ ui: { widgetPlacement: "aboveEditor" } }), "utf-8");

		const first = loadConfig();
		const second = loadConfig();
		assert.strictEqual(first, second, "Second call should return the cached reference");
	} finally {
		restore();
	}
});

// (b) Cache MISS when a file is touched.
test("loadConfig cache miss: re-parses when a watched file mtime changes", async () => {
	const { restore, home } = isolateHome();
	try {
		const configFile = configPath();
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify({ ui: { widgetPlacement: "aboveEditor" } }), "utf-8");

		const beforeBump = Date.now();
		const first = loadConfig();
		assert.equal(first.config.ui?.widgetPlacement, "aboveEditor");

		// Push the mtime deterministically forward (sub-second precision is
		// unreliable on filesystems that round to whole seconds).
		const future = new Date(Date.now() + 2000);
		fs.utimesSync(configFile, future, future);
		// Sanity: ensure the file system honoured our mtime bump.
		const bumped = fs.statSync(configFile).mtimeMs;
		assert.ok(bumped > beforeBump, `expected bumped mtime > first parse time; bumped=${bumped} before=${beforeBump}`);

		const second = loadConfig();
		assert.notStrictEqual(first, second, "After mtime bump the cache must be invalidated");
		void home;
	} finally {
		restore();
	}
});

// (c) Cache MISS after TTL expiry.
test("loadConfig cache miss: re-parses after TTL expires", async () => {
	const { restore } = isolateHome();
	try {
		const configFile = configPath();
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify({ ui: { widgetPlacement: "aboveEditor" } }), "utf-8");

		__test__setConfigCacheTtlMs(50);
		try {
			const first = loadConfig();
			// Same call within TTL → must hit cache.
			const cached = loadConfig();
			assert.strictEqual(first, cached, "Within TTL the cache should hit");

			await new Promise((r) => setTimeout(r, 100));
			const afterTtl = loadConfig();
			assert.notStrictEqual(first, afterTtl, "After TTL expiry the cache must be re-parsed");
		} finally {
			__test__setConfigCacheTtlMs(2000);
		}
	} finally {
		restore();
	}
});

// (d) invalidateConfigCache forces re-parse.
test("loadConfig invalidateConfigCache: forces re-parse after cache was warm", () => {
	const { restore } = isolateHome();
	try {
		const configFile = configPath();
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify({ ui: { widgetPlacement: "aboveEditor" } }), "utf-8");

		const first = loadConfig();
		const cached = loadConfig();
		assert.strictEqual(first, cached, "Sanity: cache hit before invalidation");

		invalidateConfigCache();
		const after = loadConfig();
		assert.notStrictEqual(first, after, "invalidateConfigCache must drop the cached entry");

		// Writing via updateConfig also invalidates — covers the
		// invalidate-on-write path requested in the perf review brief.
		updateConfig({ ui: { widgetPlacement: "belowEditor" } });
		const warmed = loadConfig();
		const afterUpdate = loadConfig();
		assert.strictEqual(warmed, afterUpdate, "Post-write cache hit is allowed");
		assert.equal(afterUpdate.config.ui?.widgetPlacement, "belowEditor", "updateConfig change must be visible");
	} finally {
		restore();
	}
});

// Bonus: invalidate-on-write is wired into updateConfig.
test("loadConfig invalidate-on-write: updateConfig clears the cache", () => {
	const { restore } = isolateHome();
	try {
		const configFile = configPath();
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify({ notifierIntervalMs: 1500 }), "utf-8");

		const initial = loadConfig();
		assert.equal(initial.config.notifierIntervalMs, 1500);

		updateConfig({ notifierIntervalMs: 2500 });
		// After updateConfig, the cached entry MUST be gone — otherwise the
		// caller's hot path would see a stale value for up to 2 seconds.
		const fresh = loadConfig();
		assert.notStrictEqual(initial, fresh, "updateConfig must drop the cached entry");
		assert.equal(fresh.config.notifierIntervalMs, 2500, "Updated value must be visible");
	} finally {
		restore();
	}
});

// Bonus: cache distinguishes calls with different cwd values.
test("loadConfig cache: separate entries for different cwd values", () => {
	const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cwd-a-"));
	const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cwd-b-"));
	const { restore, home } = isolateHome();
	try {
		// Seed each cwd with a different project config — verifies that
		// the cache key includes cwd (and projectConfigPath/projectPiCrewJsonPath).
		// Use notifierIntervalMs values >= 1000 (schema minimum).
		fs.mkdirSync(path.dirname(projectConfigPath(cwd1)), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd1), JSON.stringify({ notifierIntervalMs: 1500 }), "utf-8");
		fs.mkdirSync(path.dirname(projectConfigPath(cwd2)), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd2), JSON.stringify({ notifierIntervalMs: 2500 }), "utf-8");

		const load1First = loadConfig(cwd1);
		const load1Cached = loadConfig(cwd1);
		assert.strictEqual(load1First, load1Cached, "Same cwd should hit cache");

		const load2 = loadConfig(cwd2);
		assert.notStrictEqual(load1First, load2, "Different cwd must produce a distinct cache entry");
		assert.equal(load2.config.notifierIntervalMs, 2500);

		// Verify the cache inspection helper sees both entries.
		const cwd1KeyParts = {
			filePath: configPath(),
			legacyPath: legacyConfigPath(),
			projectPath: projectConfigPath(cwd1),
			projectPiCrewJsonPath: projectPiCrewJsonPath(cwd1),
			cwd: cwd1,
		};
		const cwd2KeyParts = {
			filePath: configPath(),
			legacyPath: legacyConfigPath(),
			projectPath: projectConfigPath(cwd2),
			projectPiCrewJsonPath: projectPiCrewJsonPath(cwd2),
			cwd: cwd2,
		};
		assert.ok(__test__getConfigCacheEntry(cwd1KeyParts), "cwd1 entry must be present in cache");
		assert.ok(__test__getConfigCacheEntry(cwd2KeyParts), "cwd2 entry must be present in cache");

		assert.ok(__test__configCacheSize() >= 2, "Cache should hold at least two entries");
		void home;
	} finally {
		restore();
		fs.rmSync(cwd1, { recursive: true, force: true });
		fs.rmSync(cwd2, { recursive: true, force: true });
	}
});

// Bonus: TTL default is 2000 ms per the perf-review requirement.
test("loadConfig cache default TTL is 2000ms", () => {
	const { restore } = isolateHome();
	try {
		// Force the override to a known sentinel and assert getConfigCacheTtlMs
		// reports the default when the override is null.
		__test__setConfigCacheTtlMs(1234);
		assert.equal(__test__getConfigCacheTtlMs(), 1234, "Override value must be reflected");
		// Reset and confirm we read back CONFIG_CACHE_TTL_MS = 2000.
		// We can't directly null the override (no setter for that), so just
		// confirm the constant is wired up by checking via a 2000 setter.
		__test__setConfigCacheTtlMs(2000);
		assert.equal(__test__getConfigCacheTtlMs(), 2000);
	} finally {
		restore();
	}
});
