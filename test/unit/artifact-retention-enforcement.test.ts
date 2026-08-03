import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { isArtifactExpired, pruneExpiredArtifacts, TEMPORARY_RETENTION_TTL_MS } from "../../src/state/stores/artifact-store.ts";
import type { ArtifactDescriptor } from "../../src/state/types.ts";

/**
 * ST-10 tests: ArtifactDescriptor.retention/expiresAt enforcement.
 *
 * Artifacts whose descriptor indicates expiry (expiresAt passed or
 * temporary-retention TTL exceeded) must be deleted on prune.
 * Artifacts that are still valid must be preserved.
 */

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
const realTmp = fs.realpathSync(os.tmpdir());

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(realTmp, "pi-crew-st10-"));
}

function iso(offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString();
}

function makeDescriptor(filePath: string, overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
	return {
		kind: "log",
		path: filePath,
		createdAt: new Date().toISOString(),
		producer: "test",
		retention: "run",
		...overrides,
	};
}

test("ST-10: isArtifactExpired returns true when expiresAt is in the past", () => {
	const desc = makeDescriptor("/tmp/x", { expiresAt: iso(-60_000) });
	assert.equal(isArtifactExpired(desc, Date.now()), true);
});

test("ST-10: isArtifactExpired returns false when expiresAt is in the future", () => {
	const desc = makeDescriptor("/tmp/x", { expiresAt: iso(60_000) });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns false when no expiresAt and retention is 'run'", () => {
	const desc = makeDescriptor("/tmp/x", { retention: "run" });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns false when no expiresAt and retention is 'project'", () => {
	const desc = makeDescriptor("/tmp/x", { retention: "project" });
	assert.equal(isArtifactExpired(desc, Date.now()), false);
});

test("ST-10: isArtifactExpired returns true for 'temporary' retention past TTL", () => {
	const now = Date.now();
	const createdIso = new Date(now - TEMPORARY_RETENTION_TTL_MS - 1000).toISOString();
	const desc = makeDescriptor("/tmp/x", { retention: "temporary", createdAt: createdIso });
	assert.equal(isArtifactExpired(desc, now), true);
});

test("ST-10: isArtifactExpired returns false for 'temporary' retention within TTL", () => {
	const now = Date.now();
	const createdIso = new Date(now - 1000).toISOString(); // 1 second ago
	const desc = makeDescriptor("/tmp/x", { retention: "temporary", createdAt: createdIso });
	assert.equal(isArtifactExpired(desc, now), false);
});

test("ST-10: pruneExpiredArtifacts deletes files past expiresAt", () => {
	const dir = makeTmpDir();
	try {
		const expiredFile = path.join(dir, "expired.log");
		const validFile = path.join(dir, "valid.log");
		fs.writeFileSync(expiredFile, "old");
		fs.writeFileSync(validFile, "new");

		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(expiredFile, { expiresAt: iso(-60_000) }),
			makeDescriptor(validFile, { expiresAt: iso(60_000) }),
		];

		const deleted = pruneExpiredArtifacts(descriptors);
		assert.equal(deleted, 1);
		assert.equal(fs.existsSync(expiredFile), false);
		assert.equal(fs.existsSync(validFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts deletes 'temporary' retention artifacts past TTL", () => {
	const dir = makeTmpDir();
	try {
		const staleFile = path.join(dir, "stale-progress.log");
		const freshFile = path.join(dir, "fresh-progress.log");
		fs.writeFileSync(staleFile, "stale");
		fs.writeFileSync(freshFile, "fresh");

		const now = Date.now();
		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(staleFile, {
				retention: "temporary",
				createdAt: new Date(now - TEMPORARY_RETENTION_TTL_MS - 5000).toISOString(),
			}),
			makeDescriptor(freshFile, {
				retention: "temporary",
				createdAt: new Date(now - 1000).toISOString(),
			}),
		];

		const deleted = pruneExpiredArtifacts(descriptors, { now });
		assert.equal(deleted, 1);
		assert.equal(fs.existsSync(staleFile), false);
		assert.equal(fs.existsSync(freshFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts does NOT delete 'run' or 'project' retention without expiresAt", () => {
	const dir = makeTmpDir();
	try {
		const runFile = path.join(dir, "run.log");
		const projectFile = path.join(dir, "project.log");
		fs.writeFileSync(runFile, "run");
		fs.writeFileSync(projectFile, "project");

		// Create these long ago — age should NOT matter for run/project without expiresAt.
		const oldIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const descriptors: ArtifactDescriptor[] = [
			makeDescriptor(runFile, { retention: "run", createdAt: oldIso }),
			makeDescriptor(projectFile, { retention: "project", createdAt: oldIso }),
		];

		const deleted = pruneExpiredArtifacts(descriptors);
		assert.equal(deleted, 0);
		assert.equal(fs.existsSync(runFile), true);
		assert.equal(fs.existsSync(projectFile), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts handles missing files gracefully", () => {
	const dir = makeTmpDir();
	try {
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(path.join(dir, "does-not-exist.log"), { expiresAt: iso(-60_000) })];

		// Should not throw — best-effort.
		const deleted = pruneExpiredArtifacts(descriptors);
		assert.equal(deleted, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ST-10: pruneExpiredArtifacts with empty descriptor list is a no-op", () => {
	const deleted = pruneExpiredArtifacts([]);
	assert.equal(deleted, 0);
});

test("ST-10: pruneExpiredArtifacts respects custom temporaryTtlMs", () => {
	const dir = makeTmpDir();
	try {
		const file = path.join(dir, "temp.log");
		fs.writeFileSync(file, "temp");

		const now = Date.now();
		const created5sAgo = new Date(now - 5000).toISOString();
		const descriptors: ArtifactDescriptor[] = [makeDescriptor(file, { retention: "temporary", createdAt: created5sAgo })];

		// With a 10s TTL, 5s old is NOT expired.
		assert.equal(pruneExpiredArtifacts(descriptors, { now, temporaryTtlMs: 10_000 }), 0);
		assert.equal(fs.existsSync(file), true);

		// With a 3s TTL, 5s old IS expired.
		assert.equal(pruneExpiredArtifacts(descriptors, { now, temporaryTtlMs: 3_000 }), 1);
		assert.equal(fs.existsSync(file), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
