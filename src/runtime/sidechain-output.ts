import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "../utils/redaction.ts";

export interface SidechainEntry {
	isSidechain: true;
	agentId: string;
	type: string;
	message: unknown;
	timestamp: string;
	cwd: string;
}

export function writeSidechainEntry(filePath: string, entry: Omit<SidechainEntry, "isSidechain" | "timestamp">): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(redactSecrets({ isSidechain: true, timestamp: new Date().toISOString(), ...entry }))}\n`, "utf-8");
}

export function sidechainOutputPath(stateRoot: string, taskId: string): string {
	return path.join(stateRoot, "agents", taskId, "sidechain.output.jsonl");
}

export function eventToSidechainType(event: unknown): string | undefined {
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	const type = (event as { type?: unknown }).type;
	if (type === "message_start" || type === "message_update" || type === "message_end") return "message";
	if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") return "tool";
	return typeof type === "string" ? type : undefined;
}
