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
 * 3. If sharing is not permitted for the role → disable MCP in the session
 *
 * G2 enforcement note (pi ≥0.99): MCP is now a BUILT-IN EXTENSION
 * (`builtin:mcp`, reading `mcp.json`) and the pre-0.99 `enableMcp:false`
 * `createAgentSession` option no longer exists. The runtime enforcement for
 * a non-permitted role therefore drops the MCP extension(s) from the child's
 * resource loader (`extensionsOverride` → `stripMcpExtensions` below).
 * `McpProxyConfig.enableMcp` remains the module's semantic contract: callers
 * can branch on it while E1 (real parent→child proxying) is unbuilt.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { permissionForRole } from "./role-permission.ts";

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
 * @param options.shareMcp — Whether to share MCP connections. MUST be explicit:
 *   `true` enables the discovery/proxy paths below; `false` or `undefined`
 *   denies (security-review follow-up, SDD-2 remediation — the old
 *   undefined-default fell through to the permissive enable paths).
 */
export function buildMcpProxyConfig(options: { parentMcpTools?: string[]; shareMcp?: boolean }): McpProxyConfig {
	if (options.shareMcp !== true) {
		// G2 (SDD-2 W-B) + remediation hardening: least-privilege contract.
		// shareMcp must be explicitly opted in — anything else (false OR
		// undefined) means the child must not discover the parent's MCP
		// servers AT ALL. The pre-flip behavior returned enableMcp:true for
		// shareMcp:false (flag inversion), and the pre-hardening default let
		// an OMITTED flag fall through to the permissive paths — either way
		// even read-only roles self-discovered every parent MCP server (with
		// credentials). These helpers currently have no production call
		// sites; the hardened default exists so a future caller cannot
		// re-open the gap by forgetting the flag.
		return { enableMcp: false, proxyTools: [], proxyToolNames: [] };
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

/**
 * G2 (SDD-2 W-B): the role-permission signal that decides `shareMcp` at the
 * spawn sites. MCP servers carry the parent's credentials and can mutate
 * state far outside the workspace, so only WRITE-capable roles may discover
 * them. Read-only roles (explorer/reviewer/security-reviewer/analyst/
 * critic/planner) are denied; unknown and undefined roles resolve to
 * read-only via `permissionForRole`'s FIND-12 default-deny and are denied
 * too. AgentConfig has no `mcp` field — this permission classification is
 * the existing explicit signal (same source `filterActiveTools` uses).
 */
export function mcpPermittedForRole(role: string | undefined): boolean {
	return permissionForRole(role ?? "") !== "read_only";
}

/**
 * Identify the extensions that provide MCP connectivity in pi ≥0.99:
 * - `builtin:mcp` — the built-in MCP extension (reads `mcp.json`);
 * - third-party extensions that REPLACE it by registering `/mcp` — pi's own
 *   docs name `pi-mcp-adapter` as the canonical replacer (docs/mcp.md:
 *   "replaces the built-in MCP support"). Both must be dropped to actually
 *   deny MCP; a path-segment match keeps npm-installed and file-path forms.
 *
 * KNOWN LIMITATION (security-review follow-up): this is a NAME-based
 * denylist. A third-party MCP adapter that registers `/mcp` under a
 * different name is NOT stripped and would re-enable discovery for
 * non-permitted roles on the live-session path. An allowlist-shaped
 * extension filter is the root fix — tracked as a follow-up work item
 * (SDD-2 §13, G2 hardening backlog).
 */
export function isMcpExtensionPath(extensionPath: string): boolean {
	if (extensionPath === "builtin:mcp") return true;
	return extensionPath.includes("pi-mcp-adapter");
}

/**
 * G2 enforcement-degradation detector (security-review follow-up): the
 * live-session runtime enforces the role MCP policy by stripping MCP
 * extensions through `DefaultResourceLoader`'s `extensionsOverride` hook.
 * If the SDK stops exporting `DefaultResourceLoader` (version drift) or the
 * agent dir cannot be resolved, that strip silently degrades to fail-open
 * and a non-permitted role would re-inherit every parent MCP server with
 * no diagnostic. Callers should emit a warning event when this returns a
 * reason instead of `undefined`.
 */
export function g2EnforcementDegradationReason(input: {
	mcpPermitted: boolean;
	resourceLoaderAvailable: boolean;
}): "sdk_loader_missing" | undefined {
	if (input.mcpPermitted) return undefined;
	return input.resourceLoaderAvailable ? undefined : "sdk_loader_missing";
}

/** Structural stand-in for the SDK's `LoadExtensionsResult` (loose typing —
 * the live-session runtime holds the SDK behind `Record<string, unknown>`). */
export interface LoadedExtensionsShape {
	extensions: Array<{ path: string; [key: string]: unknown }>;
	errors?: unknown;
	warnings?: Array<{ path: string; warning: string }>;
	runtime?: unknown;
	[key: string]: unknown;
}

/**
 * `DefaultResourceLoader` `extensionsOverride` hook (G2 enforcement on
 * pi ≥0.99): drop every MCP-providing extension from the child's extension
 * list so a non-permitted role neither loads the MCP code nor connects to
 * any server. Stripped paths are recorded as warnings for diagnostics.
 */
export function stripMcpExtensions(base: LoadedExtensionsShape): LoadedExtensionsShape {
	const kept = base.extensions.filter((extension) => !isMcpExtensionPath(extension.path));
	if (kept.length === base.extensions.length) return base;
	const stripped = base.extensions.filter((extension) => isMcpExtensionPath(extension.path));
	return {
		...base,
		extensions: kept,
		warnings: [
			...(base.warnings ?? []),
			...stripped.map((extension) => ({
				path: extension.path,
				warning: "stripped by pi-crew G2 role MCP policy (role is not MCP-permitted)",
			})),
		],
	};
}
