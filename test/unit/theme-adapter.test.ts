import test from "node:test";
import assert from "node:assert/strict";
import { asCrewTheme, subscribeThemeChange } from "../../src/ui/theme-adapter.ts";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("asCrewTheme provides ANSI inverse fallback", () => {
	assert.equal(asCrewTheme(undefined).inverse?.("x"), "\u001b[7mx\u001b[27m");
});

test("asCrewTheme preserves provided inverse function", () => {
	const theme = asCrewTheme({ fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => `<inv>${text}</inv>` });
	assert.equal(theme.inverse?.("x"), "<inv>x</inv>");
});

test("asCrewTheme binds Pi theme methods to their source object", () => {
	const source = {
		fgColors: new Map([["accent", "36"]]),
		fg(this: { fgColors: Map<string, string> }, color: string, text: string) {
			return `<${this.fgColors.get(color)}>${text}</>`;
		},
		bold(this: { marker: string }, text: string) {
			return `${this.marker}${text}`;
		},
		marker: "!",
	};
	const theme = asCrewTheme(source);
	assert.equal(theme.fg("accent", "x"), "<36>x</>");
	assert.equal(theme.bold("x"), "!x");
});

test("asCrewTheme falls back to plain text when theme methods throw", () => {
	const theme = asCrewTheme({
		fg: () => { throw new Error("theme not bound"); },
		bold: () => { throw new Error("theme not bound"); },
	});
	assert.equal(theme.fg("accent", "x"), "x");
	assert.equal(theme.bold("x"), "x");
});

test("subscribeThemeChange uses onThemeChange API and stops after dispose", () => {
	const callbacks = new Set<() => void>();
	const theme = {
		onThemeChange(callback: () => void): () => void {
			callbacks.add(callback);
			return () => callbacks.delete(callback);
		},
	};
	let count = 0;
	const unsubscribe = subscribeThemeChange(theme, () => {
		count += 1;
	});
	for (const callback of callbacks) callback();
	assert.equal(count, 1);
	unsubscribe();
	for (const callback of callbacks) callback();
	assert.equal(count, 1);
});

test("subscribeThemeChange polls theme signature changes", async () => {
	let mode = "dark";
	let count = 0;
	const theme = { getColorMode: () => mode };
	const unsubscribe = subscribeThemeChange(theme, () => {
		count += 1;
	});
	mode = "light";
	await wait(1100);
	unsubscribe();
	assert.equal(count, 1);
});
