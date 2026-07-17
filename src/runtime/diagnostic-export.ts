import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import type { MetricSnapshot } from "../observability/metrics-primitives.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { readEvents, type TeamEvent } from "../state/event-log.ts";
import { loadRunManifestById } from "../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { type HeartbeatSummary, summarizeHeartbeats } from "../ui/heartbeat-aggregator.ts";
import type { RunUiSnapshot } from "../ui/snapshot-types.ts";
import { isSecretKey, redactSecrets } from "../utils/redaction.ts";
import { readCrewAgents } from "./crew-agent-records.ts";
import { buildRecoveryLedger, type RecoveryLedgerEntry } from "./recovery-recipes.ts";

export { isSecretKey, redactSecrets } from "../utils/redaction.ts";

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
	// Layer 8: task diagnostics
	taskDiagnostics: Record<string, Record<string, unknown>>;
	// Layer 9: terminal evidence
	terminalEvidence: Record<string, TeamTaskState["terminalEvidence"]>;
	// Layer 10: model attempts and routing
	modelAttempts: {
		taskId: string;
		attempts: TeamTaskState["modelAttempts"];
		routing: TeamTaskState["modelRouting"];
	}[];
	// Layer 11: pending mailbox
	pendingMailbox: {
		taskId: string;
		pendingSteers: TeamTaskState["pendingSteers"];
	}[];
	runMailboxUnread: RunUiSnapshot["mailbox"];
	// Layer 12: recovery ledger
	recoveryLedger: RecoveryLedgerEntry[];
}

const ENV_DEBUG_ALLOWLIST =
	/^(PI_CREW_|PI_TEAMS_|PI_.*HOME|NODE_ENV|NODE_VERSION|OS|PROCESSOR|TERM|LANG|HOME|USERPROFILE|APPDATA|PLATFORM|ARCH|WIN32|DOCKER|CI|VERBOSE|DEBUG|NO_COLOR|FORCE_COLOR|NPM_CONFIG|npm_)/i;

function envRedacted(): Record<string, string> {
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (isSecretKey(key)) output[key] = "***";
		else if (typeof value === "string" && ENV_DEBUG_ALLOWLIST.test(key)) output[key] = value;
		// All other env vars are omitted to prevent leaking sensitive paths or system topology.
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

export async function exportDiagnostic(
	ctx: Pick<ExtensionContext, "cwd">,
	runId: string,
	options: { registry?: MetricRegistry } = {},
): Promise<{ path: string; report: DiagnosticReport }> {
	const loaded = loadRunManifestById(ctx.cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	if (!loaded) throw new Error(`Run '${runId}' not found.`);
	const exportedAt = new Date().toISOString();
	const safeTimestamp = exportedAt.replace(/[:.]/g, "-");
	const recentEvents = readEvents(loaded.manifest.eventsPath).slice(-200);
	const metricsSnapshot = options.registry?.snapshot();
	const taskDiagnostics: Record<string, Record<string, unknown>> = {};
	const terminalEvidence: Record<string, TeamTaskState["terminalEvidence"]> = {};
	const modelAttempts: {
		taskId: string;
		attempts: TeamTaskState["modelAttempts"];
		routing: TeamTaskState["modelRouting"];
	}[] = [];
	const pendingMailbox: {
		taskId: string;
		pendingSteers: TeamTaskState["pendingSteers"];
	}[] = [];
	for (const task of loaded.tasks) {
		if (task.diagnostics) taskDiagnostics[task.id] = task.diagnostics;
		if (task.terminalEvidence) terminalEvidence[task.id] = task.terminalEvidence;
		if (task.modelAttempts || task.modelRouting) {
			modelAttempts.push({
				taskId: task.id,
				attempts: task.modelAttempts,
				routing: task.modelRouting,
			});
		}
		if (task.pendingSteers) {
			pendingMailbox.push({
				taskId: task.id,
				pendingSteers: task.pendingSteers,
			});
		}
	}
	const recoveryLedger = loaded.manifest.policyDecisions ? buildRecoveryLedger(loaded.manifest.policyDecisions).entries : [];
	const snapshot = buildSnapshot(loaded.manifest, loaded.tasks);
	const report: DiagnosticReport = {
		...(metricsSnapshot ? { schemaVersion: 2 } : {}),
		runId,
		exportedAt,
		manifest: redactSecrets(loaded.manifest) as TeamRunManifest,
		tasks: redactSecrets(loaded.tasks) as TeamTaskState[],
		recentEvents: redactSecrets(recentEvents) as TeamEvent[],
		heartbeat: summarizeHeartbeats(snapshot),
		agents: redactSecrets(readCrewAgents(loaded.manifest)) as unknown[],
		envRedacted: envRedacted(),
		...(metricsSnapshot
			? {
					metricsSnapshot: redactSecrets(metricsSnapshot) as MetricSnapshot[],
				}
			: {}),
		taskDiagnostics,
		terminalEvidence,
		modelAttempts,
		pendingMailbox,
		runMailboxUnread: snapshot.mailbox,
		recoveryLedger,
	};
	const dir = path.join(loaded.manifest.artifactsRoot, "diagnostic");
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `diagnostic-${safeTimestamp}.json`);
	atomicWriteFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
	return { path: filePath, report };
}

export function listRecentDiagnostic(dir: string, windowMs: number, now = Date.now()): string | undefined {
	try {
		if (!fs.existsSync(dir)) return undefined;
		return fs
			.readdirSync(dir)
			.filter((file) => file.startsWith("diagnostic-") && file.endsWith(".json"))
			.map((file) => ({
				file,
				mtimeMs: fs.statSync(path.join(dir, file)).mtimeMs,
			}))
			.filter((entry) => now - entry.mtimeMs < windowMs)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
	} catch {
		return undefined;
	}
}
