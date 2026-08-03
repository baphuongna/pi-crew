import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveContainedPath, resolveContainedRelativePath, resolveRealContainedPath } from "../../../src/utils/safe-paths.ts";

const realTmp = fs.realpathSync(os.tmpdir());

let tmpBase: string;

function beforeEachFn() {
	tmpBase = fs.mkdtempSync(path.join(realTmp, "pi-crew-safepaths-"));
}

function afterEachFn() {
	try {
		fs.rmSync(tmpBase, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("resolveContainedPath — path traversal defense", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("rejects '../etc/passwd' (escapes baseDir)", () => {
		assert.throws(() => resolveContainedPath(tmpBase, "../etc/passwd"), /Path is outside/);
	});

	it("rejects absolute paths that escape the base dir", () => {
		assert.throws(() => resolveContainedPath(tmpBase, "/etc/passwd"), /Path is outside/);
	});

	it("rejects '/etc/shadow' absolute path", () => {
		assert.throws(() => resolveContainedPath(tmpBase, "/etc/shadow"), /Path is outside/);
	});

	it("accepts a valid contained relative path", () => {
		const result = resolveContainedPath(tmpBase, "subdir/file.txt");
		assert.equal(result, path.resolve(tmpBase, "subdir/file.txt"));
	});

	it("accepts a valid deeply-nested contained path", () => {
		const result = resolveContainedPath(tmpBase, "a/b/c/d.txt");
		assert.equal(result, path.resolve(tmpBase, "a/b/c/d.txt"));
	});

	it("rejects null-byte injection", () => {
		assert.throws(() => resolveContainedPath(tmpBase, "file\0.txt"), /null byte/);
	});

	it("rejects multi-level escape '../../../..'", () => {
		assert.throws(() => resolveContainedPath(tmpBase, "../../../../etc/passwd"), /Path is outside/);
	});
});

describe("resolveContainedRelativePath — relative path validation", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("rejects '../escape'", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "../escape", "file"), /Invalid file/);
	});

	it("rejects 'a/../../b' (escapes via nested ..)", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "a/../../b", "file"), /Invalid file/);
	});

	it("rejects absolute path '/etc/passwd'", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "/etc/passwd", "file"), /Invalid file/);
	});

	it("rejects a single '..' segment", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "..", "path"), /Invalid path/);
	});

	it("rejects null-byte injection", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "evil\0.txt", "file"), /null byte/);
	});

	it("rejects Windows-style drive letter 'C:\\evil'", () => {
		assert.throws(() => resolveContainedRelativePath(tmpBase, "C:\\evil", "file"), /Invalid file/);
	});

	it("accepts a valid relative path", () => {
		const result = resolveContainedRelativePath(tmpBase, "dir/file.txt", "file");
		assert.equal(result, path.resolve(tmpBase, "dir/file.txt"));
	});

	it("accepts a path that has '.' segments but no '..'", () => {
		// './foo' is normalized to 'foo' — should be accepted
		const result = resolveContainedRelativePath(tmpBase, "./foo/bar.txt", "file");
		assert.equal(result, path.resolve(tmpBase, "foo/bar.txt"));
	});
});

describe("resolveRealContainedPath — symlink rejection", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	// Symlink-based containment checks are Unix-only: Windows symlinks require
	// elevated privileges and behave differently, so the rejection semantics
	// can't be reliably asserted there. Skip the whole group on win32.
	const unixOnly = process.platform !== "win32" ? it : it.skip;

	unixOnly("rejects when the target path is a symlink to outside baseDir", () => {
		// Create an outside directory and a symlink inside baseDir pointing to it
		const outsideDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-outside-"));
		const outsideFile = path.join(outsideDir, "secret.txt");
		fs.writeFileSync(outsideFile, "secret");
		const linkPath = path.join(tmpBase, "evil-link");
		fs.symlinkSync(outsideFile, linkPath);

		try {
			assert.throws(() => resolveRealContainedPath(tmpBase, "evil-link"), /(outside|symlink)/i);
		} finally {
			try {
				fs.rmSync(outsideDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	unixOnly("rejects when an intermediate ancestor directory is a symlink to outside", () => {
		// Create an outside directory
		const outsideDir = fs.mkdtempSync(path.join(realTmp, "pi-crew-outside2-"));
		// Create a symlinked subdir inside baseDir that points outside
		const symlinkedSubdir = path.join(tmpBase, "linked-dir");
		fs.symlinkSync(outsideDir, symlinkedSubdir);

		try {
			assert.throws(() => resolveRealContainedPath(tmpBase, "linked-dir/file.txt"), /(outside|symlink)/i);
		} finally {
			try {
				fs.rmSync(outsideDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("accepts a normal non-symlink contained path", () => {
		// Create the file first so it exists
		const targetDir = path.join(tmpBase, "subdir");
		fs.mkdirSync(targetDir, { recursive: true });
		const targetFile = path.join(targetDir, "file.txt");
		fs.writeFileSync(targetFile, "content");

		const result = resolveRealContainedPath(tmpBase, "subdir/file.txt");
		assert.equal(result, fs.realpathSync(targetFile));
	});

	it("accepts a non-existent target file (for write operations)", () => {
		// The target doesn't exist yet — should return the resolved path
		const result = resolveRealContainedPath(tmpBase, "newdir/newfile.txt");
		assert.equal(result, path.resolve(tmpBase, "newdir/newfile.txt"));
	});

	it("rejects '../etc/passwd' (path traversal)", () => {
		assert.throws(() => resolveRealContainedPath(tmpBase, "../etc/passwd"), /Path is outside/);
	});

	it("rejects null-byte injection", () => {
		assert.throws(() => resolveRealContainedPath(tmpBase, "file\0.txt"), /null byte/);
	});
});

// Regression (macOS): the real bug only manifests on macOS where os.tmpdir()
// returns /var/folders/…/T and /var is an OS-managed symlink → /private/var.
// dwf-setresult CI failed because the base came in as /private/var/… (canonical)
// while the target kept the /var/… form, so the raw path.relative() check threw
// "Path is outside". resolveCanonicalPath normalizes both sides. This test
// reproduces the divergence on real macOS (where /var exists) and is skipped
// elsewhere.
const darwinOnly = process.platform === "darwin" ? it : it.skip;
darwinOnly("macOS: accepts a target reached via /var when base is the /private/var canonical form (dwf-setresult regression)", () => {
	// os.tmpdir() on macOS = /var/folders/…/T (symlink form).
	const symlinkForm = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-varreg-"));
	const canonicalForm = fs.realpathSync(symlinkForm); // /private/var/folders/…/T/…
	if (canonicalForm === symlinkForm) {
		// /var not a symlink on this macOS setup — nothing to assert here.
		fs.rmSync(symlinkForm, { recursive: true, force: true });
		return;
	}
	try {
		fs.mkdirSync(path.join(symlinkForm, "workflows"), {
			recursive: true,
		});
		const fileViaSymlink = path.join(symlinkForm, "workflows", "dwf.ts");
		fs.writeFileSync(fileViaSymlink, "export default async function(){}\n");
		// base uses the CANONICAL (/private/var) form; target uses the SYMLINK (/var) form.
		const baseCanonical = path.join(canonicalForm, "workflows");
		const result = resolveRealContainedPath(baseCanonical, fileViaSymlink);
		assert.equal(result, fs.realpathSync(fileViaSymlink), "target via /var must resolve when base is the /private/var canonical form");
	} finally {
		fs.rmSync(symlinkForm, { recursive: true, force: true });
	}
});
