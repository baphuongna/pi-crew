import { appendFileSync } from "node:fs";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { crewEventBus } from "../observability/event-bus.ts";

export interface AgentProgress {
	toolCalls: number;
	currentTool: string | null;
	toolStartTime: number | null;
	errors: string[];
	turns: number;
	tokens: { input: number; output: number };
	status: "idle" | "running" | "completed" | "error";
	/** Most recent partial assistant text (for live streaming display). */
	partialText?: string;
}

export class ProgressTracker {
	private sessions = new Map<
		string,
		{
			unsubscribe: () => void;
			progress: AgentProgress;
		}
	>();

	track(
		session: {
			subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
		},
		agentId: string,
		runId: string,
	): AgentProgress {
		if (this.sessions.has(agentId)) {
			return this.sessions.get(agentId)!.progress;
		}

		const progress: AgentProgress = {
			toolCalls: 0,
			currentTool: null,
			toolStartTime: null,
			errors: [],
			turns: 0,
			tokens: { input: 0, output: 0 },
			status: "running",
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			this.handleEvent(event, progress, agentId, runId);
		});

		this.sessions.set(agentId, { unsubscribe, progress });
		return progress;
	}

	private handleEvent(event: AgentSessionEvent, progress: AgentProgress, agentId: string, runId: string): void {
		switch (event.type) {
			case "tool_execution_start":
				progress.toolCalls++;
				progress.currentTool = event.toolName;
				progress.toolStartTime = Date.now();
				crewEventBus.emit({
					type: "agent:progress",
					runId,
					agentId,
					payload: { ...progress },
					timestamp: Date.now(),
				});
				break;

			case "tool_execution_end":
				progress.currentTool = null;
				progress.toolStartTime = null;
				if (event.isError) {
					progress.errors.push(String(event.result ?? "Unknown error"));
					crewEventBus.emit({
						type: "agent:error",
						runId,
						agentId,
						payload: String(event.result ?? "Unknown error"),
						timestamp: Date.now(),
					});
				}
				crewEventBus.emit({
					type: "agent:progress",
					runId,
					agentId,
					payload: { ...progress },
					timestamp: Date.now(),
				});
				break;

			case "turn_start":
				progress.turns++;
				break;

			case "agent_end":
				progress.status = "completed";
				crewEventBus.emit({
					type: "agent:complete",
					runId,
					agentId,
					payload: { ...progress },
					timestamp: Date.now(),
				});
				break;

			case "agent_start":
				progress.status = "running";
				break;
		}
	}

	untrack(agentId: string): void {
		const tracked = this.sessions.get(agentId);
		if (tracked) {
			tracked.unsubscribe();
			this.sessions.delete(agentId);
		}
	}

	getProgress(agentId: string): AgentProgress | undefined {
		return this.sessions.get(agentId)?.progress;
	}

	// ── Child-process worker event bridge ──────────────────────────────────
	//
	// For child-process runtime, events arrive as raw JSON from the child pi
	// process's stdout (via onJsonEvent). These methods bridge those events into
	// the same crewEventBus stream that live-session uses, so the widget shows
	// real-time tool calls and assistant text for BOTH runtimes.

	private workerProgress = new Map<string, AgentProgress>();

	/** Throttle: don't emit more than 1 progress event per 500ms per worker. */
	private lastEmitTs = new Map<string, number>();
	private static readonly EMIT_THROTTLE_MS = 500;

	/**
	 * Handle a raw child-process JSON event (from onJsonEvent callback).
	 * Processes tool_execution_start/end, agent_start/end, and assistant text.
	 */
	handleWorkerEvent(taskId: string, runId: string, event: Record<string, unknown>): void {
		// DEBUG: log to /tmp/pi-crew-streaming-debug.log
		try {
			appendFileSync(
				"/tmp/pi-crew-streaming-debug.log",
				`[event] taskId=${taskId} type=${event.type} tool=${event.toolName ?? "-"}\n`,
			);
		} catch {}
		let progress = this.workerProgress.get(taskId);
		if (!progress) {
			progress = {
				toolCalls: 0,
				currentTool: null,
				toolStartTime: null,
				errors: [],
				turns: 0,
				tokens: { input: 0, output: 0 },
				status: "running",
			};
			this.workerProgress.set(taskId, progress);
		}

		const eventType = typeof event.type === "string" ? event.type : undefined;

		switch (eventType) {
			case "tool_execution_start": {
				progress.toolCalls++;
				progress.currentTool = typeof event.toolName === "string" ? event.toolName : "unknown";
				progress.toolStartTime = Date.now();
				this.emitThrottled(taskId, runId, progress);
				break;
			}
			case "tool_execution_end": {
				progress.currentTool = null;
				progress.toolStartTime = null;
				if (event.isError) {
					progress.errors.push(String(event.result ?? "Unknown error"));
					crewEventBus.emit({
						type: "agent:error",
						runId,
						agentId: taskId,
						payload: String(event.result ?? "Unknown error"),
						timestamp: Date.now(),
					});
				}
				this.emitThrottled(taskId, runId, progress);
				break;
			}
			case "turn_start":
			case "turn_end":
				progress.turns++;
				break;
			case "agent_start":
				progress.status = "running";
				break;
			case "agent_end":
			case "agent_settled":
				progress.status = "completed";
				this.emitThrottled(taskId, runId, progress);
				break;
			case "message":
			case "message_end": {
				// Extract assistant text for streaming display.
				const message = event.message as { role?: string; content?: unknown } | undefined;
				if (message?.role === "assistant") {
					const text = extractWorkerText(message.content);
					if (text) {
						progress.partialText = text.slice(-2000); // keep last 2K chars
						this.emitThrottled(taskId, runId, progress);
					}
				}
				// Track usage from message_end events.
				if (eventType === "message_end" && event.usage && typeof event.usage === "object") {
					const usage = event.usage as { input?: number; output?: number };
					if (typeof usage.input === "number") progress.tokens.input += usage.input;
					if (typeof usage.output === "number") progress.tokens.output += usage.output;
				}
				break;
			}
		}
	}

	/** Get the accumulated progress for a child-process worker task. */
	getWorkerProgress(taskId: string): AgentProgress | undefined {
		return this.workerProgress.get(taskId);
	}

	/** Remove a worker from tracking after completion. */
	untrackWorker(taskId: string): void {
		this.workerProgress.delete(taskId);
		this.lastEmitTs.delete(taskId);
	}

	/**
	 * Emit a progress event to crewEventBus, throttled to avoid flooding
	 * the widget with re-renders (max 1 event per EMIT_THROTTLE_MS per worker).
	 */
	private emitThrottled(taskId: string, runId: string, progress: AgentProgress): void {
		const now = Date.now();
		const last = this.lastEmitTs.get(taskId) ?? 0;
		if (now - last < ProgressTracker.EMIT_THROTTLE_MS) return;
		this.lastEmitTs.set(taskId, now);
		crewEventBus.emit({
			type: "agent:progress",
			runId,
			agentId: taskId,
			payload: { ...progress },
			timestamp: now,
		});
	}
}

// Export singleton instance
export const globalProgressTracker = new ProgressTracker();

/**
 * Extract text content from a worker message's content field.
 * Handles string content and array-of-parts (like extractTextContent in context.ts).
 */
function extractWorkerText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && !Array.isArray(part) && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.filter(Boolean)
		.join("\n");
}
