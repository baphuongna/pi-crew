/**
 * Phase 7: Inter-agent communication for live-session workers.
 *
 * Provides IRC-like messaging between live-session workers, adapted from
 * oh-my-pi's IrcTool pattern. Uses the existing LiveAgentHandle manager
 * for message routing.
 *
 * Features:
 * - DM: Send a message to a specific agent
 * - Broadcast: Send a message to all live agents
 * - Side-channel: Non-blocking message injection (via pendingFollowUps)
 *
 * For child-process workers, messages fall back to file-based mailbox.
 */

export type IrcOperation = "send" | "list";

export interface IrcMessage {
	from: string;
	to: string;
	content: string;
	timestamp: string;
	/** Whether the sender expects a reply. */
	awaitReply?: boolean;
}

export interface IrcSendMessage {
	op: IrcOperation;
	/** Target agent ID or "all" for broadcast. */
	to: string;
	/** Message content. */
	message: string;
	/** Whether to wait for a reply (default: true for DM, false for broadcast). */
	awaitReply?: boolean;
}

export interface IrcListResult {
	peers: Array<{ id: string; name: string; status: string }>;
}

/**
 * Build IRC peer roster for injection into system prompt.
 * Lists all currently live agents except the caller.
 */
export function renderIrcPeerRoster(selfId: string, peers: Array<{ agentId: string; status: string }>): string {
	const visible = peers.filter((p) => p.agentId !== selfId && (p.status === "running" || p.status === "idle"));
	if (visible.length === 0) return "- (no other live agents)";
	return visible.map((peer) => `- \`${peer.agentId}\` (${peer.status})`).join("\n");
}

/**
 * Build the IRC system prompt section for a live-session worker.
 */
/** @internal */
function buildIrcSystemSection(selfId: string, peers: Array<{ agentId: string; status: string }>): string {
	const roster = renderIrcPeerRoster(selfId, peers);
	return [
		"## Inter-Agent Communication",
		`Your agent ID: \`${selfId}\``,
		"You can send messages to other live agents via the `irc` tool.",
		"Available peers:",
		roster,
	].join("\n");
}

/**
 * Route an IRC message to the appropriate agent(s).
 * Returns the list of agent IDs that received the message.
 */
/** @internal */
function routeIrcMessage(
	message: IrcSendMessage,
	selfId: string,
	routing: {
		sendDm: (agentId: string, content: string) => void;
		broadcast: (content: string, excludeId: string) => string[];
	},
): { deliveredTo: string[]; error?: string } {
	if (!message.to || !message.message?.trim()) {
		return {
			deliveredTo: [],
			error: "Missing 'to' (agent ID or 'all') and 'message' fields.",
		};
	}
	if (message.to === selfId) {
		return { deliveredTo: [], error: "Cannot send a message to yourself." };
	}

	if (message.to === "all") {
		const recipients = routing.broadcast(message.message, selfId);
		return { deliveredTo: recipients };
	}

	// DM to specific agent
	routing.sendDm(message.to, message.message);
	return { deliveredTo: [message.to] };
}
