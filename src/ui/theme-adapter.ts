export type CrewThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxKeyword"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxComment"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "mdCodeBlock";

export type CrewThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

export interface CrewTheme {
	fg(color: CrewThemeColor, text: string): string;
	bg?(color: CrewThemeBg, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	inverse?(text: string): string;
}

function safeNoopTheme(): CrewTheme {
	return {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
}

function asStringFn(value: unknown): ((color: CrewThemeColor | CrewThemeBg, text: string) => string) | undefined {
	if (typeof value !== "function") return undefined;
	return (color: CrewThemeColor | CrewThemeBg, text: string) => {
		const fn = value as (color: CrewThemeColor | CrewThemeBg, text: string) => unknown;
		const result = fn(color, text);
		return typeof result === "string" ? result : text;
	};
}

function asUnaryFn(value: unknown): ((text: string) => string) | undefined {
	if (typeof value !== "function") return undefined;
	return (text: string) => {
		const fn = value as (text: string) => unknown;
		const result = fn(text);
		return typeof result === "string" ? result : text;
	};
}

export function asCrewTheme(raw: unknown): CrewTheme {
	const fallback = safeNoopTheme();
	if (!raw || typeof raw !== "object") return fallback;
	const record = raw as Record<string, unknown>;
	const fg = asStringFn(record.fg);
	const bold = asUnaryFn(record.bold);
	if (!fg || !bold) return fallback;
	return {
		fg,
		bg: asStringFn(record.bg),
		bold,
		italic: asUnaryFn(record.italic),
		underline: asUnaryFn(record.underline),
		inverse: asUnaryFn(record.inverse),
	};
}
