/**
 * G1: Custom tool — irc.
 *
 * Registers a real `irc` tool in the Pi SDK session so that
 * live-session workers can send messages to other live agents.
 *
 * Operations:
 * - `list`: List currently visible peer agents
 * - `send`: Send a message to a specific agent or broadcast to all
 *
 * Adapted from oh-my-pi's `IrcTool` pattern. Uses the live-agent-manager
 * for routing messages between in-process workers.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { listLiveAgents, sendIrcMessage, broadcastIrcMessage } from "../live-agent-manager.ts";
import type { IrcMessage } from "../live-irc.ts";

const IrcParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("send", { description: "Send a message to one peer or to all peers." }),
			Type.Literal("list", { description: "List currently visible peers." }),
		],
		{ description: "IRC operation." },
	),
	to: Type.Optional(
		Type.String({
			description: 'Recipient agent ID or "all" to broadcast.',
		}),
	),
	message: Type.Optional(
		Type.String({
			description: "Message body to deliver.",
		}),
	),
	awaitReply: Type.Optional(
		Type.Boolean({
			description: "Wait for a reply (default: true for DM, false for broadcast). Not yet supported — messages are fire-and-forget.",
		}),
	),
});

type IrcParams = Static<typeof IrcParams>;

interface IrcDetails {
	op: "send" | "list";
	from?: string;
	to?: string;
	delivered?: string[];
	notFound?: string[];
	peers?: Array<{ id: string; status: string }>;
	error?: string;
}

/**
 * Create an `irc` tool definition for a specific agent.
 *
 * @param selfId — This agent's ID (runId:taskId format)
 */
export function createIrcTool(
	selfId: string,
): ToolDefinition<typeof IrcParams, IrcDetails> {
	return defineTool({
		name: "irc",
		label: "IRC",
		description:
			"Send messages to other live agents in same team. " +
			'Use `op: "list"` to see peers, `op: "send"` with `to` (agent ID or "all") and `message` to communicate.',
		parameters: IrcParams,
		promptSnippet: "Send messages to other live agents via the irc tool",
		promptGuidelines: [
			"Use irc to coordinate with other agents when you need information or want to share findings.",
			'Use `op: "list"` first to discover available peers.',
		],
		async execute(
			_toolCallId: string,
			params: IrcParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: IrcDetails }> {
			if (params.op === "list") {
				return executeList(selfId);
			}
			if (params.op === "send") {
				return executeSend(selfId, params);
			}
			return {
				content: [{ type: "text", text: "Unknown irc op." }],
				details: { op: params.op, from: selfId, error: "Unknown operation." },
			};
		},
	});
}

function executeList(selfId: string): { content: Array<{ type: "text"; text: string }>; details: IrcDetails } {
	const agents = listLiveAgents();
	const peers = agents
		.filter((a) => a.agentId !== selfId && (a.status === "running" || a.status === "queued"))
		.map((a) => ({ id: a.agentId, status: a.status }));

	const lines: string[] = [];
	if (peers.length === 0) {
		lines.push("No other live agents.");
	} else {
		lines.push(`${peers.length} peer(s):`);
		for (const peer of peers) {
			lines.push(`- ${peer.id} (${peer.status})`);
		}
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "list", from: selfId, peers },
	};
}

function executeSend(
	selfId: string,
	params: IrcParams,
): { content: Array<{ type: "text"; text: string }>; details: IrcDetails } {
	const to = params.to?.trim();
	const message = params.message?.trim();

	if (!to) {
		return {
			content: [{ type: "text", text: '`to` is required for op="send".' }],
			details: { op: "send", from: selfId, error: "Missing 'to' field." },
		};
	}
	if (!message) {
		return {
			content: [{ type: "text", text: '`message` is required for op="send".' }],
			details: { op: "send", from: selfId, to, error: "Missing 'message' field." },
		};
	}
	if (to === selfId) {
		return {
			content: [{ type: "text", text: "Cannot send a message to yourself." }],
			details: { op: "send", from: selfId, to, error: "Self-message not allowed." },
		};
	}

	const ircMessage: IrcMessage = {
		from: selfId,
		to,
		content: message,
		timestamp: new Date().toISOString(),
		awaitReply: params.awaitReply,
	};

	const notFound: string[] = [];
	const delivered: string[] = [];

	try {
		if (to === "all") {
			const recipients = broadcastIrcMessage(selfId, ircMessage);
			delivered.push(...recipients);
		} else {
			// DM to specific agent
			const agents = listLiveAgents();
			const target = agents.find((a) => a.agentId === to);
			if (!target || (target.status !== "running" && target.status !== "queued")) {
				notFound.push(to);
			} else {
				try {
					sendIrcMessage(to, ircMessage);
					delivered.push(to);
				} catch {
					notFound.push(to);
				}
			}
		}
	} catch {
		// Agent deregistered during routing — treat as not found
		notFound.push(to);
	}

	const lines: string[] = [];
	if (delivered.length > 0) {
		lines.push(`Delivered to ${delivered.length} peer(s): ${delivered.join(", ")}`);
	} else {
		lines.push("No recipients received the message.");
	}
	if (notFound.length > 0) {
		lines.push(`Unknown / unavailable peers: ${notFound.join(", ")}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			op: "send",
			from: selfId,
			to,
			delivered: delivered.length > 0 ? delivered : undefined,
			notFound: notFound.length > 0 ? notFound : undefined,
		},
	};
}
