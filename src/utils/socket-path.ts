/**
 * socket-path.ts — Canonical broker Unix-socket / named-pipe path utilities.
 *
 * Moved out of the parallel-work stub `src/runtime/broker/crew-broker-deps.ts`.
 * The public surface (hashSessionId, getBrokerSocketPath,
 * prepareBrokerSocketDir, removeStaleBrokerSocket) is preserved verbatim
 * so importers can be updated with a single import-path change.
 *
 * No internal dependencies on other src/ modules — only Node built-ins.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

/** Default hash length for the short socket filename (8 hex chars). */
const DEFAULT_PATH_HASH_LEN = 8;

/** POSIX sun_path cap (108 bytes including the null terminator). Use 107 for the
 *  string portion of the path. */
const POSIX_SUN_PATH_BUDGET = 107;

/** SHA-256 hex prefix of `sessionId`. `length` defaults to 8; must be in [4, 32]. */
export function hashSessionId(sessionId: string, length: number = DEFAULT_PATH_HASH_LEN): string {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("hashSessionId: sessionId must be a non-empty string");
	}
	if (!Number.isInteger(length) || length < 4 || length > 32) {
		throw new Error(`hashSessionId: length must be an integer in [4, 32] (got ${length})`);
	}
	const hex = createHash("sha256").update(sessionId, "utf8").digest("hex");
	return hex.substring(0, length);
}

/** Resolve the current POSIX user id. Uses `process.getuid` (POSIX-only);
 *  falls back to `os.userInfo().uid`, then 0. Never throws. */
function getCurrentUid(): number {
	try {
		const uid = process.getuid?.();
		if (typeof uid === "number") return uid;
	} catch {
		/* ignore */
	}
	try {
		const info = os.userInfo();
		if (typeof info.uid === "number") return info.uid;
	} catch {
		/* ignore */
	}
	return 0;
}

/** Resolve a per-user subdirectory under the runtime base for broker sockets.
 *
 *  `${base}/pi-crew-<uid>/` isolates each user's sockets so that
 *  `prepareBrokerSocketDir` can chmod 0700 a user-owned dir instead of the
 *  shared base (`/tmp` or `XDG_RUNTIME_DIR`). Chmod-ing the shared base under
 *  root strips the sticky bit and breaks the system. On Windows, named pipes
 *  have no enclosing dir, so an empty string is returned. */
export function getPerUserSocketDir(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return "";
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const uid = getCurrentUid();
	// F-BAT1 (2026-10-08, live-caught P1): when XDG_RUNTIME_DIR is ABSENT the
	// base is /tmp — and THREE workspace sweeps scan /tmp for dirs named
	// `pi-crew-*` (cleanupLegacyOrphanTempDirs, orphan temp reconciler, health
	// zombie scan). A broker dir at /tmp/pi-crew-<uid> collides with that
	// namespace and gets rmSync-ed as "debris" — killing the LIVE broker socket
	// of every session launched without XDG_RUNTIME_DIR (live evidence:
	// ask/message/delegate ENOENT in both sync and async runs while runs
	// stayed green). The no-XDG fallback therefore uses a DOT-prefixed name
	// (`.pi-crew-broker-<uid>`) which no `pi-crew-*` sweep matches. The XDG
	// path keeps the original `pi-crew-<uid>` name (/run/user is never swept).
	const leaf = process.env.XDG_RUNTIME_DIR ? `pi-crew-${uid}` : `.pi-crew-broker-${uid}`;
	return path.join(base, leaf);
}

/** Resolve the broker endpoint for the given session.
 *
 *  - POSIX: `${XDG_RUNTIME_DIR || os.tmpdir()}/pi-crew-<uid>/pi-crew-<hash8>.sock`
 *    (per-user dir 0700 enforced by `prepareBrokerSocketDir`; socket 0600 by
 *    the server).
 *  - Windows: `\\\\.\\pipe\\pi-crew-broker-<hash8>`.
 *  - Throws if the encoded POSIX path exceeds sun_path (108 bytes) — the
 *    caller cannot fix this without changing the hash length, so fail fast. */
export function getBrokerSocketPath(sessionId: string, platform: NodeJS.Platform = process.platform): string {
	const hash = hashSessionId(sessionId);
	if (platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-broker-${hash}`;
	}
	const perUserDir = getPerUserSocketDir(platform);
	const sock = path.join(perUserDir, `pi-crew-${hash}.sock`);
	const encoded = Buffer.byteLength(sock, "utf8");
	if (encoded > POSIX_SUN_PATH_BUDGET) {
		throw new Error(
			`broker socket path ${encoded} bytes exceeds sun_path budget (${POSIX_SUN_PATH_BUDGET}); check XDG_RUNTIME_DIR or use a shorter hash`,
		);
	}
	return sock;
}

/** Create the parent directory of a broker socket with mode 0700 (POSIX).
 *  Idempotent: if the directory already exists with the correct mode, leaves
 *  it alone. Refuses to operate on a symlink. Windows is a no-op (named pipes
 *  do not have an enclosing dir).
 *
 *  The parent is a per-user subdir (see `getPerUserSocketDir`), NOT the shared
 *  runtime base, so chmod 0700 targets a user-owned dir rather than stripping
 *  the sticky bit from `/tmp`. */
export async function prepareBrokerSocketDir(sockPath: string): Promise<void> {
	if (process.platform === "win32") return;
	const dir = path.dirname(sockPath);
	// mkdir with mode 0o700; recursive:true so nested paths work.
	await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	// Tighten mode if it already existed (mkdir with mode ignores on existing).
	try {
		await fsp.chmod(dir, 0o700);
	} catch {
		// ENOENT or EPERM on non-POSIX — best-effort.
	}
}

/** Connect-then-unlink stale socket (herdr pattern). If a live broker is
 *  listening, leave the endpoint intact (EADDRINUSE will surface on bind).
 *  If a stale file exists with no listener, remove it. If the path is a
 *  symlink, refuse rather than follow.
 *
 *  Returns "removed" when the stale entry was unlinked, "kept" when a live
 *  listener was detected, "absent" when no entry existed, "refused"
 *  when the entry is a symlink. */
export async function removeStaleBrokerSocket(
	sockPath: string,
	probeTimeoutMs: number = 250,
	// Injectable for deterministic tests (the CrewBroker options.netModule
	// precedent): a fake whose createConnection() never connects/errors pins
	// the timeout branch without racing a real localhost connect.
	netModule?: { createConnection: (path: string) => { once: (ev: string, fn: (arg?: unknown) => void) => void; destroy: () => void } },
): Promise<"removed" | "kept" | "absent" | "refused"> {
	// Reject symlinks outright.
	let st: Awaited<ReturnType<typeof fsp.lstat>>;
	try {
		st = await fsp.lstat(sockPath);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		throw e;
	}
	if (st.isSymbolicLink()) return "refused";
	// A REGULAR FILE (or any non-socket entry) can never be a live endpoint —
	// deterministically stale, remove it WITHOUT the connect probe. This is
	// cross-platform: connect() to a non-socket path is undefined (Linux yields
	// ECONNREFUSED, macOS yields a different errno), so relying on the probe
	// here broke the CrewBroker stale-replace flow on BSD/macOS (CI 2026-10-08:
	// crew-broker-stale-socket "refused/nonexistent stale endpoint is replaced
	// once" + "recording-owned-path unlink only on stop()" — both pre-create a
	// plain file as the corpse). Sockets keep the probe path below.
	if (!st.isSocket()) {
		try {
			await fsp.unlink(sockPath);
			return "removed";
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return "absent";
			throw e;
		}
	}
	// Bound the probe: connect with a short timeout. If anything answers, treat as live.
	const live = await new Promise<boolean | "refused">((resolve) => {
		let settled = false;
		const sock = (netModule ?? net).createConnection(sockPath);
		const finish = (v: boolean | "refused") => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(v);
		};
		sock.once("connect", () => finish(true));
		// F-BAT1 companion (2026-10-08): unlink is safe ONLY on a definitive
		// ECONNREFUSED — the kernel rejects connect() on a socket whose
		// listener is gone (owner died => fd closed => refused), so "refused"
		// reliably means stale. A TIMEOUT (or any other error) means the
		// listener is alive but slow to accept (busy event loop, backlog) —
		// the previous code treated that as stale and UNLINKED A LIVE BROKER,
		// leaving every later client with ENOENT forever.
		sock.once("error", (err) => finish((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "refused" : true));
		setTimeout(() => finish(true), probeTimeoutMs);
	});
	if (live !== "refused") return "kept";
	// Stale (definitive ECONNREFUSED): remove.
	try {
		await fsp.unlink(sockPath);
		return "removed";
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		throw e;
	}
}
