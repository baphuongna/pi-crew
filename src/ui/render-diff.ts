import * as Diff from "diff";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";

interface ParsedDiffLine {
	prefix: string;
	lineNum: string;	content: string;
}

interface DiffLineContent {
	lineNum: string;
	content: string;
}

function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function renderIntraLineDiff(theme: CrewTheme, oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) removedLine += theme.inverse?.(value) ?? value;
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) addedLine += theme.inverse?.(value) ?? value;
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	filePath?: string;
	theme?: unknown;
}

export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const theme = asCrewTheme(options.theme);
	const lines = diffText.split("\n");
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const parsed = parseDiffLine(line);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: DiffLineContent[] = [];
			while (i < lines.length) {
				const nextParsed = parseDiffLine(lines[i] ?? "");
				if (!nextParsed || nextParsed.prefix !== "-") break;
				removedLines.push({ lineNum: nextParsed.lineNum, content: nextParsed.content });
				i++;
			}

			const addedLines: DiffLineContent[] = [];
			while (i < lines.length) {
				const nextParsed = parseDiffLine(lines[i] ?? "");
				if (!nextParsed || nextParsed.prefix !== "+") break;
				addedLines.push({ lineNum: nextParsed.lineNum, content: nextParsed.content });
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const { removedLine, addedLine } = renderIntraLineDiff(theme, replaceTabs(removedLines[0]!.content), replaceTabs(addedLines[0]!.content));
				result.push(theme.fg("toolDiffRemoved", `-${removedLines[0]!.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${addedLines[0]!.lineNum} ${addedLine}`));
			} else {
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
