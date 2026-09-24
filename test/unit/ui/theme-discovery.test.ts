/**
 * P0-1 regression tests for src/ui/theme-discovery.ts.
 *
 * Audit finding (UI-AUDIT-2026-09-15 §3 P0-1): the module used bare
 * `require("node:fs")` in three places. In this ESM package `require` is
 * undefined, so every fs probe threw a ReferenceError that the surrounding
 * try/catch swallowed. Consequences (all reproduced in the audit):
 *   - `discoverPiThemes()` returned 2 builtins instead of 2 + 11 crew themes,
 *   - `getActivePiTheme()` returned undefined although settings.json said
 *     `"theme": "crew-gruvbox-dark"`,
 *   - `setPiTheme()` threw (its `require` sat OUTSIDE any try/catch) →
 *     `/team-settings theme crew-gruvbox-dark` answered "Unknown Pi theme".
 *
 * Fix: one top-level `import * as fs from "node:fs"`.
 *
 * Sandbox: HOME / USERPROFILE are pointed at a mkdtemp dir so the test can
 * never read or write the real ~/.pi/agent/{settings.json,themes/}.
 *
 * Falsifiability: the last test reads the source file itself and fails if a
 * bare `require(` is reintroduced. Verified in this task by mutating a COPY of
 * this test + source under /tmp (the mutated run fails with
 * "discoverPiThemes() found 2 themes — expected >= 13").
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverPiThemes, formatThemesListing, getActivePiTheme, setPiTheme } from "../../../src/ui/theme-discovery.ts";

const SOURCE_PATH = path.join(import.meta.dirname ?? __dirname, "../../../src/ui/theme-discovery.ts");

/** Real crew themes shipped in the repo — the fixture mirrors them 1:1. */
const REPO_THEMES_DIR = path.join(process.cwd(), "themes");
const EXPECTED_CREW_THEMES = 11;
const ACTIVE_THEME = "crew-gruvbox-dark";

let tmpHome = "";
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function settingsFile(): string {
	return path.join(tmpHome, ".pi", "agent", "settings.json");
}

/**
 * Canonical comparison form for paths.
 *
 * theme-discovery builds paths by string concatenation (`${home}/.pi/...`),
 * so on Windows they carry forward slashes while `path.join()` yields
 * backslashes — and `os.tmpdir()`/HOME may be reported through the 8.3 short
 * name (`C:\Users\RUNNER~1\...`) instead of the long name. realpath + separator
 * folding makes both sides comparable without weakening the assertion.
 */
function normPath(p: string): string {
	let out = p;
	try {
		out = fs.realpathSync(p);
	} catch {
		out = path.resolve(p);
	}
	return out.replace(/\\/g, "/");
}

function readSettings(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
}

before(() => {
	originalHome = process.env.HOME;
	originalUserProfile = process.env.USERPROFILE;
	tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-theme-home-"));
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;

	// Fixture: the 11 real crew themes, copied under the throwaway HOME.
	const names = fs.readdirSync(REPO_THEMES_DIR).filter((f) => f.endsWith(".json"));
	assert.equal(
		names.length,
		EXPECTED_CREW_THEMES,
		`fixture premise: ${REPO_THEMES_DIR} must hold ${EXPECTED_CREW_THEMES} crew themes, found ${names.length}`,
	);
	const dir = path.join(tmpHome, ".pi", "agent", "themes");
	fs.mkdirSync(dir, { recursive: true });
	for (const file of names) {
		fs.copyFileSync(path.join(REPO_THEMES_DIR, file), path.join(dir, file));
	}
	fs.writeFileSync(settingsFile(), `${JSON.stringify({ theme: ACTIVE_THEME, lastChangelogVersion: "0.85.1" }, null, 2)}\n`, "utf8");
});

after(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("M1-1 P0-1: theme discovery works under ESM", () => {
	it("discoverPiThemes() returns >= 13 entries (11 crew themes + 2 builtins)", () => {
		const themes = discoverPiThemes();
		const custom = themes.filter((t) => t.source === "custom");
		const builtin = themes.filter((t) => t.source === "builtin");

		assert.ok(
			themes.length >= 13,
			`discoverPiThemes() found ${themes.length} themes — expected >= 13 (11 crew + 2 builtins). ` +
				`A bare require() in an ESM module collapses this to the 2 builtins (P0-1).`,
		);
		assert.equal(custom.length, EXPECTED_CREW_THEMES, `expected ${EXPECTED_CREW_THEMES} custom themes, got ${custom.length}`);
		assert.deepEqual(builtin.map((t) => t.name).sort(), ["dark", "light"], "the 2 builtin Pi themes must be present");
	});

	it("every crew theme is discovered from the throwaway HOME (with path + mode)", () => {
		const byName = new Map(discoverPiThemes().map((t) => [t.name, t]));
		for (const file of fs.readdirSync(REPO_THEMES_DIR).filter((f) => f.endsWith(".json"))) {
			const name = file.slice(0, -5);
			const info = byName.get(name);
			assert.ok(info, `${name} was not discovered`);
			assert.equal(info.source, "custom", `${name} must be reported as a custom theme`);
			assert.ok(
				info.path !== undefined && normPath(info.path).startsWith(normPath(path.join(tmpHome, ".pi", "agent", "themes"))),
				`${name} path must live under the sandboxed HOME, got ${info.path}`,
			);
			assert.ok(info.mode === "dark" || info.mode === "light", `${name} mode must be derived from vars.bg`);
		}
		// Mode is derived from vars.bg luminance — spot-check one dark, one light.
		assert.equal(byName.get("crew-gruvbox-dark")?.mode, "dark");
		assert.equal(byName.get("crew-solarized-light")?.mode, "light");
		assert.equal(byName.get("crew-catppuccin-latte")?.mode, "light");
	});

	it("getActivePiTheme() reads `theme` from settings.json", () => {
		assert.equal(getActivePiTheme(), ACTIVE_THEME);
	});

	it("getActivePiTheme() returns undefined when the theme key is absent", () => {
		const backup = fs.readFileSync(settingsFile(), "utf8");
		try {
			fs.writeFileSync(settingsFile(), `${JSON.stringify({ lastChangelogVersion: "0.85.1" }, null, 2)}\n`, "utf8");
			assert.equal(getActivePiTheme(), undefined);
		} finally {
			fs.writeFileSync(settingsFile(), backup, "utf8");
		}
	});

	it("setPiTheme() writes settings.json inside the sandbox and does not throw", () => {
		const written = setPiTheme("crew-tokyo-night");
		assert.ok(written.startsWith(tmpHome), `setPiTheme() must write into the sandboxed HOME, got ${written} (tmpHome=${tmpHome})`);
		assert.equal(normPath(written), normPath(settingsFile()));
		assert.ok(fs.existsSync(written), `settings.json was not created at ${written}`);
		assert.equal(readSettings().theme, "crew-tokyo-night", "the theme key must be persisted");
		// Merge, not clobber: unrelated settings survive the write.
		assert.equal(readSettings().lastChangelogVersion, "0.85.1", "existing settings keys must be preserved");
		assert.equal(getActivePiTheme(), "crew-tokyo-night", "round-trip: the write must be readable");

		// Restore the fixture theme for later tests.
		setPiTheme(ACTIVE_THEME);
		assert.equal(getActivePiTheme(), ACTIVE_THEME);
	});

	it("setPiTheme() still throws when no HOME is set (behaviour preserved)", () => {
		const savedHome = process.env.HOME;
		const savedProfile = process.env.USERPROFILE;
		try {
			delete process.env.HOME;
			delete process.env.USERPROFILE;
			assert.throws(() => setPiTheme("crew-nord"), /HOME/, "setPiTheme must throw when no HOME/USERPROFILE is available");
		} finally {
			process.env.HOME = savedHome;
			process.env.USERPROFILE = savedProfile;
		}
	});

	it("reads only the sandboxed HOME — an empty HOME yields the 2 builtins", () => {
		const emptyHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-theme-empty-"));
		const savedHome = process.env.HOME;
		const savedProfile = process.env.USERPROFILE;
		try {
			process.env.HOME = emptyHome;
			process.env.USERPROFILE = emptyHome;
			const themes = discoverPiThemes();
			assert.deepEqual(
				themes.map((t) => t.name),
				["dark", "light"],
				"an empty HOME must not fall back to the machine's real ~/.pi/agent/themes",
			);
			assert.equal(getActivePiTheme(), undefined);
		} finally {
			process.env.HOME = savedHome;
			process.env.USERPROFILE = savedProfile;
			fs.rmSync(emptyHome, { recursive: true, force: true });
		}
	});

	it("formatThemesListing() renders the gallery with the active marker", () => {
		const listing = formatThemesListing();
		assert.ok(listing.includes(`● ${ACTIVE_THEME}`), `active theme must be marked in the listing:\n${listing}`);
		assert.ok(listing.includes("○ crew-nord"), `non-active themes must be listed unmarked:\n${listing}`);
		assert.ok(listing.includes(`${EXPECTED_CREW_THEMES + 2} themes available`), `listing must count all themes:\n${listing}`);
	});
});

describe("M1-1 guard: P0-1 cannot regress silently", () => {
	it("theme-discovery.ts has a static node:fs import and no bare require() call", () => {
		const source = fs.readFileSync(SOURCE_PATH, "utf8");
		// Strip comments so the explanatory docblock (which quotes the old bug)
		// cannot mask a real reintroduction.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

		assert.ok(
			!/\brequire\s*\(/.test(code),
			"bare require() is back in theme-discovery.ts — in ESM `require` is undefined, the try/catch swallows " +
				"the ReferenceError and discoverPiThemes() collapses to the 2 builtins (P0-1). Use the top-level `import * as fs`.",
		);
		assert.match(code, /^\s*import \* as fs from "node:fs";$/m, 'expected a static top-level `import * as fs from "node:fs"`');
	});

	it("every public export of theme-discovery.ts is preserved", () => {
		const source = fs.readFileSync(SOURCE_PATH, "utf8");
		for (const symbol of ["discoverPiThemes", "getActivePiTheme", "setPiTheme", "formatThemesListing"]) {
			assert.ok(source.includes(`export function ${symbol}`), `export function ${symbol} must not be removed`);
		}
		// And they are all callable from the module's public surface.
		assert.equal(typeof discoverPiThemes, "function");
		assert.equal(typeof getActivePiTheme, "function");
		assert.equal(typeof setPiTheme, "function");
		assert.equal(typeof formatThemesListing, "function");
	});
});
