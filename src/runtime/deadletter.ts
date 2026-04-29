import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../state/types.ts";

export type DeadletterReason = "max-retries" | "heartbeat-dead" | "manual";

export interface DeadletterEntry {
	taskId: string;
	runId: string;
	reason: DeadletterReason;
	attempts: number;
	lastError?: string;
	timestamp: string;
}

export function deadletterPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "deadletter.jsonl");
}

export function appendDeadletter(manifest: TeamRunManifest, entry: DeadletterEntry): void {
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	fs.appendFileSync(deadletterPath(manifest), `${JSON.stringify(entry)}\n`, "utf-8");
}

export function readDeadletter(manifest: TeamRunManifest): DeadletterEntry[] {
	const filePath = deadletterPath(manifest);
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
		try {
			const parsed = JSON.parse(line) as DeadletterEntry;
			return parsed && typeof parsed.taskId === "string" && typeof parsed.runId === "string" ? [parsed] : [];
		} catch {
			return [];
		}
	});
}
