/**
 * socket-path.ts — Canonical broker Unix-socket / named-pipe path utilities.
 *
 * Moved out of the parallel-work stub `src/runtime/crew-broker-deps.ts`.
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

/** Resolve the broker endpoint for the given session.
 *
 *  - POSIX: `${XDG_RUNTIME_DIR || os.tmpdir()}/pi-crew-<hash8>.sock` (dir
 *    0700 enforced by `prepareBrokerSocketDir`; socket 0600 by the server).
 *  - Windows: `\\\\.\\pipe\\pi-crew-broker-<hash8>`.
 *  - Throws if the encoded POSIX path exceeds sun_path (108 bytes) — the
 *    caller cannot fix this without changing the hash length, so fail fast. */
export function getBrokerSocketPath(sessionId: string, platform: NodeJS.Platform = process.platform): string {
	const hash = hashSessionId(sessionId);
	if (platform === "win32") {
		return `\\\\.\\pipe\\pi-crew-broker-${hash}`;
	}
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const sock = path.join(base, `pi-crew-${hash}.sock`);
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
 *  do not have an enclosing dir). */
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
	// Bound the probe: connect with a short timeout. If anything answers, treat as live.
	const live = await new Promise<boolean>((resolve) => {
		let settled = false;
		const sock = net.createConnection(sockPath);
		const finish = (v: boolean) => {
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
		sock.once("error", () => finish(false));
		setTimeout(() => finish(false), probeTimeoutMs);
	});
	if (live) return "kept";
	// Stale: remove.
	try {
		await fsp.unlink(sockPath);
		return "removed";
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "absent";
		throw e;
	}
}
