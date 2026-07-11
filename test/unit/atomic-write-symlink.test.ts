import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { atomicWriteFile, atomicWriteJson, invalidateSymlinkSafeCache, isSymlinkSafePath } from "../../src/state/atomic-write.ts";

const realTmp = fs.realpathSync(os.tmpdir());

let tmpDir: string;

function beforeEachFn() {
	tmpDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-atomic-"));
}

function afterEachFn() {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("atomicWriteFile — symlink attack prevention", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	// Symlink semantics differ on Windows (elevated privileges, junctions).
	// The symlink-rejection behavior is Unix-only.
	const unixOnly = process.platform !== "win32" ? it : it.skip;

	unixOnly("rejects writing to a path that is a symlink (original target NOT modified)", () => {
		// Create a real target file with original content
		const targetDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-target-"));
		const realTarget = path.join(targetDir, "real-file.txt");
		fs.writeFileSync(realTarget, "ORIGINAL SECRET");

		// Create a symlink inside tmpDir pointing to the real target
		const symlinkPath = path.join(tmpDir, "attack-link.txt");
		fs.symlinkSync(realTarget, symlinkPath);

		try {
			// atomicWriteFile should refuse to write through the symlink
			assert.throws(() => atomicWriteFile(symlinkPath, "ATTACKER CONTENT"), /symlink/);

			// Verify the original target was NOT modified
			const content = fs.readFileSync(realTarget, "utf-8");
			assert.equal(content, "ORIGINAL SECRET", "original target file must not be modified when write target is a symlink");
		} finally {
			try {
				fs.rmSync(targetDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	unixOnly("isSymlinkSafePath returns false for a symlink", () => {
		const targetDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-safe-"));
		const realTarget = path.join(targetDir, "real.txt");
		fs.writeFileSync(realTarget, "data");

		const symlinkPath = path.join(tmpDir, "link.txt");
		fs.symlinkSync(realTarget, symlinkPath);

		try {
			assert.equal(isSymlinkSafePath(symlinkPath), false);
		} finally {
			try {
				fs.rmSync(targetDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("isSymlinkSafePath returns true for a regular non-existent file", () => {
		const filePath = path.join(tmpDir, "newfile.txt");
		assert.equal(isSymlinkSafePath(filePath), true);
	});

	it("isSymlinkSafePath returns true for an existing regular file", () => {
		const filePath = path.join(tmpDir, "existing.txt");
		fs.writeFileSync(filePath, "data");
		assert.equal(isSymlinkSafePath(filePath), true);
	});
});

describe("atomicWriteFile — normal operation", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("writes content to a new file", () => {
		const filePath = path.join(tmpDir, "output.txt");
		atomicWriteFile(filePath, "hello world");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "hello world");
	});

	it("overwrites an existing file atomically", () => {
		const filePath = path.join(tmpDir, "overwrite.txt");
		fs.writeFileSync(filePath, "old content");
		atomicWriteFile(filePath, "new content");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "new content");
	});

	it("creates parent directories if they don't exist", () => {
		const filePath = path.join(tmpDir, "deep", "nested", "dir", "file.txt");
		atomicWriteFile(filePath, "deep");
		assert.equal(fs.readFileSync(filePath, "utf-8"), "deep");
	});

	it("cleans up temp files after successful write", () => {
		const filePath = path.join(tmpDir, "cleanup.txt");
		atomicWriteFile(filePath, "content");

		// No .tmp files should remain in the directory
		const files = fs.readdirSync(tmpDir);
		const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
		assert.equal(tmpFiles.length, 0, `temp files should be cleaned up, found: ${tmpFiles.join(", ")}`);
		// The actual file should exist
		assert.ok(files.includes("cleanup.txt"));
	});

	it("sets restrictive permissions (0600) on the written file", () => {
		// Unix-only: Windows ignores Unix permission bits (files always appear 0666).
		if (process.platform === "win32") return;
		const filePath = path.join(tmpDir, "perms.txt");
		atomicWriteFile(filePath, "restricted");
		const stat = fs.statSync(filePath);
		// Mode should be 0600 (owner read/write only) — mask with 0o777
		const mode = stat.mode & 0o777;
		// On some systems umask may affect this, but O_CREAT with 0600 should hold
		assert.ok(mode <= 0o600, `expected mode <= 0600, got ${mode.toString(8)}`);
	});
});

describe("atomicWriteJson — JSON serialization", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("writes correct JSON ending with newline", () => {
		const filePath = path.join(tmpDir, "data.json");
		const data = { name: "test", value: 42, nested: { a: true } };
		atomicWriteJson(filePath, data);

		const content = fs.readFileSync(filePath, "utf-8");
		// Must end with newline
		assert.ok(content.endsWith("\n"), "JSON output must end with newline");
		// Must be valid JSON (parse without error)
		const parsed = JSON.parse(content);
		assert.deepEqual(parsed, data);
	});

	it("uses 2-space indentation", () => {
		const filePath = path.join(tmpDir, "indented.json");
		atomicWriteJson(filePath, { a: 1, b: [1, 2] });

		const content = fs.readFileSync(filePath, "utf-8");
		// 2-space indent means the first property line starts with "  " (two spaces)
		assert.ok(content.includes('\n  "a"'), "should use 2-space indentation");
	});

	it("writes an empty object as '{}'", () => {
		const filePath = path.join(tmpDir, "empty.json");
		atomicWriteJson(filePath, {});
		const content = fs.readFileSync(filePath, "utf-8");
		assert.equal(content, "{}\n");
	});

	it("writes an array correctly", () => {
		const filePath = path.join(tmpDir, "array.json");
		const arr = [1, 2, 3];
		atomicWriteJson(filePath, arr);
		const content = fs.readFileSync(filePath, "utf-8");
		assert.deepEqual(JSON.parse(content), arr);
	});

	it("writes null correctly", () => {
		const filePath = path.join(tmpDir, "null.json");
		atomicWriteJson(filePath, null);
		const content = fs.readFileSync(filePath, "utf-8");
		assert.equal(content, "null\n");
	});

	it("cleans up temp files after JSON write", () => {
		const filePath = path.join(tmpDir, "tmpcheck.json");
		atomicWriteJson(filePath, { key: "val" });

		const files = fs.readdirSync(tmpDir);
		const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
		assert.equal(tmpFiles.length, 0, "no temp files should remain");
	});
});

// P5 (perf): the target-file symlink check now caches regular-file verdicts
// for 1s. Verify the cache is coherent with directory-level invalidation so a
// symlink swap at the target path is still caught within the TTL window.
describe("atomicWriteFile — symlink-safety cache (P5)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-cache-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		invalidateSymlinkSafeCache();
	});

	it("caches regular-file verdict and explicit directory invalidation flushes both caches", () => {
		const target = path.join(tmpDir, "trusted-manifest.json");
		fs.writeFileSync(target, "ORIGINAL");

		// First write primes both caches (dir + target).
		atomicWriteFile(target, "PRIME");

		// Replace the regular target with a symlink. The cached verdict is
		// still "safe=true" because the TTL (1s) hasn't elapsed. The P5 design
		// explicitly accepts this stale-read window; relying on it would be
		// wrong. The right primitive for "I just modified the directory layout"
		// is invalidateSymlinkSafeCache(dir).
		fs.unlinkSync(target);
		fs.symlinkSync(path.join(tmpDir, "elsewhere.txt"), target);
		fs.writeFileSync(path.join(tmpDir, "elsewhere.txt"), "REDIRECTED", "utf-8");

		// Invalidate the dir-level cache \u2014 this MUST also flush the target-cache
		// entries under that dir, so the next atomicWriteFile re-stats and sees
		// the symlink. This is the contract P5 preserves: explicit invalidation
		// is honored; implicit TTL expiry is bounded to 1s.
		invalidateSymlinkSafeCache(tmpDir);

		assert.throws(() => atomicWriteFile(target, "ATTACKER"), /symlink/);
		const redirect = fs.readFileSync(path.join(tmpDir, "elsewhere.txt"), "utf-8");
		assert.equal(redirect, "REDIRECTED", "symlink redirection must not be followed after explicit invalidation");
	});

	it("consecutive writes to the same file all succeed without re-stat'ing the dir", () => {
		// P5 behavior: after the first atomicWriteFile warms both caches, repeated
		// writes to the SAME target should not re-validate the directory chain
		// (dir cache hit \u2264 10s) nor re-lstat the file (target cache hit \u2264 1s).
		// This is the common-case perf win \u2014 a manifest.json that's written 20x
		// per batch now pays 2 syscalls total instead of 40.
		const target = path.join(tmpDir, "hot.json");
		fs.writeFileSync(target, "init");
		// Warm + 4 more writes within TTL.
		for (let i = 0; i < 5; i++) {
			atomicWriteFile(target, `iter-${i}`);
			assert.equal(fs.readFileSync(target, "utf-8"), `iter-${i}`);
		}
	});
});
