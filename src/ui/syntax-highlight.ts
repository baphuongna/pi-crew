import { supportsLanguage, highlight } from "cli-highlight";
import type { CrewTheme } from "./theme-adapter.ts";
import { asCrewTheme } from "./theme-adapter.ts";

function buildCliTheme(theme: CrewTheme): Record<string, (text: string) => string> {
	return {
		keyword: (text) => theme.fg("syntaxKeyword", text),
		built_in: (text) => theme.fg("syntaxType", text),
		literal: (text) => theme.fg("syntaxNumber", text),
		number: (text) => theme.fg("syntaxNumber", text),
		string: (text) => theme.fg("syntaxString", text),
		comment: (text) => theme.fg("syntaxComment", text),
		function: (text) => theme.fg("syntaxFunction", text),
		title: (text) => theme.fg("syntaxFunction", text),
		class: (text) => theme.fg("syntaxType", text),
		type: (text) => theme.fg("syntaxType", text),
		attr: (text) => theme.fg("syntaxVariable", text),
		variable: (text) => theme.fg("syntaxVariable", text),
		params: (text) => theme.fg("syntaxVariable", text),
		operator: (text) => theme.fg("syntaxOperator", text),
		punctuation: (text) => theme.fg("syntaxPunctuation", text),
	};
}

export function detectLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	return languageMap[ext];
}

export const languageMap: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	md: "markdown",
	markdown: "markdown",
	json: "json",
	yml: "yaml",
	yaml: "yaml",
	toml: "yaml",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	sass: "sass",
	bash: "bash",
	sh: "bash",
	zsh: "bash",
	fish: "bash",
	ps1: "powershell",
	sql: "sql",
	rust: "rust",
	rb: "ruby",
	go: "go",
	java: "java",
	kt: "kotlin",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	c: "c",
	h: "c",
	cs: "csharp",
	php: "php",
};

export function highlightCode(code: string, language: string | undefined, themeLike: unknown = undefined): string {
	const theme = asCrewTheme(themeLike);
	const validLanguage = language && supportsLanguage(language) ? language : undefined;
	if (!validLanguage) {
		return code
			.split("\n")
			.map((line) => theme.fg("mdCodeBlock", line))
			.join("\n");
	}
	try {
		return highlight(code, {
			language: validLanguage,
			ignoreIllegals: true,
			theme: buildCliTheme(theme),
		}).trimEnd();
	} catch {
		return code
			.split("\n")
			.map((line) => theme.fg("mdCodeBlock", line))
			.join("\n");
	}
}

export function highlightJson(payload: string, themeLike: unknown = undefined): string {
	const theme = asCrewTheme(themeLike);
	try {
		return highlight(payload, {
			language: "json",
			ignoreIllegals: true,
			theme: buildCliTheme(theme),
		}).trimEnd();
	} catch {
		try {
			const parsed = JSON.parse(payload);
			return JSON.stringify(parsed, null, 2)
				.split("\n")
				.map((line) => theme.fg("mdCodeBlock", line))
				.join("\n");
		} catch {
			return payload
				.split("\n")
				.map((line) => theme.fg("mdCodeBlock", line))
				.join("\n");
		}
	}
}
