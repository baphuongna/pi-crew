import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CLEANUP_MARKER_FILE, cleanupOldArtifacts, writeCleanupMarker } from "../../src/state/stores/artifact-store.ts";

function makeDir(): string {
	// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
	// atomicWriteFile refuses to write through untrusted symlink paths.
	const realTmp = fs.realpathSync(os.tmpdir());
	return fs.mkdtempSync(path.join(realTmp, "pi-crew-artifact-cleanup-"));
}

test("cleanup removes old files but keeps new files", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		const newFile = path.join(dir, "new.txt");
		fs.writeFileSync(oldFile, "old");
		fs.writeFileSync(newFile, "new");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		const newMs = Date.now() - 1 * 60 * 1000;
		fs.utimesSync(newFile, newMs / 1000, newMs / 1000);
		cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 0 });
		assert.equal(fs.existsSync(oldFile), false);
		assert.equal(fs.existsSync(newFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh marker skips cleanup", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		fs.writeFileSync(oldFile, "old");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		writeCleanupMarker(dir, CLEANUP_MARKER_FILE);
		cleanupOldArtifacts(dir, {
			maxAgeDays: 1,
			scanGraceMs: 24 * 60 * 60 * 1000,
		});
		assert.equal(fs.existsSync(oldFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("stale marker triggers cleanup and updates marker", () => {
	const dir = makeDir();
	try {
		const oldFile = path.join(dir, "old.txt");
		fs.writeFileSync(oldFile, "old");
		const oldMs = Date.now() - 2 * 24 * 60 * 60 * 1000;
		fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);
		writeCleanupMarker(dir, CLEANUP_MARKER_FILE);
		const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
		const markerBefore = fs.statSync(markerPath).mtimeMs;
		const stale = Date.now() - 48 * 60 * 60 * 1000;
		fs.utimesSync(markerPath, stale / 1000, stale / 1000);
		cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 1000 });
		assert.equal(fs.existsSync(oldFile), false);
		const markerAfter = fs.statSync(markerPath).mtimeMs;
		assert.ok(markerAfter >= markerBefore);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("missing directory is no-op", () => {
	const dir = path.join(os.tmpdir(), `pi-crew-artifact-cleanup-missing-${Date.now()}`);
	cleanupOldArtifacts(dir, { maxAgeDays: 1, scanGraceMs: 0 });
	assert.equal(fs.existsSync(dir), false);
});
