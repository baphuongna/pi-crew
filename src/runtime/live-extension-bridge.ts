/**
 * G5: Extension runner bridge for live-session workers.
 *
 * Bridges pi-crew's extension lifecycle with the Pi SDK session's
 * extension runner. Verified against actual SDK API surface:
 *
 * Session methods:
 *   - sendCustomMessage(message, options?)
 *   - sendUserMessage(content, options?)
 *   - getActiveToolNames() / setActiveToolsByName()
 *   - getAllTools() / getToolDefinition()
 *   - steer(text) / prompt(text, options?)
 *   - abort()
 *   - getContextUsage()
 *   - bindExtensions()
 *   - compact()
 *   - getSessionStats()
 *
 * ExtensionRunner methods:
 *   - initialize(apis, host)
 *   - emit(event)
 *   - hasHandlers(eventType)
 *   - getAllRegisteredTools()
 *   - onError(listener)
 *   - shutdown()
 *
 * ExtensionContext actions (via registerTool):
 *   - sendMessage / sendUserMessage / appendEntry / setLabel
 *   - setActiveTools / getActiveTools / getAllTools
 */


export interface ExtensionBridgeApis {
	sendMessage: (message: unknown, options?: Record<string, unknown>) => void;
	sendUserMessage: (content: unknown, options?: Record<string, unknown>) => void;
	appendEntry: (customType: string, data: unknown) => void;
	setLabel: (targetId: string, label: string) => void;
	getActiveTools: () => string[];
	getAllTools: () => string[];
	setActiveTools: (toolNames: string[]) => void;
}

export interface ExtensionHostApis {
	getModel: () => unknown;
	isIdle: () => boolean;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => unknown;
	getSystemPrompt: () => string;
}

/**
 * Pi SDK session-like object with the methods we need.
 * Verified against actual `createAgentSession().session` prototype.
 */
interface PiSdkSession {
	sendCustomMessage: (message: unknown, options?: Record<string, unknown>) => void;
	sendUserMessage: (content: unknown, options?: Record<string, unknown>) => void;
	getActiveToolNames: () => string[];
	getAllTools: () => string[];
	setActiveToolsByName: (toolNames: string[]) => void;
	steer: (text: string) => Promise<void>;
	prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
	abort: () => void | Promise<void>;
	getContextUsage: () => unknown;
	subscribe: (listener: (event: unknown) => void) => () => void;
	bindExtensions: (bindings?: Record<string, unknown>) => Promise<void>;
	compact: (options?: unknown) => void;
	getSessionStats: () => unknown;
	isStreaming?: boolean;
	model?: unknown;
	systemPrompt?: string;
	pendingMessageCount?: number;
}

/**
 * Build extension bridge APIs from a Pi SDK session.
 * Returns null if the session doesn't support extension running.
 */
export function buildExtensionBridge(session: PiSdkSession): { apis: ExtensionBridgeApis; host: ExtensionHostApis } | null {
	if (typeof session.sendCustomMessage !== "function") return null;

	return {
		apis: {
			sendMessage: (message, options) => {
				try {
					session.sendCustomMessage(message, options);
				} catch {
					/* non-blocking */
				}
			},
			sendUserMessage: (content, options) => {
				try {
					session.sendUserMessage(content, options);
				} catch {
					/* non-blocking */
				}
			},
			appendEntry: () => {
				// appendEntry requires sessionManager access which isn't directly on session
				// This is a no-op placeholder; extensions that rely on it will gracefully degrade
			},
			setLabel: () => {
				// setLabel requires sessionManager access — no-op placeholder
			},
			getActiveTools: () => {
				try {
					return session.getActiveToolNames();
				} catch {
					return [];
				}
			},
			getAllTools: () => {
				try {
					return session.getAllTools();
				} catch {
					return session.getActiveToolNames();
				}
			},
			setActiveTools: (toolNames) => {
				try {
					session.setActiveToolsByName(toolNames);
				} catch {
					/* ignore */
				}
			},
		},
		host: {
			getModel: () => session.model,
			isIdle: () => !session.isStreaming,
			abort: () => {
				void session.abort();
			},
			hasPendingMessages: () => (session.pendingMessageCount ?? 0) > 0,
			shutdown: () => {
				/* no-op for live-session — caller manages session lifecycle */
			},
			getContextUsage: () => {
				try {
					return session.getContextUsage();
				} catch {
					return undefined;
				}
			},
			getSystemPrompt: () => session.systemPrompt ?? "",
		},
	};
}
