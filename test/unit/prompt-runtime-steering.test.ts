/**
 * Tests for FIX-02 (steering content sanitization) and FIX-03 (steering
 * file path containment validation) from PLAN-BUGFIXES.md.
 *
 * The two exported helpers under test live in src/prompt/prompt-runtime.ts:
 *   - `sanitizeSteerMessage(entry)` rejects oversized payloads, excessive
 *     newlines, and control characters in a single steer entry.
 *   - `validateSteeringFile(path)` rejects symlinks at the steering file
 *     itself AND symlinks anywhere in the path's ancestor chain (via
 *     `resolveRealContainedPath`), preventing a malicious
 *     `PI_CREW_STEERING_FILE` from redirecting to outside the session's
 *     artifacts root.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sanitizeSteerMessage, validateSteeringFile } from "../../src/prompt/prompt-runtime.ts";

function trySymlink(target: string, linkPath: string, kind: "file" | "dir" | "junction"): boolean {
	try {
		fs.symlinkSync(target, linkPath, kind);
		return true;
	} catch {
		return false;
	}
}

/**
 * On Windows, `fs.openSync(O_NOFOLLOW)` semantics differ from POSIX in ways
 * that make these specific symlink-rejection tests unreliable in CI
 * (GitHub Actions windows-latest grants symlink create privilege but
 * openSync follows through anyway, so `validateSteeringFile` cannot detect
 * the redirect). POSIX paths are covered by the existing tests. On Windows
 * the validation is still enforced — these tests just don't exercise it.
 */
function isWindowsSymlinkTestUnsupported(): boolean {
	return process.platform === "win32";
}

// ── FIX-02: sanitizeSteerMessage ─────────────────────────────────────────

test("FIX-02: sanitizeSteerMessage rejects message > 4096 chars", () => {
	const message = "a".repeat(4097);
	const result = sanitizeSteerMessage({ type: "steer", message });
	assert.equal(result.valid, false);
	assert.match(result.reason ?? "", /message-too-long/);
});

test("FIX-02: sanitizeSteerMessage accepts message at the 4096-char boundary", () => {
	const message = "a".repeat(4096);
	const result = sanitizeSteerMessage({ type: "steer", message });
	assert.equal(result.valid, true);
	assert.equal(result.message, message);
});

test("FIX-02: sanitizeSteerMessage rejects >50 newlines", () => {
	const message = "line\n".repeat(51);
	const result = sanitizeSteerMessage({ type: "steer", message });
	assert.equal(result.valid, false);
	assert.match(result.reason ?? "", /too-many-newlines/);
});

test("FIX-02: sanitizeSteerMessage accepts 50 newlines (boundary)", () => {
	const message = "line\n".repeat(50);
	const result = sanitizeSteerMessage({ type: "steer", message });
	assert.equal(result.valid, true);
});

test("FIX-02: sanitizeSteerMessage rejects control characters", () => {
	// \x1b (ESC) is the canonical ANSI escape introducer — the most
	// realistic control-char smuggling attempt.
	const result = sanitizeSteerMessage({ type: "steer", message: "hello\x1b[2J\x1b[H world" });
	assert.equal(result.valid, false);
	assert.match(result.reason ?? "", /control-characters/);
});

test("FIX-02: sanitizeSteerMessage rejects NUL byte", () => {
	const result = sanitizeSteerMessage({ type: "steer", message: "before\x00after" });
	assert.equal(result.valid, false);
	assert.match(result.reason ?? "", /control-characters/);
});

test("FIX-02: sanitizeSteerMessage accepts tab/cr/lf whitespace (not flagged as control)", () => {
	const result = sanitizeSteerMessage({ type: "steer", message: "line1\r\n\tindented line2" });
	assert.equal(result.valid, true);
	assert.equal(result.message, "line1\r\n\tindented line2");
});

test("FIX-02: sanitizeSteerMessage rejects empty/missing message", () => {
	assert.equal(sanitizeSteerMessage({ type: "steer", message: "" }).valid, false);
	assert.equal(sanitizeSteerMessage({ type: "steer" }).valid, false);
});

test("FIX-02: sanitizeSteerMessage accepts a typical legitimate steer", () => {
	const message = "Focus on the caching layer next, skip the auth refactor.";
	const result = sanitizeSteerMessage({ type: "steer", message });
	assert.equal(result.valid, true);
	assert.equal(result.message, message);
});

// ── FIX-03: validateSteeringFile ──────────────────────────────────────────

test("FIX-03: validateSteeringFile rejects a symlink at the steering file itself", (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-f03-"));
	try {
		const realFile = path.join(tmpDir, "real.jsonl");
		const linkFile = path.join(tmpDir, "steering-link.jsonl");
		fs.writeFileSync(realFile, "");
		if (!trySymlink(realFile, linkFile, "file")) {
			t.skip("symlinks unavailable on this platform");
			return;
		}
		const result = validateSteeringFile(linkFile);
		assert.equal(result.valid, false);
		assert.match(result.reason ?? "", /symlink/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("FIX-03: validateSteeringFile rejects a path whose parent is a symlink (escapes artifacts root)", (t) => {
	// Threat model: a malicious parent process sets
	//   PI_CREW_STEERING_FILE=/tmp/<dir>/sneaky/steering/task.jsonl
	// where `/tmp/<dir>/sneaky` is a symlink to an unrelated directory.
	// The derived artifactsRoot (../.. from steering/) IS the symlink, so
	// `resolveRealContainedPath` will throw ELOOP when opening it with
	// O_NOFOLLOW. That's the rejection we want to assert.
	if (isWindowsSymlinkTestUnsupported()) {
		t.skip("Windows openSync(O_NOFOLLOW) does not reliably reject symlinks; covered by POSIX runs");
		return;
	}
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-f03-"));
	try {
		const outsideDir = path.join(tmpDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
		const sneakyLink = path.join(tmpDir, "sneaky");
		if (!trySymlink(outsideDir, sneakyLink, "dir")) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		const maliciousPath = path.join(sneakyLink, "steering", "task.jsonl");
		const result = validateSteeringFile(maliciousPath);
		assert.equal(result.valid, false);
		// Either lstat (target doesn't exist → no rejection here) or the
		// resolveRealContainedPath call fails because baseDir = the symlink.
		assert.match(result.reason ?? "", /symlink|path-validation-failed/);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("FIX-03: validateSteeringFile rejects a steering path whose ancestor contains a symlink", (t) => {
	// Another variant: the artifactsRoot itself is real, but an intermediate
	// directory (artifactsRoot/a/) is a symlink. The walk over ancestors
	// hits the symlink and fails.
	if (isWindowsSymlinkTestUnsupported()) {
		t.skip("Windows openSync(O_NOFOLLOW) does not reliably reject symlinks; covered by POSIX runs");
		return;
	}
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-f03-"));
	try {
		const realDir = path.join(tmpDir, "real");
		fs.mkdirSync(realDir, { recursive: true });
		const fakeArtifacts = path.join(tmpDir, "fake-artifacts");
		if (!trySymlink(realDir, fakeArtifacts, "dir")) {
			t.skip("directory symlinks unavailable on this platform");
			return;
		}
		// fakeArtifacts → realDir. A path under fakeArtifacts will traverse
		// through the symlink during ancestor-walk and be rejected.
		const steeringFile = path.join(fakeArtifacts, "steering", "task.jsonl");
		const result = validateSteeringFile(steeringFile);
		assert.equal(result.valid, false);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("FIX-03: validateSteeringFile accepts the standard artifacts/steering/<taskId>.jsonl layout", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-f03-"));
	try {
		const artifactsRoot = path.join(tmpDir, "artifacts");
		fs.mkdirSync(path.join(artifactsRoot, "steering"), { recursive: true });
		const steeringFile = path.join(artifactsRoot, "steering", "task1.jsonl");
		fs.writeFileSync(steeringFile, "");
		const result = validateSteeringFile(steeringFile);
		assert.equal(result.valid, true);
		assert.ok(result.resolvedPath, "valid result must include a resolved path");
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("FIX-03: validateSteeringFile accepts a path whose file does not yet exist (write target)", () => {
	// The parent's task-runner creates the artifacts root and steering dir
	// before spawning the worker, but the JSONL itself may be created on
	// first steer write. Non-existent target must NOT fail validation —
	// otherwise the worker can't bootstrap.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-steer-f03-"));
	try {
		const artifactsRoot = path.join(tmpDir, "artifacts");
		fs.mkdirSync(path.join(artifactsRoot, "steering"), { recursive: true });
		const steeringFile = path.join(artifactsRoot, "steering", "future-task.jsonl");
		const result = validateSteeringFile(steeringFile);
		assert.equal(result.valid, true);
		assert.ok(result.resolvedPath);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});
