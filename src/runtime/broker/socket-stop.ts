/**
 * socket-stop.ts — Ownership-gated teardown of the broker's listening socket.
 *
 * An AF_UNIX listener has TWO unlink vectors, and both must be owned-gated:
 *  1. The explicit `fs.unlink` of the recorded path (CrewBroker.stop step 4).
 *  2. libuv itself: `uv__pipe_close` unlinks the server pipe's bind path BY
 *     NAME (no inode check) when the listening handle closes — Node's
 *     `server.close()` deletes whatever currently sits at the path, even a
 *     socket another listener re-bound there after ours was unlinked
 *     (empirically verified on Node 22, 2026-10-26).
 *
 * The broker socket path is deterministic per sessionId, so a rebound leaf
 * must survive our stop(). stopServerAndRemoveSocket therefore:
 *  - Unlinks the leaf itself FIRST when its dev+ino match the identity
 *    captured at listen() time — libuv's close-unlink then finds nothing.
 *  - Otherwise, if ANY entry lives at the path (rebound foreign socket, or
 *    ownership unprovable because the capture lstat failed), renames it
 *    aside (shield) across closeServer() and renames it back afterwards:
 *    a brief ENOENT window for new connects instead of permanent deletion
 *    of a live foreign socket. B-LOW2: the rename-back happens ONLY while
 *    sockPath is still absent — if a new listener re-bound the leaf during
 *    the close, its leaf wins and the shield is kept (renaming back would
 *    clobber the fresh bind).
 *    A stranded shield (crash between renames, or one kept after a rebind)
 *    keeps its `.stopping.` suffix and is swept by the corpse sweep inside
 *    removeStaleBrokerSocket at the next start — it unlinks a shield ONLY
 *    when the pid embedded in its name is provably dead (B-LOW1).
 *  - Windows named pipes have no filesystem leaf: plain close only.
 *
 * Never throws; diagnostics flow through logInternalError with redaction.
 */

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecretString } from "../../utils/redaction.ts";

/** dev+ino of the socket leaf created by listen() — captured immediately
 *  after a successful bind so stop() can prove continued ownership of the
 *  path before removing it. Null when the lstat failed (stop() then treats
 *  the leaf as NOT provably ours — the safe direction). */
export interface SocketIdentity {
	dev: number;
	ino: number;
}

/** Capture the identity of the freshly-bound socket leaf (POSIX only). */
export async function captureSocketIdentity(sockPath: string): Promise<SocketIdentity | null> {
	try {
		const st = await fsp.lstat(sockPath);
		return { dev: st.dev, ino: st.ino };
	} catch {
		return null;
	}
}

export type SocketStopOutcome =
	/** Our leaf (identity matched) was unlinked by us before the close. */
	| "unlinked"
	/** A foreign/unpinned entry existed and was shielded across the close. */
	| "shielded-foreign"
	/** A foreign entry existed but the shield rename failed (close then
	 *  unlinks it by name — the pre-fix behavior; logged loudly). */
	| "unshielded-foreign"
	/** Nothing lived at the path (or win32: no fs leaf at all). */
	| "absent";

/** Close the listening server and remove the socket path ONLY while we
 *  provably own it. `closeServer` must perform the net.Server close (the
 *  libuv by-name unlink vector) — it is called exactly once, sandwiched
 *  inside the ownership decision. Never throws. */
export async function stopServerAndRemoveSocket(
	sockPath: string,
	identity: SocketIdentity | null,
	closeServer: () => Promise<void>,
): Promise<SocketStopOutcome> {
	if (process.platform === "win32") {
		await closeServer();
		return "absent";
	}
	const current = await fsp.lstat(sockPath).catch(() => null);
	if (current === null) {
		await closeServer();
		return "absent";
	}
	const owned = identity !== null && current.dev === identity.dev && current.ino === identity.ino;
	if (owned) {
		// Remove our own leaf first so libuv's close-unlink finds nothing.
		// (Microsecond TOCTOU between this unlink and the close-unlink is
		// inherent to path-based APIs — accepted, same class as before.)
		await fsp.unlink(sockPath).catch(() => {
			/* best-effort: the leaf may already be gone */
		});
		await closeServer();
		return "unlinked";
	}
	// Foreign or unprovably-owned entry: shield it across the close.
	const shield = `${sockPath}.stopping.${process.pid}.${randomBytes(3).toString("hex")}`;
	let shielded = false;
	try {
		await fsp.rename(sockPath, shield);
		shielded = true;
	} catch (err) {
		logInternalError(
			"crew-broker.stop.shield-rename-failed",
			err instanceof Error ? err : new Error(String(err)),
			`path=${redactSecretString(sockPath)}`,
		);
	}
	try {
		await closeServer();
	} finally {
		if (shielded) {
			// B-LOW2: restore ONLY while the leaf is still absent. While our
			// handle was closing, a new listener may have bound sockPath — a
			// rename back would REPLACE its fresh leaf (rename clobbers the
			// target), recreating the exact deletion bug the shield exists to
			// prevent. When rebound: keep the shield (the corpse sweep at the
			// next start removes it once this pid is dead) and log loudly.
			let rebound = false;
			try {
				await fsp.lstat(sockPath);
				rebound = true;
			} catch {
				/* still absent — safe to restore */
			}
			if (rebound) {
				logInternalError(
					"crew-broker.stop.shield-kept-rebound",
					new Error(`socket path re-bound during close — keeping shield at ${shield} instead of clobbering the new listener`),
					`path=${redactSecretString(sockPath)}`,
				);
			} else {
				try {
					await fsp.rename(shield, sockPath);
				} catch (err) {
					logInternalError(
						"crew-broker.stop.shield-restore-failed",
						err instanceof Error ? err : new Error(String(err)),
						`path=${redactSecretString(shield)}`,
					);
				}
			}
		}
	}
	return shielded ? "shielded-foreign" : "unshielded-foreign";
}
