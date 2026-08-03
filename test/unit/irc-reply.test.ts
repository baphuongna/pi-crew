/**
 * IRC reply support (side-channel Q&A) — unit tests.
 *
 * Covers respondAsBackground + irc-tool awaitReply wiring:
 * - reply round-trip success
 * - timeout
 * - cancellation (abort signal)
 * - recipient non-blocking invariant (delivery does NOT await the target's
 *   full main-loop turn)
 * - broadcast ignores awaitReply
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createIrcTool } from "../../src/runtime/custom-tools/irc-tool.ts";
import {
	cancelIrcReply,
	clearLiveAgentsForTest,
	clearPendingRepliesForTest,
	pendingReplyCorrIdsForTarget,
	registerLiveAgent,
	resolveIrcReply,
	respondAsBackground,
	terminateLiveAgent,
} from "../../src/runtime/live-session/live-agent-manager.ts";

const WORKSPACE = "workspace:///irc-reply-test";

function makeSession(overrides: Record<string, unknown> = {}) {
	const calls: {
		prompt: string[];
		sendCustom: Array<{ msg: unknown; opts: unknown }>;
	} = {
		prompt: [],
		sendCustom: [],
	};
	return {
		calls,
		session: {
			prompt: async (text: string) => {
				calls.prompt.push(text);
			},
			sendCustomMessage: (msg: unknown, opts?: unknown) => {
				calls.sendCustom.push({ msg, opts });
			},
			...overrides,
		},
	};
}

function registerTarget(id: string, session: Record<string, unknown>) {
	registerLiveAgent({
		agentId: id,
		taskId: `task-${id}`,
		runId: "run-irc",
		status: "running",
		session,
		workspaceId: WORKSPACE,
	});
}

test("respondAsBackground: reply round-trip success", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { calls, session } = makeSession();
	registerTarget("target-A", session);

	// Start the awaited call (non-blocking delivery happens synchronously,
	// then it awaits the reply).
	const pending = respondAsBackground("target-A", "sender", "what is 2+2?", {
		awaitReply: true,
		timeoutMs: 5000,
	});

	// Delivery must have happened already (non-blocking) — message queued.
	assert.ok(calls.sendCustom.length === 1 || calls.prompt.length === 1, "message delivered non-blockingly");

	// Extract the correlation id from the pending registry and resolve it,
	// simulating the recipient's reply.
	const corrIds = pendingReplyCorrIdsForTarget("target-A");
	assert.equal(corrIds.length, 1, "one pending reply registered for target");
	const resolved = resolveIrcReply(corrIds[0]!, "4");
	assert.equal(resolved, true, "resolveIrcReply matched a pending reply");

	const result = await pending;
	assert.equal(result.ok, true);
	assert.equal(result.replyContent, "4");
	assert.equal(result.timedOut, undefined);

	terminateLiveAgent("target-A");
});

test("respondAsBackground: timeout when no reply arrives", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { session } = makeSession();
	registerTarget("target-B", session);

	const result = await respondAsBackground("target-B", "sender", "hello?", {
		awaitReply: true,
		timeoutMs: 50,
	});

	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
	// Registry should be cleaned up after timeout.
	assert.deepEqual(pendingReplyCorrIdsForTarget("target-B"), []);

	terminateLiveAgent("target-B");
});

test("respondAsBackground: cancellation via abort signal", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { session } = makeSession();
	registerTarget("target-C", session);

	const controller = new AbortController();
	const pending = respondAsBackground("target-C", "sender", "please reply", {
		awaitReply: true,
		timeoutMs: 5000,
		signal: controller.signal,
	});

	// Abort before timeout.
	controller.abort();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.error, "cancelled");
	assert.deepEqual(pendingReplyCorrIdsForTarget("target-C"), []);

	terminateLiveAgent("target-C");
});

test("respondAsBackground: recipient delivery is non-blocking", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();

	// A session whose prompt NEVER resolves — simulating a recipient blocked
	// on a long-running turn. The non-blocking invariant requires that
	// respondAsBackground's delivery does NOT await this prompt.
	let promptEntered = false;
	let promptResolve: (() => void) | undefined;
	const blockingPrompt = new Promise<void>((resolve) => {
		promptResolve = resolve;
	});
	const session = {
		// No sendCustomMessage → forces the prompt fallback path.
		prompt: async (_text: string) => {
			promptEntered = true;
			await blockingPrompt; // never resolves until we release it
		},
	};
	registerTarget("target-D", session);

	// Fire-and-forget delivery (awaitReply false): must return immediately.
	const t0 = Date.now();
	const fireForget = await respondAsBackground("target-D", "sender", "ping", {
		awaitReply: false,
	});
	const elapsed = Date.now() - t0;
	assert.equal(fireForget.ok, true);
	assert.ok(elapsed < 100, `fire-and-forget delivery returned promptly (${elapsed}ms)`);
	assert.ok(promptEntered, "prompt was scheduled (fire-and-forget)");

	// awaitReply=true delivery: delivery is still non-blocking; only the
	// reply await blocks. Verify the delivery (prompt scheduling) does not
	// wait for the blocking prompt to resolve.
	const replyPending = respondAsBackground("target-D", "sender", "ping2", {
		awaitReply: true,
		timeoutMs: 50,
	});
	// Give the microtask queue a tick to schedule the prompt.
	await new Promise((r) => setTimeout(r, 5));
	const corrIds = pendingReplyCorrIdsForTarget("target-D");
	assert.ok(corrIds.length >= 1, "reply registered without waiting for blocking prompt");

	const result = await replyPending;
	assert.equal(result.timedOut, true); // timed out because recipient never replied

	// Release the blocking prompt so the process can clean up.
	promptResolve?.();
	terminateLiveAgent("target-D");
});

test("respondAsBackground: target not found returns error", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const result = await respondAsBackground("nope", "sender", "hi", {
		awaitReply: true,
	});
	assert.equal(result.ok, false);
	assert.ok(result.error);
});

test("respondAsBackground: no message channel returns error", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	// Session with neither sendCustomMessage nor prompt.
	registerTarget("target-E", {});
	const result = await respondAsBackground("target-E", "sender", "hi", {
		awaitReply: false,
	});
	assert.equal(result.ok, false);
	assert.ok(result.error);
	terminateLiveAgent("target-E");
});

test("resolveIrcReply / cancelIrcReply return false for unknown corrId", () => {
	clearPendingRepliesForTest();
	assert.equal(resolveIrcReply("unknown", "x"), false);
	assert.equal(cancelIrcReply("unknown"), false);
});

type IrcToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: IrcToolDetails;
};
interface IrcToolDetails {
	delivered?: string[];
	notFound?: string[];
	replies?: Array<{ from: string; text: string }>;
}

function ircExecute(selfId: string): (params: Record<string, unknown>) => Promise<IrcToolResult> {
	const tool = createIrcTool(selfId) as unknown as {
		execute: (id: string, p: unknown, s?: AbortSignal) => Promise<IrcToolResult>;
	};
	return (params) => tool.execute("call", params, undefined);
}

test("irc-tool: awaitReply DM returns reply content to caller", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { session } = makeSession();
	registerTarget("peer-1", session);

	const execute = ircExecute("self");

	// Start the tool call (it will await a reply).
	const pending = execute({ op: "send", to: "peer-1", message: "status?" });

	// Resolve the recipient's reply.
	await new Promise((r) => setTimeout(r, 5));
	const corrIds = pendingReplyCorrIdsForTarget("peer-1");
	assert.equal(corrIds.length, 1);
	resolveIrcReply(corrIds[0]!, "all good");

	const { content, details } = await pending;
	assert.deepEqual(details.delivered, ["peer-1"]);
	assert.ok(details.replies);
	assert.equal(details.replies[0]!.from, "peer-1");
	assert.equal(details.replies[0]!.text, "all good");
	assert.ok(content[0]!.text.includes("all good"));

	terminateLiveAgent("peer-1");
});

test("irc-tool: broadcast ignores awaitReply (fire-and-forget)", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { session } = makeSession();
	registerTarget("peer-2", session);
	registerTarget("peer-3", session);

	const execute = ircExecute("self");

	// Broadcast with awaitReply explicitly true — must NOT await any reply.
	const t0 = Date.now();
	const { details } = await execute({
		op: "send",
		to: "all",
		message: "heads up",
		awaitReply: true,
	});
	const elapsed = Date.now() - t0;

	assert.ok(elapsed < 100, `broadcast returned promptly (${elapsed}ms)`);
	assert.ok((details.delivered ?? []).length >= 1, "broadcast delivered to peers");
	assert.equal(details.replies, undefined, "broadcast never collects replies");
	// No pending replies registered for broadcast.
	assert.deepEqual(pendingReplyCorrIdsForTarget("peer-2"), []);

	terminateLiveAgent("peer-2");
	terminateLiveAgent("peer-3");
});

test("irc-tool: DM awaitReply:false stays fire-and-forget", async () => {
	clearLiveAgentsForTest();
	clearPendingRepliesForTest();
	const { session } = makeSession();
	registerTarget("peer-4", session);

	const execute = ircExecute("self");

	const t0 = Date.now();
	const { details } = await execute({
		op: "send",
		to: "peer-4",
		message: "fyi",
		awaitReply: false,
	});
	const elapsed = Date.now() - t0;

	assert.ok(elapsed < 100, "fire-and-forget DM returned promptly");
	assert.deepEqual(details.delivered, ["peer-4"]);
	assert.equal(details.replies, undefined);
	assert.deepEqual(pendingReplyCorrIdsForTarget("peer-4"), []);

	terminateLiveAgent("peer-4");
});
