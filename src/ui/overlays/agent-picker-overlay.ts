import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { loadRunManifestById } from "../../state/state-store.ts";
import { pad, truncate } from "../../utils/visual.ts";
import { keyOf } from "../key-utils.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";

export interface AgentPickerSelection {
	agentId: string;
}

export class AgentPickerOverlay {
	private readonly agents: CrewAgentRecord[];
	private readonly done: (selection: AgentPickerSelection | undefined) => void;
	private readonly theme: CrewTheme;
	private selected = 0;

	constructor(opts: {
		cwd: string;
		runId: string;
		done: (selection: AgentPickerSelection | undefined) => void;
		theme?: unknown;
	}) {
		const loaded = loadRunManifestById(opts.cwd, opts.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		this.agents = loaded ? readCrewAgents(loaded.manifest) : [];
		this.done = opts.done;
		this.theme = asCrewTheme(opts.theme ?? {});
	}

	invalidate(): void {
		// Agent list is captured at open time.
	}

	render(width: number): string[] {
		const inner = Math.max(24, width - 4);
		const lines = [
			this.theme.bold("Select agent"),
			"↑/↓ move · Enter select · ESC cancel",
			...this.agents.map(
				(agent, index) =>
					`${index === this.selected ? "›" : " "} ${agent.taskId} · ${agent.status} · ${agent.role}->${agent.agent}`,
			),
		];
		if (!this.agents.length) lines.push("No agents found.");
		return lines.map((line) => pad(truncate(line, inner), inner));
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "k" || keyOf(data) === "up") {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (data === "j" || keyOf(data) === "down") {
			this.selected = Math.min(Math.max(0, this.agents.length - 1), this.selected + 1);
			return;
		}
		if (data === "\r" || data === "\n") {
			const agent = this.agents[this.selected];
			this.done(agent ? { agentId: agent.taskId } : undefined);
		}
	}
}
