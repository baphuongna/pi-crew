import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import type { MetricSnapshot } from "../observability/metrics-primitives.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { readCrewAgents } from "./crew-agent-records.ts";
import { readEvents, type TeamEvent } from "../state/event-log.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { summarizeHeartbeats, type HeartbeatSummary } from "../ui/heartbeat-aggregator.ts";
import type { RunUiSnapshot } from "../ui/snapshot-types.ts";
import { redactSecrets } from "../utils/redaction.ts";
export { redactSecrets } from "../utils/redaction.ts";

export interface DiagnosticReport {
	schemaVersion?: number;
	runId: string;
	exportedAt: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	recentEvents: TeamEvent[];
	heartbeat: HeartbeatSummary;
	agents: unknown[];
	envRedacted: Record<string, string>;
	metricsSnapshot?: MetricSnapshot[];
}

const SECRET_KEY_PATTERN = /(token|key|password|secret|credential|auth)/i;

function envRedacted(): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (SECRET_KEY_PATTERN.test(key)) output[key] = "***";
		else if (typeof value === "string") output[key] = value;
	}
	return output;
}

function buildSnapshot(manifest: TeamRunManifest, tasks: TeamTaskState[]): RunUiSnapshot {
	const agents = readCrewAgents(manifest);
	return {
		runId: manifest.runId,
		cwd: manifest.cwd,
		fetchedAt: Date.now(),
		signature: `${manifest.runId}:${manifest.updatedAt}`,
		manifest,
		tasks,
		agents,
		progress: {
			total: tasks.length,
			completed: tasks.filter((task) => task.status === "completed").length,
			running: tasks.filter((task) => task.status === "running").length,
			failed: tasks.filter((task) => task.status === "failed").length,
			queued: tasks.filter((task) => task.status === "queued").length,
		},
		usage: { tokensIn: 0, tokensOut: 0, toolUses: 0 },
		mailbox: { inboxUnread: 0, outboxPending: 0, needsAttention: 0 },
		recentEvents: [],
		recentOutputLines: [],
	};
}

export async function exportDiagnostic(ctx: Pick<ExtensionContext, "cwd">, runId: string, options: { registry?: MetricRegistry } = {}): Promise<{ path: string; report: DiagnosticReport }> {
	const loaded = loadRunManifestById(ctx.cwd, runId);
	if (!loaded) throw new Error(`Run '${runId}' not found.`);
	const exportedAt = new Date().toISOString();
	const safeTimestamp = exportedAt.replace(/[:.]/g, "-");
	const recentEvents = readEvents(loaded.manifest.eventsPath).slice(-200);
	const metricsSnapshot = options.registry?.snapshot();
	const report: DiagnosticReport = {
		...(metricsSnapshot ? { schemaVersion: 2 } : {}),
		runId,
		exportedAt,
		manifest: redactSecrets(loaded.manifest) as TeamRunManifest,
		tasks: redactSecrets(loaded.tasks) as TeamTaskState[],
		recentEvents: redactSecrets(recentEvents) as TeamEvent[],
		heartbeat: summarizeHeartbeats(buildSnapshot(loaded.manifest, loaded.tasks)),
		agents: redactSecrets(readCrewAgents(loaded.manifest)) as unknown[],
		envRedacted: envRedacted(),
		...(metricsSnapshot ? { metricsSnapshot: redactSecrets(metricsSnapshot) as MetricSnapshot[] } : {}),
	};
	const dir = path.join(loaded.manifest.artifactsRoot, "diagnostic");
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `diagnostic-${safeTimestamp}.json`);
	fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
	return { path: filePath, report };
}

export function listRecentDiagnostic(dir: string, windowMs: number, now = Date.now()): string | undefined {
	try {
		if (!fs.existsSync(dir)) return undefined;
		return fs.readdirSync(dir)
			.filter((file) => file.startsWith("diagnostic-") && file.endsWith(".json"))
			.map((file) => ({ file, mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs }))
			.filter((entry) => now - entry.mtimeMs < windowMs)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
	} catch {
		return undefined;
	}
}
