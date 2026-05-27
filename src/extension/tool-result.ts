import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TeamToolDetails } from "./team-tool-types.ts";

export type PiTeamsToolResult<TDetails = TeamToolDetails> = AgentToolResult<TDetails> & { isError?: boolean };

export function toolResult<TDetails>(text: string, details: TDetails, isError = false): PiTeamsToolResult<TDetails> {
	return { content: [{ type: "text", text }], details, isError };
}

export function isToolError(result: { isError?: boolean }): boolean {
	return result.isError === true;
}

export function textFromToolResult(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}
