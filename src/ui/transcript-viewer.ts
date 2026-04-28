import * as fs from "node:fs";
import type { TeamRunManifest } from "../state/types.ts";
import { agentOutputPath, readCrewAgents } from "../runtime/crew-agent-records.ts";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";
import { renderDiff } from "./render-diff.ts";
import { highlightCode, highlightJson } from "./syntax-highlight.ts";
import { pad, truncate, truncateToVisualLines } from "../utils/visual.ts";

type Component = { invalidate(): void; render(width: number): string[]; handleInput(data: string): void };

type TranscriptTheme = CrewTheme;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const obj = asRecord(part);
			if (!obj) return "";
			if (typeof obj.text === "string") return obj.text;
			if (typeof obj.content === "string") return obj.content;
			if (typeof obj.name === "string") return `[tool:${obj.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function isLikelyDiff(text: string): boolean {
	const lines = text.split(/\r?\n/);
	const matched = lines.filter((line) => /^[-+\s]\d+\s/.test(line)).length;
	return matched >= 2 && (text.includes("-") || text.includes("+"));
}

function highlightCodeBlocks(input: string, theme: TranscriptTheme): string[] {
	const codeBlockRegex = /```(\S+)?\n([\s\S]*?)```/g;
	const lines: string[] = [];
	let index = 0;
	let match: RegExpExecArray | null;
	while ((match = codeBlockRegex.exec(input)) !== null) {
		if (match.index > index) lines.push(...input.slice(index, match.index).split(/\r?\n/));
		const lang = match[1]?.trim();
		const block = match[2] ?? "";
		const highlighted = highlightCode(block, lang, theme);
		if (highlighted) {
			lines.push(...highlighted.split(/\r?\n/));
		}
		index = match.index + match[0].length;
	}
	if (index < input.length) lines.push(...input.slice(index).split(/\r?\n/));
	return lines.filter((line) => line.length > 0);
}

export function formatTranscriptEvent(event: unknown, themeLike: unknown = undefined): string[] {
	const theme = asCrewTheme(themeLike);
	const obj = asRecord(event);
	if (!obj) return [String(event)];
	const type = typeof obj.type === "string" ? obj.type : undefined;
	const toolName = typeof obj.toolName === "string" ? obj.toolName : typeof obj.name === "string" ? obj.name : undefined;
	const content = textFromContent(obj.content);
	if (type && /tool/i.test(type)) {
		const text = (content || (typeof obj.text === "string" ? obj.text : typeof obj.result === "string" ? obj.result : "")).trim();
		if (!text) return [theme.fg("toolDiffContext", `[Tool${toolName ? `: ${toolName}` : ""}] ${type}`), "(no output)"];
		if (isLikelyDiff(text)) {
			return [theme.fg("toolDiffContext", `[Tool${toolName ? `: ${toolName}` : ""}] ${type}`), renderDiff(text, { theme })];
		}
		if (text.startsWith("{") && text.endsWith("}")) {
			return [theme.fg("toolDiffContext", `[Tool${toolName ? `: ${toolName}` : ""}] ${type}`), ...highlightJson(text, theme).split(/\r?\n/).filter(Boolean)];
		}
		if (text.includes("```") && text.includes("```")) {
			return [theme.fg("toolDiffContext", `[Tool${toolName ? `: ${toolName}` : ""}] ${type}`), ...highlightCodeBlocks(text, theme)];
		}
		return [theme.fg("toolDiffContext", `[Tool${toolName ? `: ${toolName}` : ""}] ${type}`), ...text.split(/\r?\n/).filter(Boolean).map((line) => theme.fg("muted", line))];
	}
	const message = asRecord(obj.message);
	if (message) {
		const role = typeof message.role === "string" ? message.role : "message";
		const text = textFromContent(message.content);
		if (text.trim()) {
			const label = role === "assistant" ? "Assistant" : role === "user" ? "User" : role;
			const header = `[${label}]:`;
			const lines = text.split(/\r?\n/);
			if (text.includes("```") && text.includes("```")) {
				return [theme.fg("accent", header), ...highlightCodeBlocks(text, theme)];
			}
			if (lines.length > 1) {
				const block = lines
					.map((line) => (role === "assistant" ? theme.bold(line) : line))
					.join("\n");
				return [theme.fg("accent", header), ...block.split(/\r?\n/).filter(Boolean)];
			}
			return [theme.fg("accent", header), ...lines.filter(Boolean)];
		}
	}
	if (type) {
		const text = content || (typeof obj.text === "string" ? obj.text : "");
		return text.trim() ? [theme.fg("muted", `[${type}]: ${text.trim()}`)] : [`[${type}]`];
	}
	return [JSON.stringify(event)];
}

export function formatTranscriptText(text: string, themeLike: unknown = undefined): string[] {
	const lines: string[] = [];
	for (const raw of text.split(/\r?\n/).filter(Boolean)) {
		try {
			const parsed = JSON.parse(raw);
			lines.push(...formatTranscriptEvent(parsed, themeLike));
		} catch {
			lines.push(raw);
		}
	}
	return lines.length ? lines : ["(no transcript content)"];
}

export function readRunTranscript(manifest: TeamRunManifest, taskId?: string): { title: string; path: string; lines: string[] } {
	const agents = readCrewAgents(manifest);
	const agent = taskId ? agents.find((item) => item.taskId === taskId || item.id === taskId) : agents.find((item) => item.transcriptPath) ?? agents[0];
	const selectedTaskId = agent?.taskId ?? taskId ?? "unknown";
	const transcriptPath = agent?.transcriptPath && fs.existsSync(agent.transcriptPath) ? agent.transcriptPath : agentOutputPath(manifest, selectedTaskId);
	const text = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf-8") : "";
	return { title: `${manifest.runId}:${selectedTaskId}`, path: transcriptPath, lines: formatTranscriptText(text) };
}

interface ViewerState {
	theme: TranscriptTheme;
	autoScroll: boolean;
	lastHeight: number;
	scroll: number;
}

function renderViewerBase(
	state: ViewerState,
	width: number,
	lines: string[],
	title: string,
	subtitle: string,
): string[] {
	const inner = Math.max(20, width - 4);
	const bodyText = lines.join("\n");
	const { visualLines, skippedCount } = truncateToVisualLines(bodyText, state.lastHeight, inner);
	const maxScroll = Math.max(0, visualLines.length - state.lastHeight);
	if (state.autoScroll) state.scroll = maxScroll;
	state.scroll = Math.min(state.scroll, maxScroll);
	const visible = visualLines.slice(state.scroll, state.scroll + state.lastHeight);
	const statusLine = `${visualLines.length} lines · ${visualLines.length ? Math.round(((state.scroll + visible.length) / visualLines.length) * 100) : 100}% · auto-scroll ${state.autoScroll ? "on" : "off"}`;
	const fg = (color: Parameters<TranscriptTheme["fg"]>[0], text: string) => state.theme.fg(color, text);
	const row = (text: string) => `${fg("border", "│")} ${pad(truncate(text, inner), inner)} ${fg("border", "│")}`;
	const linesOut: string[] = [
		fg("border", `╭${"─".repeat(inner + 2)}╮`),
		row(`${fg("accent", title)} ${fg("dim", subtitle)}`),
		row(fg("dim", "j/k scroll · PgUp/PgDn · g/G top/bottom · q close")),
		fg("border", `├${"─".repeat(inner + 2)}┤`),
		...visible.map(row),
		fg("border", `├${"─".repeat(inner + 2)}┤`),
		row(fg("dim", statusLine)),
		fg("border", `╰${"─".repeat(inner + 2)}╯`),
	];
	if (skippedCount > 0) {
		linesOut.splice(linesOut.length - 1, 0, row(fg("muted", `… (${skippedCount} lines truncated above`)));
	}
	return linesOut.map((line) => truncate(line, width));
}


export class DurableTextViewer implements Component {
	private scroll = 0;
	private lastHeight = 16;
	private autoScroll = true;
	private title: string;
	private subtitle: string;
	private lines: string[];
	private theme: TranscriptTheme;
	private done: (result: undefined) => void;

	constructor(title: string, subtitle: string, lines: string[], theme: unknown, done: (result: undefined) => void) {
		this.title = title;
		this.subtitle = subtitle;
		this.lines = lines.length ? lines : ["(empty)"];
		this.theme = asCrewTheme(theme);
		this.done = done;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.done(undefined);
			return;
		}
		const maxScroll = Math.max(0, this.lines.length - this.lastHeight);
		if (data === "k" || data === "\u001b[A") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.autoScroll = false;
		} else if (data === "j" || data === "\u001b[B") {
			this.scroll = Math.min(maxScroll, this.scroll + 1);
			this.autoScroll = this.scroll >= maxScroll;
		} else if (data === "\u001b[5~") {
			this.scroll = Math.max(0, this.scroll - this.lastHeight);
			this.autoScroll = false;
		} else if (data === "\u001b[6~") {
			this.scroll = Math.min(maxScroll, this.scroll + this.lastHeight);
			this.autoScroll = this.scroll >= maxScroll;
		} else if (data === "g" || data === "\u001b[H") {
			this.scroll = 0;
			this.autoScroll = false;
		} else if (data === "G" || data === "\u001b[F") {
			this.scroll = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		return renderViewerBase(
			{ theme: this.theme, autoScroll: this.autoScroll, lastHeight: this.lastHeight, scroll: this.scroll },
			width,
			this.lines,
			this.title,
			this.subtitle,
		);
	}
}

export class DurableTranscriptViewer implements Component {
	private scroll = 0;
	private lastHeight = 16;
	private autoScroll = true;
	private manifest: TeamRunManifest;
	private theme: TranscriptTheme;
	private done: (result: undefined) => void;
	private taskId?: string;

	constructor(manifest: TeamRunManifest, theme: unknown, done: (result: undefined) => void, taskId?: string) {
		this.manifest = manifest;
		this.theme = asCrewTheme(theme);
		this.done = done;
		this.taskId = taskId;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (data === "q" || data === "\u001b") {
			this.done(undefined);
			return;
		}
		const content = readRunTranscript(this.manifest, this.taskId).lines;
		const maxScroll = Math.max(0, content.length - this.lastHeight);
		if (data === "k" || data === "\u001b[A") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.autoScroll = false;
		} else if (data === "j" || data === "\u001b[B") {
			this.scroll = Math.min(maxScroll, this.scroll + 1);
			this.autoScroll = this.scroll >= maxScroll;
		} else if (data === "\u001b[5~") {
			this.scroll = Math.max(0, this.scroll - this.lastHeight);
			this.autoScroll = false;
		} else if (data === "\u001b[6~") {
			this.scroll = Math.min(maxScroll, this.scroll + this.lastHeight);
			this.autoScroll = this.scroll >= maxScroll;
		} else if (data === "g" || data === "\u001b[H") {
			this.scroll = 0;
			this.autoScroll = false;
		} else if (data === "G" || data === "\u001b[F") {
			this.scroll = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		const data = readRunTranscript(this.manifest, this.taskId);
		return renderViewerBase(
			{ theme: this.theme, autoScroll: this.autoScroll, lastHeight: this.lastHeight, scroll: this.scroll },
			width,
			data.lines,
			"pi-crew transcript",
			data.title,
		);
	}
}
