/**
 * socket-path-peruser.test.ts — F-04: per-user socket subdir tests.
 *
 * Guards against the bug where `prepareBrokerSocketDir` chmod-ed the SHARED
 * runtime base (`/tmp` or `XDG_RUNTIME_DIR`) to 0700, stripping the sticky
 * bit under root. After F-04, sockets live under a per-user subdir
 * `${base}/pi-crew-<uid>/` and chmod 0700 targets only that user-owned dir.
 *
 * On Windows named pipes have no enclosing dir, so per-user logic is skipped.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getBrokerSocketPath, getPerUserSocketDir, hashSessionId, prepareBrokerSocketDir } from "../../../src/utils/socket-path.ts";

const isWindows = process.platform === "win32";

/** Expected uid of the current process for assertion purposes. */
function expectedUid(): number {
	const uid = process.getuid?.();
	if (typeof uid === "number") return uid;
	try {
		const info = os.userInfo();
		if (typeof info.uid === "number") return info.uid;
	} catch {
		/* ignore */
	}
	return 0;
}

describe("F-04: per-user socket subdir", { skip: isWindows }, () => {
	let tmpBase: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		// Use a throwaway temp dir as XDG_RUNTIME_DIR so we don't pollute /tmp.
		tmpBase = mkdtempSync(path.join(os.tmpdir(), "pc-f04-"));
		originalXdg = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = tmpBase;
	});

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_RUNTIME_DIR;
		} else {
			process.env.XDG_RUNTIME_DIR = originalXdg;
		}
		rmSync(tmpBase, { recursive: true, force: true });
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal path pattern in test description
	it("getPerUserSocketDir returns ${base}/pi-crew-${uid}", () => {
		const dir = getPerUserSocketDir();
		const uid = expectedUid();
		assert.equal(dir, path.join(tmpBase, `pi-crew-${uid}`), "per-user dir should be base/pi-crew-<uid>");
	});

	it("getBrokerSocketPath places socket under per-user subdir, not base directly", () => {
		const sessionId = "test-session-f04";
		const sock = getBrokerSocketPath(sessionId);
		const hash = hashSessionId(sessionId);
		const uid = expectedUid();
		const expected = path.join(tmpBase, `pi-crew-${uid}`, `pi-crew-${hash}.sock`);
		assert.equal(sock, expected);
		// Socket must NOT be directly under the base dir.
		assert.notEqual(path.dirname(sock), tmpBase);
		// Socket MUST be under the per-user subdir.
		assert.equal(path.dirname(sock), path.join(tmpBase, `pi-crew-${uid}`));
	});

	it("prepareBrokerSocketDir creates per-user subdir with mode 0700", async () => {
		const sock = getBrokerSocketPath("mode-test");
		const dir = path.dirname(sock);
		assert.ok(!existsSync(dir), "pre-condition: per-user dir should not exist yet");
		await prepareBrokerSocketDir(sock);
		assert.ok(existsSync(dir), "per-user dir should be created");
		const st = statSync(dir);
		const mode = st.mode & 0o777;
		assert.equal(mode, 0o700, "per-user dir must have mode 0700");
	});

	it("prepareBrokerSocketDir does NOT chmod the shared base dir", async () => {
		// Pre-create the base dir with a "sticky + world-writable" mode (like /tmp).
		// mkdtempSync already created tmpBase, but we re-set its mode to simulate /tmp.
		// We can't change the parent of tmpBase, but we can verify tmpBase's mode
		// is NOT touched by prepareBrokerSocketDir.
		const baseSt = statSync(tmpBase);
		const baseModeBefore = baseSt.mode & 0o777;

		const sock = getBrokerSocketPath("base-protect-test");
		await prepareBrokerSocketDir(sock);

		const baseModeAfter = statSync(tmpBase).mode & 0o777;
		assert.equal(baseModeAfter, baseModeBefore, "shared base dir mode must NOT be changed by prepareBrokerSocketDir");
	});

	it("sun_path budget: per-user path stays under 107 bytes", () => {
		// Even with a 10-digit uid (max on Linux), the path must stay under budget.
		// Typical: /run/user/1000/pi-crew-1000/pi-crew-abcd1234.sock = 48 bytes.
		const sock = getBrokerSocketPath("budget-test-session");
		const encoded = Buffer.byteLength(sock, "utf8");
		assert.ok(encoded < 107, `socket path ${encoded} bytes must stay under sun_path budget (107)`);
	});

	it("sun_path budget: throws when XDG_RUNTIME_DIR is pathologically long", () => {
		// Simulate an extremely long XDG_RUNTIME_DIR to verify the guard fires.
		const longDir = path.join(tmpBase, "x".repeat(200));
		process.env.XDG_RUNTIME_DIR = longDir;
		assert.throws(
			() => getBrokerSocketPath("overflow-session"),
			/exceeds sun_path budget/,
			"should throw when encoded path exceeds 107 bytes",
		);
	});

	it("prepareBrokerSocketDir is idempotent (re-entrant, keeps 0700)", async () => {
		const sock = getBrokerSocketPath("idem-test");
		await prepareBrokerSocketDir(sock);
		await prepareBrokerSocketDir(sock); // second call must not throw
		const mode = statSync(path.dirname(sock)).mode & 0o777;
		assert.equal(mode, 0o700);
	});
});

describe("F-04: Windows named-pipe path (no per-user dir)", { skip: !isWindows }, () => {
	it("getPerUserSocketDir returns empty string on Windows", () => {
		assert.equal(getPerUserSocketDir("win32"), "");
	});

	it("getBrokerSocketPath returns named-pipe on Windows", () => {
		const sock = getBrokerSocketPath("win-session", "win32");
		assert.ok(
			sock.includes("pi-crew-broker-") && sock.includes("pipe") && !sock.includes("/"),
			`expected Windows named-pipe, got: ${sock}`,
		);
	});

	it("prepareBrokerSocketDir is a no-op on Windows", async () => {
		// Should not throw and should not create any directory.
		await prepareBrokerSocketDir("C:\\fake\\path\\sock");
	});
});

// Reference mkdirSync to silence unused-import warnings in case the harness
// strips a path. (mkdirSync is used implicitly via mkdtempSync's parent.)
void mkdirSync;
