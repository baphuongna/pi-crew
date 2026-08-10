import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface AgentProgress {
	toolCalls: number;
	currentTool: string | null;
	toolStartTime: number | null;
	errors: string[];
	turns: number;
	tokens: { input: number; output: number };
	status: "idle" | "running" | "completed" | "error";
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
		_runId: string,
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
			this.handleEvent(event, progress);
		});

		this.sessions.set(agentId, { unsubscribe, progress });
		return progress;
	}

	private handleEvent(event: AgentSessionEvent, progress: AgentProgress): void {
		switch (event.type) {
			case "tool_execution_start":
				progress.toolCalls++;
				progress.currentTool = event.toolName;
				progress.toolStartTime = Date.now();
				break;

			case "tool_execution_end":
				progress.currentTool = null;
				progress.toolStartTime = null;
				if (event.isError) {
					progress.errors.push(String(event.result ?? "Unknown error"));
				}
				break;

			case "turn_start":
				progress.turns++;
				break;

			case "agent_end":
				progress.status = "completed";
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
}

export const globalProgressTracker = new ProgressTracker();
