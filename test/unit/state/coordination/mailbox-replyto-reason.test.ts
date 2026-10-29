/**
 * W10-3 (2026-10-22, lesson #22 — intercom typed reason + strict replyTo
 * routing) — schema + routing-predicate pins.
 *
 *  1. `reason` enum {need_decision, progress_update, interview_request}:
 *     append → serialize → parse roundtrip preserves it.
 *  2. Backward-compat: pre-W10-3 rows (no `reason`, no `replyTo`) parse
 *     unchanged and are NOT repair-gatched by validateMailbox (no error-level
 *     issues, nothing repaired).
 *  3. An out-of-enum `reason` value degrades to `undefined` (dropped field,
 *     same graceful semantics as `kind`/`priority`) — never an error.
 *  4. checkReplyToRequesterOrigin — the A→B→C rule: a response's `replyTo`
 *     must point at a request opened by (`from` ===) the requester the
 *     response is addressed to (`to`).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	appendMailboxMessageAsync,
	checkReplyToRequesterOrigin,
	type MailboxMessage,
	readAllMailboxMessages,
	signMailboxMessage,
	validateMailbox,
} from "../../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

function makeStateRoot(): { stateRoot: string; manifest: TeamRunManifest; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-w10-3-mailbox-"));
	const stateRoot = path.join(root, ".crew", "state", "runs", "run-1");
	fs.mkdirSync(stateRoot, { recursive: true });
	return {
		stateRoot,
		// Mailbox helpers consult only manifest.stateRoot + runId.
		manifest: { runId: "run-1", stateRoot } as unknown as TeamRunManifest,
		cleanup: async () => {
			await removeDirWithRetry(root);
		},
	};
}

describe("W10-3 mailbox reason enum (lesson #22)", () => {
	it("append → serialize → parse roundtrip preserves every enum value", async () => {
		const state = makeStateRoot();
		try {
			const reasons = ["need_decision", "progress_update", "interview_request"] as const;
			for (const reason of reasons) {
				const appended = await appendMailboxMessageAsync(state.manifest, {
					direction: "inbox",
					from: "leader",
					to: "task-1",
					body: `typed contact (${reason})`,
					kind: "message",
					reason,
				});
				assert.equal(appended.reason, reason);
				const read = readAllMailboxMessages(state.manifest).find((m) => m.id === appended.id);
				assert.equal(read?.reason, reason, `roundtrip must preserve reason=${reason}`);
			}
			// The serialized JSONL line carries the field (durable on-disk shape).
			const line = fs
				.readFileSync(path.join(state.stateRoot, "mailbox", "inbox.jsonl"), "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>);
			assert.deepEqual(line.map((l) => l.reason).sort(), ["interview_request", "need_decision", "progress_update"]);
		} finally {
			state.cleanup();
		}
	});

	it("legacy row without reason/replyTo parses unchanged and is never repair-gatched", () => {
		const state = makeStateRoot();
		try {
			// Pre-W10-3 row shape: no reason, no replyTo.
			const legacy = {
				id: "msg_legacy_1",
				runId: "run-1",
				direction: "inbox",
				from: "leader",
				to: "task-1",
				body: "legacy body",
				createdAt: new Date().toISOString(),
				status: "delivered",
				kind: "response",
				questionId: "11111111-1111-4111-8111-111111111111",
			};
			fs.mkdirSync(path.join(state.stateRoot, "mailbox"), { recursive: true });
			// w1a: delivery reads verify sender signatures, so the fixture row is
			// signed with the test-process keypair (the parse semantics under test
			// — legacy shape without reason/replyTo — are unchanged by signing).
			fs.writeFileSync(
				path.join(state.stateRoot, "mailbox", "inbox.jsonl"),
				`${JSON.stringify(signMailboxMessage(legacy as MailboxMessage))}\n`,
				"utf-8",
			);
			const messages = readAllMailboxMessages(state.manifest);
			assert.equal(messages.length, 1);
			assert.equal(messages[0]?.id, "msg_legacy_1");
			assert.equal(messages[0]?.reason, undefined, "legacy row has no reason — parses as undefined, no crash");
			assert.equal(messages[0]?.replyTo, undefined);
			// Validation: the row itself is schema-valid — no error-level issue
			// names it, and repair (even if invoked for other reasons) keeps the
			// line (nothing repaired when there is nothing invalid).
			const report = validateMailbox(state.manifest, { repair: true });
			assert.equal(report.repaired.filter((p) => p.endsWith("inbox.jsonl")).length, 0, "a valid legacy row is never dropped");
			assert.deepEqual(
				report.issues.filter((issue) => issue.level === "error" && issue.path.endsWith("inbox.jsonl")),
				[],
				"legacy row without reason must not produce a parse error",
			);
		} finally {
			state.cleanup();
		}
	});

	it("out-of-enum reason degrades to undefined (dropped field, not an error)", async () => {
		const state = makeStateRoot();
		try {
			const appended = await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: "task-1",
				body: "ok",
			});
			// Hand-write an invalid enum value next to the valid row. w1a: the row
			// is tampered (id + reason changed off the signed original), so it must
			// be RE-SIGNED to stay authentic — the parse-degradation behavior under
			// test is unchanged.
			const file = path.join(state.stateRoot, "mailbox", "inbox.jsonl");
			const raw = JSON.parse(fs.readFileSync(file, "utf-8").split("\n").filter(Boolean)[0]!) as Record<string, unknown>;
			const tampered = { ...raw, id: "msg_bad_reason", reason: "gossip" } as unknown as MailboxMessage;
			fs.appendFileSync(file, `${JSON.stringify(signMailboxMessage(tampered))}\n`, "utf-8");
			const messages = readAllMailboxMessages(state.manifest);
			const bad = messages.find((m) => m.id === "msg_bad_reason");
			assert.ok(bad, "row with unknown reason still parses as a message");
			assert.equal(bad.reason, undefined);
			assert.equal(appended.reason, undefined);
		} finally {
			state.cleanup();
		}
	});
});

describe("W10-3 checkReplyToRequesterOrigin (A→B→C rule)", () => {
	async function fixture(): Promise<{
		manifest: TeamRunManifest;
		response: (opts: { to: string; replyTo: string }) => Promise<MailboxMessage>;
		cleanup: () => void;
	}> {
		const state = makeStateRoot();
		// B's request to the leader (the original `replyTo` target).
		await appendMailboxMessageAsync(state.manifest, {
			direction: "outbox",
			from: "task-B",
			to: "leader",
			body: "B's question to the leader",
			kind: "message",
		});
		const bOriginal = readAllMailboxMessages(state.manifest).find((m) => m.from === "task-B");
		assert.ok(bOriginal);
		return {
			manifest: state.manifest,
			response: ({ to, replyTo }) =>
				appendMailboxMessageAsync(state.manifest, {
					direction: "inbox",
					from: "leader",
					to,
					taskId: to,
					body: `answer for ${to}`,
					kind: "response",
					questionId: "99999999-9999-4999-8999-999999999999",
					replyTo,
				}),
			cleanup: state.cleanup,
		};
	}

	it("response WITHOUT replyTo → no-reply-to (nothing to verify, legacy OK)", async () => {
		const state = makeStateRoot();
		try {
			const response = await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: "task-C",
				body: "untagged answer",
				kind: "response",
			});
			assert.deepEqual(checkReplyToRequesterOrigin(state.manifest, response), { verdict: "no-reply-to" });
		} finally {
			state.cleanup();
		}
	});

	it("A→B→C mismatch: reply to B's request addressed to C ⇒ mismatch", async () => {
		const f = await fixture();
		try {
			const bOriginal = readAllMailboxMessages(f.manifest).find((m) => m.from === "task-B")!;
			const response = await f.response({ to: "task-C", replyTo: bOriginal.id });
			const verdict = checkReplyToRequesterOrigin(f.manifest, response);
			assert.equal(verdict.verdict, "mismatch");
			if (verdict.verdict === "mismatch") {
				assert.equal(verdict.originalFrom, "task-B");
				assert.equal(verdict.responseTo, "task-C");
			}
		} finally {
			f.cleanup();
		}
	});

	it("right pair: reply addressed to the same requester that opened the original ⇒ match", async () => {
		const f = await fixture();
		try {
			const bOriginal = readAllMailboxMessages(f.manifest).find((m) => m.from === "task-B")!;
			const response = await f.response({ to: "task-B", replyTo: bOriginal.id });
			const verdict = checkReplyToRequesterOrigin(f.manifest, response);
			assert.equal(verdict.verdict, "match");
			if (verdict.verdict === "match") assert.equal(verdict.requester, "task-B");
		} finally {
			f.cleanup();
		}
	});

	it("replyTo pointing at a non-existent original ⇒ origin-not-found (unverifiable)", async () => {
		const f = await fixture();
		try {
			const response = await f.response({ to: "task-C", replyTo: "msg_never_existed" });
			assert.deepEqual(checkReplyToRequesterOrigin(f.manifest, response), {
				verdict: "origin-not-found",
				replyTo: "msg_never_existed",
			});
		} finally {
			f.cleanup();
		}
	});

	it("original is found even when it lives in a TASK mailbox", async () => {
		const state = makeStateRoot();
		try {
			// Worker-side rows land in per-task mailboxes (taskId set) — the
			// lookup must scan global + task mailboxes.
			const original = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: "task-B",
				to: "leader",
				taskId: "task-B",
				body: "B's worker-side question",
				kind: "message",
			});
			const response = await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: "task-B",
				taskId: "task-B",
				body: "answer",
				kind: "response",
				replyTo: original.id,
			});
			assert.equal(checkReplyToRequesterOrigin(state.manifest, response).verdict, "match");
		} finally {
			state.cleanup();
		}
	});
});
