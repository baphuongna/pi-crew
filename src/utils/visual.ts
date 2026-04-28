export const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function visibleWidth(value: string): number {
	let length = 0;
	for (const char of value.replace(ANSI_PATTERN, "")) {
		if (char !== "\n") length += 1;
	}
	return length;
}

function consumeAnsi(input: string, index: number): number {
	const char = input[index];
	if (!char || char !== "\u001b") return 0;
	if (input[index + 1] !== "[") return 0;
	let i = index + 2;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i - index + 1;
		i++;
	}
	return 0;
}

function splitGraphemes(value: string): string[] {
	return Array.from(value.replace(ANSI_PATTERN, ""));
}

export function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	let output = "";
	let renderedWidth = 0;
	for (let i = 0; i < value.length; i++) {
		const ansiLen = consumeAnsi(value, i);
		if (ansiLen) {
			output += value.slice(i, i + ansiLen);
			i += ansiLen - 1;
			continue;
		}
		const char = value[i] as string;
		const nextIndex = i + (char.codePointAt(0) ?? 0) > 0xFFFF ? i + 2 : i + 1;
		const segment = value.slice(i, nextIndex);
		const charWidth = visibleWidth(segment);
		if (renderedWidth + charWidth > width - ellipsis.length) {
			return `${output}${ellipsis}`;
		}
		output += segment;
		renderedWidth += charWidth;
		i = nextIndex - 1;
	}
	return output;
}

export const truncate = truncateToWidth;

export function pad(value: string, width: number): string {
	const current = visibleWidth(value);
	if (current >= width) return value;
	return `${value}${" ".repeat(width - current)}`;
}

export function boxLine(text: string, innerWidth: number): string {
	return `│ ${truncate(text, innerWidth - 4)} │`;
}

function readAnsiCode(input: string, index: number): string | undefined {
	const ansiLength = consumeAnsi(input, index);
	if (ansiLength > 0) return input.slice(index, index + ansiLength);
	return undefined;
}

function takeCodePoint(input: string, index: number): { chunk: string; nextIndex: number } {
	const code = input.codePointAt(index);
	if (code === undefined) return { chunk: "", nextIndex: index + 1 };
	if (code >= 0xD800 && code <= 0xDBFF && index + 1 < input.length) {
		return { chunk: input.slice(index, index + 2), nextIndex: index + 2 };
	}
	return { chunk: input[index] ?? "", nextIndex: index + 1 };
}

export function wrapHard(value: string, width: number): string[] {
	if (width <= 0 || !value) return [];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	let i = 0;
	while (i < value.length) {
		const ansi = readAnsiCode(value, i);
		if (ansi) {
			current += ansi;
			i += ansi.length;
			continue;
		}
		const { chunk, nextIndex } = takeCodePoint(value, i);
		const chunkWidth = visibleWidth(chunk);
		if (chunkWidth > width) {
			lines.push(current ? current + chunk : chunk);
			current = "";
			currentWidth = 0;
			i = nextIndex;
			continue;
		}
		if (currentWidth + chunkWidth > width) {
			if (current) lines.push(current);
			current = chunk;
			currentWidth = chunkWidth;
			i = nextIndex;
			continue;
		}
		current += chunk;
		currentWidth += chunkWidth;
		i = nextIndex;
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

export interface VisualTruncateResult {
	visualLines: string[];
	skippedCount: number;
}

export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [""], skippedCount: 0 };
	}
	const effectiveWidth = Math.max(1, width - paddingX * 2);
	const visualLines = text
		.split("\n")
		.flatMap((line) => wrapHard(pad(line, Math.max(0, effectiveWidth)).trimEnd(), effectiveWidth).slice(0, Math.max(1, maxVisualLines)))
		.slice(0);
	if (visualLines.length <= maxVisualLines) return { visualLines, skippedCount: 0 };
	const truncated = visualLines.slice(-maxVisualLines);
	return { visualLines: truncated, skippedCount: visualLines.length - maxVisualLines };
}
