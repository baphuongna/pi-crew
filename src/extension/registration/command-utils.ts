import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";

export function parseRunArgs(args: string): TeamToolParamsValue {
	const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
	const params: TeamToolParamsValue = { action: "run" };
	const goalParts: string[] = [];
	for (const token of tokens) {
		if (token === "--async") params.async = true;
		else if (token === "--worktree") params.workspaceMode = "worktree";
		else if (token.startsWith("--team=")) params.team = token.slice("--team=".length);
		else if (token.startsWith("--workflow=")) params.workflow = token.slice("--workflow=".length);
		else if (token.startsWith("--agent=")) params.agent = token.slice("--agent=".length);
		else if (token.startsWith("--role=")) params.role = token.slice("--role=".length);
		else if (!params.team && goalParts.length === 0 && !token.startsWith("--")) params.team = token;
		else goalParts.push(token);
	}
	params.goal = goalParts.join(" ").trim() || undefined;
	return params;
}

export function commandText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

export async function notifyCommandResult(ctx: ExtensionCommandContext, text: string): Promise<void> {
	ctx.ui.notify(text.length > 800 ? `${text.slice(0, 797)}...` : text, "info");
}

export function parseScalar(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+$/.test(raw)) return Number(raw);
	if (raw.includes(",")) return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
	return raw;
}

export function pushUnset(config: Record<string, unknown>, key: string): void {
	const current = Array.isArray(config.unset) ? config.unset : [];
	current.push(key);
	config.unset = current;
}

export function setNestedConfig(config: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".").filter(Boolean);
	if (parts.length === 0) return;
	let target = config;
	for (const part of parts.slice(0, -1)) {
		const current = target[part];
		if (!current || typeof current !== "object" || Array.isArray(current)) target[part] = {};
		target = target[part] as Record<string, unknown>;
	}
	target[parts[parts.length - 1]!] = value;
}
