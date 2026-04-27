import type { CrewUiConfig } from "../config/config.ts";
import { listRecentRuns } from "../extension/run-index.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";

type EventBus = { emit?: (event: string, data: unknown) => void } | undefined;

function safeEmit(events: EventBus, event: string, data: unknown): void {
	try { events?.emit?.(event, data); } catch {}
}

export function registerPiCrewPowerbarSegments(events: EventBus, config?: CrewUiConfig): void {
	if (config?.powerbar === false) return;
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-active", label: "pi-crew active agents" });
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-progress", label: "pi-crew run progress" });
}

export function updatePiCrewPowerbar(events: EventBus, cwd: string, config?: CrewUiConfig): void {
	if (config?.powerbar === false) return;
	const active = listRecentRuns(cwd, 20).map((run) => {
		let agents = [] as ReturnType<typeof readCrewAgents>;
		try { agents = readCrewAgents(run); } catch {}
		return { run, agents };
	}).filter((item) => isDisplayActiveRun(item.run, item.agents));
	if (!active.length) {
		safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
		return;
	}
	const agents = active.flatMap((item) => item.agents);
	const running = agents.filter((agent) => agent.status === "running").length;
	const queued = agents.filter((agent) => agent.status === "queued").length;
	const completed = agents.filter((agent) => agent.status === "completed").length;
	const total = Math.max(1, agents.length);
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-active",
		icon: "⚙",
		text: `crew ${running || active.length}`,
		suffix: queued ? `${queued}q` : undefined,
		color: running ? "accent" : "warning",
	});
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-progress",
		text: active[0]?.run.team ?? "crew",
		bar: Math.round((completed / total) * 100),
		suffix: `${completed}/${total}`,
		color: completed === total ? "success" : "accent",
		barSegments: 8,
	});
}

export function clearPiCrewPowerbar(events: EventBus): void {
	safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
}
