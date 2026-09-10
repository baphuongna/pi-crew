/**
 * events-replay.ts — Phase 1.5 events.since handler (label corrected
 * 2026-09-10 per review F4 — "Phase 2" is events.subscribe). Used by clients
 * to resync after a missed live frame (e.g. after a queue overflow or
 * reconnect).
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Operates only on the connection + a writers adapter (sendError/sendResult).
 * Promoted to a top-level function so the class method is a 1-line delegation.
 */

import { readEventsCursor } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { ServerConnection } from "./connection-state.ts";

export interface EventWriterHelpers {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
}

/** Phase 2: events.since — page-replay handler. Returns events with
 *  seq > sinceSeq from the durable log, capped to `limit` (default 1000). */
export async function handleEventsSince(
	conn: ServerConnection,
	id: string,
	params: unknown,
	helpers: EventWriterHelpers,
	cwd: string | undefined,
): Promise<void> {
	if (!conn.runId) {
		helpers.sendError(conn, id, "auth", "not authed");
		return;
	}
	if (!cwd) {
		helpers.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let eventsPath: string;
	try {
		const loaded = loadRunManifestById(cwd, conn.runId);
		if (!loaded) {
			helpers.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
			return;
		}
		eventsPath = loaded.manifest.eventsPath;
	} catch (err) {
		helpers.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	const v = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
	const sinceSeq = typeof v.sinceSeq === "number" && Number.isFinite(v.sinceSeq) ? Math.max(0, Math.floor(v.sinceSeq)) : 0;
	const limit = typeof v.limit === "number" && Number.isFinite(v.limit) ? Math.min(Math.max(1, Math.floor(v.limit)), 1000) : 1000;
	try {
		const result = readEventsCursor(eventsPath, { sinceSeq, limit });
		// hasMore is true iff the total filtered count exceeds the page we
		// returned. When `total === events.length` we are at the exact end
		// of the stream (caller will discover this on the next call when
		// `nextSeq` is unchanged from `sinceSeq`).
		const hasMore = result.total > result.events.length;
		helpers.sendResult(conn, id, {
			events: result.events,
			nextSeq: result.nextSeq,
			hasMore,
		});
	} catch (err) {
		helpers.sendError(conn, id, "replay-failed", (err as Error).message);
	}
}
