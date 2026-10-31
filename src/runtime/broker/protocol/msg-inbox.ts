/**
 * msg-inbox.ts — Phase 1.2 msg.inbox broker handler (Phase 1.1 = msg.send;
 * label corrected 2026-09-10 per review F3 — it was mislabeled 1.1 at extraction).
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

/** Phase 1.1: read the durable mailbox for the addressed task with
 *  cursor/limit pagination. The run-level "inbox" lane (connection with no
 *  taskId) is readable ONLY with compound auth (S-2, 2026-10-31 fix wave E):
 *  the orchestrator key is compound by construction, while a legacy
 *  bare-runId ("runId-fallback") worker connection is rejected — the same
 *  task-scoped-token rule wait.* (protocol/wait-auth.ts) and delegate.request
 *  enforce. Returns messages whose status is NOT yet `acknowledged`; callers
 *  should ack after processing. */
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
	// S-2 (fix wave E): reading the run-level (orchestrator) inbox lane
	// requires COMPOUND auth. A legacy bare-runId ("runId-fallback") worker
	// connection has no proven task identity, yet previously fell through to
	// the run-level read here. The orchestrator key is compound BY
	// CONSTRUCTION (crew-broker-tokens.ts tokenRoleWithMatchKind), so the
	// legitimate run-level reader is unaffected; authMatchKind is undefined
	// only for pre-hello connections, which the !conn.runId check above
	// already excludes — fail-closed here regardless. Task-lane reads
	// (conn.taskId set) are never runId-fallback: w1a proved explicit taskId
	// claims only via the compound key at hello.
	if (taskId === undefined && conn.authMatchKind !== "compound") {
		helpers.sendError(
			conn,
			id,
			"forbidden",
			"msg.inbox: run-level lane requires a task-scoped token; re-dispatch with PI_CREW_BROKER_TASK_ID",
		);
		return;
	}
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
