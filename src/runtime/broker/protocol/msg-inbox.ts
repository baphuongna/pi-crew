/**
 * msg-inbox.ts — Phase 1.1 msg.inbox broker handler.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * Operates on a connection + writers adapter + cwd. Top-level function so
 * the class method is a 1-line delegation.
 */

import { readMailbox } from "../../../state/coordination/mailbox.ts";
import { loadRunManifestById } from "../../../state/stores/state-store.ts";
import type { ServerConnection } from "./connection-state.ts";
import { parseMsgInboxParams } from "./request-parsers.ts";

export interface MsgInboxHelpers {
	sendError(conn: ServerConnection, id: string, code: string, message: string): void;
	sendResult(conn: ServerConnection, id: string, result: unknown): void;
}

/** Phase 1.1: read the durable mailbox for the addressed task (or run-level
 *  "inbox" lane) with cursor/limit pagination. Returns messages whose status
 *  is NOT yet `acknowledged`; callers should ack after processing. */
export async function handleMsgInbox(
	conn: ServerConnection,
	id: string,
	params: unknown,
	helpers: MsgInboxHelpers,
	cwd: string | undefined,
): Promise<void> {
	if (!conn.runId) {
		helpers.sendError(conn, id, "auth", "not authed");
		return;
	}
	const parsed = parseMsgInboxParams(params);
	if (!parsed) {
		helpers.sendError(conn, id, "bad-params", "msg.inbox: invalid params");
		return;
	}
	if (!cwd) {
		helpers.sendError(conn, id, "no-manifest", "broker has no cwd configured");
		return;
	}
	let manifest: Parameters<typeof readMailbox>[0];
	try {
		const loaded = loadRunManifestById(cwd, conn.runId);
		if (!loaded) {
			helpers.sendError(conn, id, "no-manifest", `run '${conn.runId}' not found`);
			return;
		}
		manifest = loaded.manifest;
	} catch (err) {
		helpers.sendError(conn, id, "no-manifest", (err as Error).message);
		return;
	}
	const limit = Math.min(Math.max(parsed.limit ?? 100, 1), 1000);
	const taskId = conn.taskId ?? undefined;
	const all = readMailbox(manifest, "inbox", taskId);
	const filtered = all.filter((m) => m.status !== "acknowledged");
	const offset = parsed.cursor ? Number.parseInt(parsed.cursor, 10) || 0 : 0;
	const page = filtered.slice(offset, offset + limit);
	const nextOffset = offset + page.length;
	const hasMore = nextOffset < filtered.length;
	helpers.sendResult(conn, id, {
		messages: page,
		nextCursor: hasMore ? String(nextOffset) : undefined,
		hasMore,
		total: filtered.length,
	});
}
