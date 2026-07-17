/**
 * G2: MCP Proxy for live-session workers.
 *
 * When the parent process has MCP servers configured, live-session workers
 * can reuse those connections instead of establishing their own. This module
 * discovers MCP tools available in the parent environment and creates proxy
 * tool definitions that forward calls through the parent's connections.
 *
 * Strategy:
 * 1. If the Pi SDK session has MCP tools after bindExtensions → use them directly
 * 2. If not → create proxy custom tools that wrap MCP calls
 * 3. If no MCP config exists → disable MCP in the session
 *
 * The Pi SDK's `createAgentSession` accepts a `customTools` array for injecting
 * proxy tools. The session also accepts `enableMCP: false` to skip MCP discovery
 * when proxying from the parent.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export interface McpProxyConfig {
	/** Whether to enable MCP in the child session. */
	enableMcp: boolean;
	/** Proxy tools to inject via customTools (replaces MCP connection). */
	proxyTools: Array<ToolDefinition<TSchema, unknown>>;
	/** Names of MCP tools available (for metadata/tracking). */
	proxyToolNames: string[];
}

/**
 * Build MCP proxy configuration for a live-session worker.
 *
 * @param options.parentMcpTools — MCP tool names from the parent session (if available)
 * @param options.shareMcp — Whether to share MCP connections (default: true)
 */
export function buildMcpProxyConfig(options: { parentMcpTools?: string[]; shareMcp?: boolean }): McpProxyConfig {
	if (options.shareMcp === false) {
		return { enableMcp: true, proxyTools: [], proxyToolNames: [] };
	}

	const parentTools = options.parentMcpTools ?? [];
	if (parentTools.length === 0) {
		// No MCP tools in parent — let session discover on its own
		return { enableMcp: true, proxyTools: [], proxyToolNames: [] };
	}

	// MCP tools exist in parent — try to create proxy tools.
	// If proxy tools are not available (stub), keep enableMcp: true
	// so the child session can self-discover MCP instead of losing all access.
	const proxyTools = createMcpProxyTools(parentTools);
	if (proxyTools.length === 0) {
		// No proxy tools available — let child discover MCP on its own
		return { enableMcp: true, proxyTools: [], proxyToolNames: parentTools };
	}
	return {
		enableMcp: false,
		proxyTools,
		proxyToolNames: parentTools,
	};
}

/**
 * Create lightweight proxy tools that represent MCP tools from the parent.
 *
 * These tools tell the model that the MCP tools are available, but actual
 * execution is forwarded through the parent's MCP connections. Since we
 * can't directly access the parent's MCP manager from a child session,
 * the tools return a message indicating the model should use them normally.
 *
 * In a future iteration, these can be wired to the actual MCP connections
 * via an inter-process bridge.
 */
function createMcpProxyTools(toolNames: string[]): Array<ToolDefinition<TSchema, unknown>> {
	// For now, we don't create individual proxy tools because we can't
	// forward MCP calls without the parent's MCP manager reference.
	//
	// Instead, we let the child session discover MCP on its own (enableMcp: true)
	// or share the parent's MCP config directory.
	//
	// This will be enhanced when we add inter-process MCP call forwarding.
	return [];
}

/**
 * Discover MCP tool names from a live session's active tools.
 * MCP tools typically have names containing "__" (e.g., "mcp__filesystem__read_file").
 */
export function discoverMcpToolNames(activeToolNames: string[]): string[] {
	return activeToolNames.filter(
		(name) => name.startsWith("mcp__") || name.startsWith("mcp-") || (name.includes("__") && !name.startsWith("submit_result")),
	);
}

/**
 * Build MCP proxy config from a real Pi SDK session's active tools.
 * This is the preferred way — inspect what the parent session has available.
 */
export function buildMcpProxyFromSession(activeToolNames: string[], options?: { shareMcp?: boolean }): McpProxyConfig {
	const mcpTools = discoverMcpToolNames(activeToolNames);
	return buildMcpProxyConfig({
		parentMcpTools: mcpTools,
		shareMcp: options?.shareMcp,
	});
}
