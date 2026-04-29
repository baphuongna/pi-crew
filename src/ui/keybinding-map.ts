export const DASHBOARD_KEYS = {
	close: ["q", "\u001b"],
	select: ["\r", "\n", "s"],
	root: {
		summary: ["u"],
		artifacts: ["a"],
		api: ["i"],
		agents: ["d"],
		mailbox: ["m"],
		events: ["e"],
		output: ["o"],
		transcript: ["v"],
		reload: ["r"],
		progressToggle: ["p"],
	},
	pane: { agents: ["1"], progress: ["2"], mailbox: ["3"], output: ["4"], health: ["5"], metrics: ["6"] },
	navigation: { up: ["k", "\u001b[A"], down: ["j", "\u001b[B"] },
	mailbox: { ack: ["A"], nudge: ["N"], compose: ["C"], preview: ["P"], ackAll: ["X"], openDetail: ["\r", "\n"] },
	health: { recovery: ["R"], killStale: ["K"], diagnosticExport: ["D"] },
	notification: { dismissAll: ["H"] },
} as const;

export const KEY_RESERVED = new Set<string>([
	...DASHBOARD_KEYS.close,
	...DASHBOARD_KEYS.select,
	...Object.values(DASHBOARD_KEYS.root).flat(),
	...Object.values(DASHBOARD_KEYS.pane).flat(),
	...Object.values(DASHBOARD_KEYS.navigation).flat(),
	...Object.values(DASHBOARD_KEYS.mailbox).flat(),
	...Object.values(DASHBOARD_KEYS.health).flat(),
	...Object.values(DASHBOARD_KEYS.notification).flat(),
]);

function includes(values: readonly string[], data: string): boolean {
	return values.includes(data);
}

export type DashboardKeyAction =
	| "close"
	| "select"
	| "summary"
	| "artifacts"
	| "api"
	| "agents"
	| "mailbox"
	| "events"
	| "output"
	| "transcript"
	| "reload"
	| "progressToggle"
	| "pane-agents"
	| "pane-progress"
	| "pane-mailbox"
	| "pane-output"
	| "pane-health"
	| "pane-metrics"
	| "up"
	| "down"
	| "mailbox-detail"
	| "health-recovery"
	| "health-kill-stale"
	| "health-diagnostic-export"
	| "notifications-dismiss";

export function dashboardActionForKey(data: string, activePane?: "agents" | "progress" | "mailbox" | "output" | "health" | "metrics"): DashboardKeyAction | undefined {
	if (includes(DASHBOARD_KEYS.close, data)) return "close";
	if (activePane === "mailbox" && includes(DASHBOARD_KEYS.mailbox.openDetail, data)) return "mailbox-detail";
	if (activePane === "health") {
		if (includes(DASHBOARD_KEYS.health.recovery, data)) return "health-recovery";
		if (includes(DASHBOARD_KEYS.health.killStale, data)) return "health-kill-stale";
		if (includes(DASHBOARD_KEYS.health.diagnosticExport, data)) return "health-diagnostic-export";
	}
	if (includes(DASHBOARD_KEYS.notification.dismissAll, data)) return "notifications-dismiss";
	if (includes(DASHBOARD_KEYS.select, data)) return "select";
	if (includes(DASHBOARD_KEYS.root.summary, data)) return "summary";
	if (includes(DASHBOARD_KEYS.root.artifacts, data)) return "artifacts";
	if (includes(DASHBOARD_KEYS.root.api, data)) return "api";
	if (includes(DASHBOARD_KEYS.root.agents, data)) return "agents";
	if (includes(DASHBOARD_KEYS.root.mailbox, data)) return "mailbox";
	if (includes(DASHBOARD_KEYS.root.events, data)) return "events";
	if (includes(DASHBOARD_KEYS.root.output, data)) return "output";
	if (includes(DASHBOARD_KEYS.root.transcript, data)) return "transcript";
	if (includes(DASHBOARD_KEYS.root.reload, data)) return "reload";
	if (includes(DASHBOARD_KEYS.root.progressToggle, data)) return "progressToggle";
	if (includes(DASHBOARD_KEYS.pane.agents, data)) return "pane-agents";
	if (includes(DASHBOARD_KEYS.pane.progress, data)) return "pane-progress";
	if (includes(DASHBOARD_KEYS.pane.mailbox, data)) return "pane-mailbox";
	if (includes(DASHBOARD_KEYS.pane.output, data)) return "pane-output";
	if (includes(DASHBOARD_KEYS.pane.health, data)) return "pane-health";
	if (includes(DASHBOARD_KEYS.pane.metrics, data)) return "pane-metrics";
	if (includes(DASHBOARD_KEYS.navigation.up, data)) return "up";
	if (includes(DASHBOARD_KEYS.navigation.down, data)) return "down";
	return undefined;
}
