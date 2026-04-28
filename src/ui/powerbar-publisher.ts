import * as fs from "node:fs";
import { listRecentRuns } from "../extension/run-index.ts";
import type { CrewUiConfig } from "../config/config.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";
import { readJsonFileCoalesced } from "../utils/file-coalescer.ts";
import type { TeamTaskState, TeamRunManifest } from "../state/types.ts";
import { aggregateUsage } from "../state/usage.ts";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { ManifestCache } from "../runtime/manifest-cache.ts";

type EventBus = { emit?: (event: string, data: unknown) => void } | undefined;

const TASK_READ_TTL_MS = 200;

function safeEmit(events: EventBus, event: string, data: unknown): void {
	try {
		events?.emit?.(event, data);
	} catch (error) {
		logInternalError("powerbar.safeEmit", error, `event=${event}`);
	}
}

function readTasks(tasksPath: string): TeamTaskState[] {
	try {
		const parse = () => {
			const parsed = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
			return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
		};
		return readJsonFileCoalesced(tasksPath, TASK_READ_TTL_MS, parse);
	} catch (error) {
		logInternalError("powerbar.readTasks", error, tasksPath);
		return [];
	}
}

export function compactTokens(total: number): string {
	return total >= 1000 ? `${Math.round(total / 1000)}k` : `${total}`;
}

export function registerPiCrewPowerbarSegments(events: EventBus, config?: CrewUiConfig): void {
	if (config?.powerbar === false) return;
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-active", label: "pi-crew active agents" });
	safeEmit(events, "powerbar:register-segment", { id: "pi-crew-progress", label: "pi-crew run progress" });
}

export function updatePiCrewPowerbar(events: EventBus, cwd: string, config?: CrewUiConfig, manifestCache?: ManifestCache): void {
	if (config?.powerbar === false) return;
	const runs = manifestCache ? manifestCache.list(20) : listRecentRuns(cwd, 20);
	const active = runs.map((run) => {
		let agents: ReturnType<typeof readCrewAgents> = [];
		try {
			agents = readCrewAgents(run);
		} catch (error) {
			logInternalError("powerbar.readCrewAgents", error, run.runId);
		}
		return { run, agents };
	}).filter((item) => isDisplayActiveRun(item.run, item.agents));
	if (!active.length) {
		safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
		safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
		return;
	}
	const agents = active.flatMap((item) => item.agents);
	const tasks = active.flatMap((item) => readTasks(item.run.tasksPath));
	const running = agents.filter((agent) => agent.status === "running").length;
	const waiting = tasks.filter((task) => task.status === "queued").length;
	const completed = tasks.filter((task) => task.status === "completed").length;
	const total = Math.max(1, tasks.length || agents.length);
	const usage = aggregateUsage(tasks);
	const tokenTotal = usage ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
	const model = config?.showModel === false ? undefined : agents.find((agent) => agent.model)?.model?.split("/").at(-1);
	const tokenText = config?.showTokens === false || !tokenTotal ? undefined : compactTokens(tokenTotal);
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-active",
		icon: "⚙",
		text: `crew ${running}a/${waiting}w`,
		suffix: [model, tokenText].filter(Boolean).join(" · ") || undefined,
		color: running ? "accent" : "warning",
	});
	safeEmit(events, "powerbar:update", {
		id: "pi-crew-progress",
		text: (active[0]?.run as TeamRunManifest)?.team ?? "crew",
		bar: Math.round((completed / total) * 100),
		suffix: `${completed}/${total}${tokenText ? ` · ${tokenText}` : ""}`,
		color: completed === total ? "success" : "accent",
		barSegments: 8,
	});
}

export function clearPiCrewPowerbar(events: EventBus): void {
	safeEmit(events, "powerbar:update", { id: "pi-crew-active" });
	safeEmit(events, "powerbar:update", { id: "pi-crew-progress" });
}
