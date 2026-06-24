/**
 * HB-002 Windows test: EBUSY rename retry (round-10 / atomic-write).
 *
 * Windows returns EBUSY/EPERM/ENOTEMPTY during `fs.renameSync` far more often
 * than Unix (antivirus, file indexer, SMB). `renameWithRetry` exists exactly
 * for this. On Unix the retry path is rarely exercised, so this test
 * self-skips off Windows — its assertions are only meaningful there.
 *
 * v0.9.3 lesson: a macOS-only grep difference passed Linux CI and was caught
 * only at publish time. The same risk applies here in reverse — Windows-only
 * retry behavior must be verified on Windows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renameWithRetry } from "../../src/state/atomic-write.ts";

const isWindows = process.platform === "win32";

test("HB-002 Windows: renameWithRetry succeeds on a simple rename (Windows-only)", { skip: isWindows ? false : "Windows-only; run on windows-latest CI" }, () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-plat-win-"));
	try {
		const src = path.join(tmpRoot, "src.json");
		const dst = path.join(tmpRoot, "dst.json");
		fs.writeFileSync(src, "{}\n", "utf-8");
		// On Windows this is the retry path; on Unix it's a plain rename.
		// Either way it must not throw.
		renameWithRetry(src, dst);
		assert.ok(fs.existsSync(dst), "destination must exist after rename");
		assert.ok(!fs.existsSync(src), "source must be gone after rename");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("HB-002 Windows: renameWithRetry overwrites an existing destination", { skip: isWindows ? false : "Windows-only; run on windows-latest CI" }, () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-plat-win2-"));
	try {
		const src = path.join(tmpRoot, "src.json");
		const dst = path.join(tmpRoot, "dst.json");
		fs.writeFileSync(src, '{"v":2}\n', "utf-8");
		fs.writeFileSync(dst, '{"v":1}\n', "utf-8");
		renameWithRetry(src, dst);
		assert.equal(fs.readFileSync(dst, "utf-8").trim(), '{"v":2}', "destination must be overwritten");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});
