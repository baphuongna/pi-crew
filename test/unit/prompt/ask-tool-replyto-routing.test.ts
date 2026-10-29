/**
 * W10-3 (2026-10-22, lesson #22) — strict replyTo routing enforced at the
 * ask-resolution point (prompt-runtime findAskResponse).
 *
 * The parked `ask` tool polls for a `kind:"response"` row with its exact
 * questionId. W10-3 adds the A→B→C gate: when that row carries a `replyTo`,
 * the original it points at must have been opened by the SAME requester the
 * response is addressed to. Pinned end-to-end through createAskTool with a
 * REAL temp run mailbox (the same seam ask-tool-lifecycle.test.ts uses):
 *
 *  (a) A→B→C mismatch — a response whose replyTo points at B's request but is
 *      addressed to C (the parked task) does NOT resolve the park: the tool
 *      times out and the foreign answer never surfaces.
 *  (b) right pair — replyTo → an original opened by the parked requester
 *      resolves normally (answered, fenced answer).
 *  (c) legacy rows (no reason, no replyTo) keep resolving — no crash, no
 *      behavior change for pre-W10-3 streams.
 *  (d) W10-3 hardening (review of cherry-picked a356ae9): a MISROUTED
 *      response followed by a VALID re-sent answer with the SAME questionId
 *      resolves the park — the mismatched candidate is skipped, not fatal
 *      (the old `.find()` + bail-out shadowed the valid answer till deadline).
 *  (e) taskId anchor: a reply pair that is COHERENT for another task (B) but
 *      whose row tags this questionId does NOT resolve this park — the
 *      candidate filter requires `to === taskId`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionToolContext } from "../../../src/extension/pi-api.ts";
import { type AskBrokerClientSurface, type AskToolDefinition, createAskTool } from "../../../src/prompt/prompt-runtime.ts";
import { appendMailboxMessageAsync, type MailboxMessage, signMailboxMessage } from "../../../src/state/coordination/mailbox.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

interface TempAskState {
	stateRoot: string;
	runId: string;
	taskId: string;
	manifest: TeamRunManifest;
	env: NodeJS.ProcessEnv;
	cleanup(): void;
}

function makeTempAskState(): TempAskState {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ask-replyto-"));
	const stateRoot = path.join(root, ".crew", "state", "runs", "run-1");
	fs.mkdirSync(stateRoot, { recursive: true });
	const runId = "run-1";
	const taskId = "task-C";
	return {
		stateRoot,
		runId,
		taskId,
		manifest: { runId, stateRoot } as unknown as TeamRunManifest,
		env: {
			PI_CREW_ASK_ENABLED: "1",
			PI_CREW_TASK_ID: taskId,
			PI_CREW_BROKER_RUN_ID: runId,
			PI_CREW_STATE_ROOT: stateRoot,
			PI_CREW_BROKER_SOCKET: "/nonexistent/broker.sock",
			PI_CREW_BROKER_TOKEN: "test-token",
		},
		cleanup: async () => {
			await removeDirWithRetry(root);
		},
	};
}

function makeMockBrokerClient(deadlineMs: number): { surface: AskBrokerClientSurface; calls: Array<{ method: string; params: unknown }> } {
	const calls: Array<{ method: string; params: unknown }> = [];
	const surface: AskBrokerClientSurface = {
		async request(method: string, params: unknown) {
			calls.push({ method, params });
			if (method === "wait.request") {
				return {
					ok: true,
					value: {
						ok: true,
						questionId: "33333333-3333-4333-8333-333333333333",
						askedAt: new Date().toISOString(),
						deadline: Date.now() + deadlineMs,
						timeoutSec: Math.ceil(deadlineMs / 1000),
						clamped: false,
					},
				};
			}
			if (method === "wait.resolve") return { ok: true, value: {} };
			return { ok: false, fallback: true, errorCode: "not-implemented" };
		},
		async close() {
			/* no socket in tests */
		},
	};
	return { surface, calls };
}

async function runAsk(tool: AskToolDefinition, params: { question: string; timeoutSec?: number }) {
	return tool.execute("tc-1", params, undefined, undefined, undefined as unknown as ExtensionToolContext);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.equal(first?.type, "text");
	return (first as { text: string }).text;
}

describe("ask tool strict replyTo routing (W10-3)", () => {
	it("(a) A→B→C mismatch: reply to B's request does NOT resolve C's park", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(700);
			// B (a different lane) opened a request to the leader.
			const bRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: "task-B",
				to: "leader",
				body: "B's question",
				kind: "message",
			});
			// The parked task is C — a response tagged with C's questionId but
			// replying to B's request must not resolve C's park.
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "answer that belongs to B",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: bRequest.id,
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question", timeoutSec: 1 });
			// Park NOT resolved by the mismatched response → deadline rules.
			assert.equal(result.details.status, "timed-out");
			const text = resultText(result);
			assert.ok(!text.includes("answer that belongs to B"), "the foreign answer must never surface");
			// The terminal resolve reports timed-out (not answered).
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "timed-out");
		} finally {
			state.cleanup();
		}
	});

	it("(b) right pair: replyTo → original opened by the parked requester resolves normally", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(10_000);
			// The parked task's OWN earlier request (from task-C).
			const ownRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: state.taskId,
				to: "leader",
				body: "C's earlier message",
				kind: "message",
			});
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "legit answer for C",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: ownRequest.id,
				reason: "need_decision",
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question" });
			assert.equal(result.details.status, "answered");
			assert.ok(resultText(result).includes("legit answer for C"));
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "answered");
		} finally {
			state.cleanup();
		}
	});

	it("(c) legacy response rows (no reason, no replyTo) keep resolving — no crash", async () => {
		const state = makeTempAskState();
		try {
			const { surface } = makeMockBrokerClient(10_000);
			// Pre-W10-3 row shape: no reason field, no replyTo.
			const legacy = {
				id: "msg_legacy_answer",
				runId: state.runId,
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				body: "legacy answer",
				createdAt: new Date().toISOString(),
				status: "queued",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
			};
			fs.mkdirSync(path.join(state.stateRoot, "mailbox"), { recursive: true });
			// w1a: the ask-poll's delivery read verifies sender signatures, so the
			// legacy fixture row is signed with the test-process keypair (same one
			// appendMailboxMessageAsync uses in this suite).
			fs.writeFileSync(
				path.join(state.stateRoot, "mailbox", "inbox.jsonl"),
				`${JSON.stringify(signMailboxMessage(legacy as MailboxMessage))}\n`,
				"utf-8",
			);
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "legacy stream question" });
			assert.equal(result.details.status, "answered");
			assert.ok(resultText(result).includes("legacy answer"));
		} finally {
			state.cleanup();
		}
	});

	it("(d) misroute first + valid re-sent answer with the SAME questionId later → resolved", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(10_000);
			// B (a different lane) opened a request to the leader.
			const bRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: "task-B",
				to: "leader",
				body: "B's question",
				kind: "message",
			});
			// 1st response (MISROUTE): addressed to C but replying to B's request.
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "misrouted answer that belongs to B",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: bRequest.id,
			});
			// 2nd response (leader re-send after the misroute): SAME questionId,
			// addressed to the parked task, no replyTo — the valid answer.
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: state.taskId,
				taskId: state.taskId,
				body: "legit re-sent answer for C",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question" });
			// The misrouted candidate is skipped; the later valid answer resolves.
			assert.equal(result.details.status, "answered");
			const text = resultText(result);
			assert.ok(!text.includes("misrouted answer that belongs to B"), "the misrouted answer must never surface");
			assert.ok(text.includes("legit re-sent answer for C"), "the re-sent valid answer must resolve the park");
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "answered");
		} finally {
			state.cleanup();
		}
	});

	it("(e) coherent pair for ANOTHER task (to=task-B) tagging this questionId → not resolved", async () => {
		const state = makeTempAskState();
		try {
			const { surface, calls } = makeMockBrokerClient(700);
			// B opened a request; the leader answered B coherently (replyTo → B's
			// request, to=task-B). replyTo↔to coherence HOLDS — but the row tags C's
			// parked questionId, so only the taskId anchor keeps it off C's park.
			const bRequest = await appendMailboxMessageAsync(state.manifest, {
				direction: "outbox",
				from: "task-B",
				to: "leader",
				body: "B's question",
				kind: "message",
			});
			await appendMailboxMessageAsync(state.manifest, {
				direction: "inbox",
				from: "leader",
				to: "task-B",
				taskId: "task-B",
				body: "B's own answer",
				kind: "response",
				questionId: "33333333-3333-4333-8333-333333333333",
				replyTo: bRequest.id,
				reason: "need_decision",
			});
			const tool = createAskTool({ env: state.env, makeBrokerClient: () => surface });
			const result = await runAsk(tool, { question: "C's question", timeoutSec: 1 });
			// No candidate anchored to task-C → the park waits out the deadline.
			assert.equal(result.details.status, "timed-out");
			const text = resultText(result);
			assert.ok(!text.includes("B's own answer"), "another task's coherent answer must never surface");
			const resolves = calls.filter((c) => c.method === "wait.resolve");
			assert.equal(resolves.length, 1);
			const resolveParams = resolves[0]?.params as { outcome?: string } | undefined;
			assert.equal(resolveParams?.outcome, "timed-out");
		} finally {
			state.cleanup();
		}
	});
});
