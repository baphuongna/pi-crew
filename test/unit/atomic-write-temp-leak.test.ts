import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { atomicWriteFile, invalidateSymlinkSafeCache } from "../../src/state/atomic-write.ts";

// ST-7 regression test: `atomicWriteFile` (sync path) used to leak the temp
// file when rename failed. The finally cleanup was gated on `fd !== undefined`,
// but `fd` was cleared (set to undefined) right after the successful close —
// BEFORE the rename attempt — so the guard skipped `rmSync(tempPath)` on a
// rename failure, orphaning the `*.tmp` file.
//
// We trigger a real, deterministic rename failure WITHOUT mocking (the `node:fs`
// ESM namespace is frozen and cannot be monkey-patched): renaming a file onto an
// existing directory throws EISDIR, which is non-retryable, so `renameWithLinkSync`
// gives up immediately and propagates the error through the rename-failure path.

const realTmp = fs.realpathSync(os.tmpdir());

let tmpDir: string;

function beforeEachFn(): void {
	tmpDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-st7-leak-"));
	// Defensive: the symlink-safety cache may carry a verdict for a recycled
	// path. The tmpdir is fresh each run, so this just avoids cross-test bleed.
	invalidateSymlinkSafeCache();
}

function afterEachFn(): void {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

/** Return any leftover `*.tmp` files left inside `dir`. */
function leftoverTmpFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
}

// Symlink / directory-rename semantics differ on Windows. The EISDIR
// rename-failure scenario is Unix-only; success-path sanity runs everywhere.
const unixOnly = process.platform !== "win32" ? it : it.skip;

describe("atomicWriteFile — temp file cleanup on rename failure (ST-7)", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	unixOnly("cleans up the temp file when rename fails (no leftover *.tmp)", () => {
		// Make the TARGET a directory → rename(tempFile, dir) throws EISDIR.
		const target = path.join(tmpDir, "output.json");
		fs.mkdirSync(target);

		// atomicWriteFile must surface the rename failure.
		assert.throws(() => atomicWriteFile(target, "hello world\n"), /EISDIR/);

		// The fix: the temp file must be gone even though fd was already undefined
		// when the rename failed (the pre-fix code skipped cleanup here).
		const leaked = leftoverTmpFiles(tmpDir);
		assert.deepEqual(leaked, [], `temp file leaked on rename failure: ${leaked.join(", ")}`);
	});

	unixOnly("cleans up the temp file on rename failure at a nested path", () => {
		// Same scenario but the target lives in a freshly mkdir'd sub-tree, which
		// also exercises the mkdirSync(dirPath, { recursive: true }) prelude.
		fs.mkdirSync(path.join(tmpDir, "sub", "deep"), { recursive: true });
		const target = path.join(tmpDir, "sub", "deep", "out.json");
		fs.mkdirSync(target); // directory target → EISDIR on rename

		assert.throws(() => atomicWriteFile(target, "payload\n"), /EISDIR/);

		const leaked = leftoverTmpFiles(path.join(tmpDir, "sub", "deep"));
		assert.deepEqual(leaked, [], `temp file leaked on nested rename failure: ${leaked.join(", ")}`);
	});
});

describe("atomicWriteFile — temp cleanup does not regress on success (ST-7)", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("leaves no leftover temp file after a successful rename", () => {
		const target = path.join(tmpDir, "ok.json");
		atomicWriteFile(target, "content\n");

		assert.equal(fs.readFileSync(target, "utf-8"), "content\n");
		assert.deepEqual(leftoverTmpFiles(tmpDir), [], "unexpected leftover temp file on success");
	});

	it("overwriting an existing file leaves no leftover temp", () => {
		const target = path.join(tmpDir, "rewrite.json");
		atomicWriteFile(target, "first\n");
		atomicWriteFile(target, "second\n");

		assert.equal(fs.readFileSync(target, "utf-8"), "second\n");
		assert.deepEqual(leftoverTmpFiles(tmpDir), [], "unexpected leftover temp file on overwrite");
	});
});
