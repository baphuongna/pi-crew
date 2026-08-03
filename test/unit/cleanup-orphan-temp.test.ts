/**
 * Tests for orphan temp-dir cleanup functions in src/runtime/model/pi-args.ts.
 *
 * Covers:
 *   - cleanupTempDir (single dir)
 *   - cleanupAllTrackedTempDirs (in-memory Set)
 *   - cleanupOrphanTempDirs (Layer 4: user-tmp, age threshold, symlink, in-use)
 *   - cleanupLegacyOrphanTempDirs (Layer 5: /tmp, no-.crew/, age threshold)
 *
 * All tests use bounded baseDir to avoid touching real user state.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test_getTrackedTempDirs,
	__test_resetTrackedTempDirs,
	cleanupAllTrackedTempDirs,
	cleanupLegacyOrphanTempDirs,
	cleanupOrphanTempDirs,
	cleanupTempDir,
	createSafeTempDir,
} from "../../src/runtime/model/pi-args.ts";

function mkdtemp(prefix: string): string {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		dir = fs.realpathSync(dir);
	} catch {
		/* keep as-is */
	}
	return dir;
}

function touchDir(dir: string, ageMs: number): void {
	fs.mkdirSync(dir, { recursive: true });
	// Set mtime to (now - ageMs)
	const past = new Date(Date.now() - ageMs);
	fs.utimesSync(dir, past, past);
}

function rmrf(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// === cleanupTempDir ===

test("cleanupTempDir removes the dir and untracks it", () => {
	const tmp = mkdtemp("pi-crew-test-cleanup-");
	const sub = path.join(tmp, "pi-crew-123-abc");
	touchDir(sub, 0);

	// Use the internal createSafeTempDir to add to tracked Set
	const tracked = createSafeTempDir(tmp, "pi-crew-tracked-");
	assert.ok(fs.existsSync(tracked), "tracked dir should exist");
	assert.ok(__test_getTrackedTempDirs().includes(tracked), "tracked dir should be in Set");

	cleanupTempDir(tracked);
	assert.ok(!fs.existsSync(tracked), "dir should be removed");
	assert.ok(!__test_getTrackedTempDirs().includes(tracked), "dir should be removed from Set");

	rmrf(tmp);
});

test("cleanupTempDir handles undefined and missing", () => {
	// Should not throw
	cleanupTempDir(undefined);
	cleanupTempDir("/nonexistent/path/that/does/not/exist");
});

// === cleanupAllTrackedTempDirs ===

test("cleanupAllTrackedTempDirs removes every tracked dir", () => {
	__test_resetTrackedTempDirs();
	const tmp = mkdtemp("pi-crew-test-all-");
	const a = createSafeTempDir(tmp, "pi-crew-a-");
	const b = createSafeTempDir(tmp, "pi-crew-b-");
	const c = createSafeTempDir(tmp, "pi-crew-c-");

	assert.equal(__test_getTrackedTempDirs().length, 3);

	const result = cleanupAllTrackedTempDirs();
	assert.equal(result.cleaned, 3);
	assert.equal(result.failed, 0);
	assert.equal(__test_getTrackedTempDirs().length, 0);
	assert.ok(!fs.existsSync(a));
	assert.ok(!fs.existsSync(b));
	assert.ok(!fs.existsSync(c));

	rmrf(tmp);
});

// === cleanupOrphanTempDirs ===

test("cleanupOrphanTempDirs removes dirs older than 24h", () => {
	__test_resetTrackedTempDirs();
	const base = mkdtemp("pi-crew-test-orphan-");
	const now = Date.now();

	// Old dir (25h) - should be cleaned
	const old = path.join(base, "pi-crew-999-old");
	touchDir(old, 25 * 60 * 60 * 1000);

	// Fresh dir (1h) - should be kept
	const fresh = path.join(base, "pi-crew-888-fresh");
	touchDir(fresh, 1 * 60 * 60 * 1000);

	// Non-pi-crew dir - should be ignored
	const other = path.join(base, "not-pi-crew");
	touchDir(other, 25 * 60 * 60 * 1000);

	const result = cleanupOrphanTempDirs(now, base);
	assert.equal(result.scanned, 2, "only pi-crew-* dirs scanned");
	assert.equal(result.cleaned, 1, "only old pi-crew dir cleaned");
	assert.equal(result.failed, 0);

	assert.ok(!fs.existsSync(old), "old dir removed");
	assert.ok(fs.existsSync(fresh), "fresh dir kept");
	assert.ok(fs.existsSync(other), "non-pi-crew dir untouched");

	rmrf(base);
});

test("cleanupOrphanTempDirs skips symlinks (security)", () => {
	if (process.platform === "win32") {
		// Symlinks require elevated privileges on Windows; skip.
		return;
	}
	__test_resetTrackedTempDirs();
	const base = mkdtemp("pi-crew-test-symlink-");
	const realDir = mkdtemp("pi-crew-real-");
	const now = Date.now();

	// Create a symlink that LOOKS old but points to a real dir
	const symlinkPath = path.join(base, "pi-crew-evil-link");
	fs.symlinkSync(realDir, symlinkPath, "dir");
	// Set mtime on the symlink (not the target) to make it look old
	const past = new Date(now - 25 * 60 * 60 * 1000);
	try {
		fs.utimesSync(symlinkPath, past, past);
	} catch {
		// Some platforms don't allow utimes on symlinks; skip test
		rmrf(base);
		rmrf(realDir);
		return;
	}

	const result = cleanupOrphanTempDirs(now, base);
	assert.equal(result.cleaned, 0, "symlink must not be rmSync'd");
	assert.ok(fs.existsSync(symlinkPath), "symlink preserved");
	assert.ok(fs.existsSync(realDir), "real dir preserved");

	rmrf(base);
	rmrf(realDir);
});

test("cleanupOrphanTempDirs skips dirs in tracked Set (in-use)", () => {
	__test_resetTrackedTempDirs();
	const base = mkdtemp("pi-crew-test-inuse-");
	const now = Date.now();
	const tracked = createSafeTempDir(base, "pi-crew-");

	// Make it look old
	const past = new Date(now - 25 * 60 * 60 * 1000);
	fs.utimesSync(tracked, past, past);

	const result = cleanupOrphanTempDirs(now, base);
	assert.equal(result.cleaned, 0, "tracked dir must not be cleaned");
	assert.ok(fs.existsSync(tracked), "tracked dir preserved");

	rmrf(base);
});

test("cleanupOrphanTempDirs handles missing base dir", () => {
	const result = cleanupOrphanTempDirs(Date.now(), "/nonexistent/path/xyz");
	assert.equal(result.scanned, 0);
	assert.equal(result.cleaned, 0);
});

test("cleanupOrphanTempDirs caps at batch size (50)", () => {
	__test_resetTrackedTempDirs();
	const base = mkdtemp("pi-crew-test-batch-");
	const now = Date.now();
	const past = new Date(now - 25 * 60 * 60 * 1000);

	// Create 60 old dirs
	for (let i = 0; i < 60; i++) {
		const d = path.join(base, `pi-crew-${i.toString().padStart(3, "0")}`);
		fs.mkdirSync(d, { recursive: true });
		fs.utimesSync(d, past, past);
	}

	const result = cleanupOrphanTempDirs(now, base);
	assert.equal(result.scanned, 50, "capped at 50 per call");
	assert.equal(result.cleaned, 50);

	// 10 remain
	const remaining = fs.readdirSync(base).filter((n) => n.startsWith("pi-crew-"));
	assert.equal(remaining.length, 10);

	rmrf(base);
});

// === cleanupLegacyOrphanTempDirs ===

test("cleanupLegacyOrphanTempDirs removes /tmp/pi-crew-* dirs without .crew/", () => {
	const base = mkdtemp("pi-crew-test-legacy-");
	const now = Date.now();

	const old = path.join(base, "pi-crew-111-old");
	touchDir(old, 25 * 60 * 60 * 1000);

	const withCrew = path.join(base, "pi-crew-222-withcrew");
	touchDir(withCrew, 25 * 60 * 60 * 1000);
	fs.mkdirSync(path.join(withCrew, ".crew"), { recursive: true });

	const fresh = path.join(base, "pi-crew-333-fresh");
	touchDir(fresh, 1 * 60 * 60 * 1000);

	const result = cleanupLegacyOrphanTempDirs(now, base);
	assert.equal(result.scanned, 3);
	assert.equal(result.cleaned, 1, "only old non-crew dir cleaned");
	assert.equal(result.failed, 0);

	assert.ok(!fs.existsSync(old), "old dir removed");
	assert.ok(fs.existsSync(withCrew), "with-crew dir preserved (Layer 3 handles it)");
	assert.ok(fs.existsSync(fresh), "fresh dir preserved");

	rmrf(base);
});

test("cleanupLegacyOrphanTempDirs handles missing base dir", () => {
	const result = cleanupLegacyOrphanTempDirs(Date.now(), "/nonexistent/xyz");
	assert.equal(result.scanned, 0);
	assert.equal(result.cleaned, 0);
});
