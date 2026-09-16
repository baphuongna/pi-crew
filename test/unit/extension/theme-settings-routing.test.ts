/**
 * M1-3 / P0-1: `/team-settings theme <non-builtin>` must switch themes.
 *
 * Audit finding (UI-AUDIT-2026-09-15 §3 P0-1): because theme-discovery.ts used
 * bare `require("node:fs")` in an ESM package, `discoverPiThemes()` collapsed
 * to the 2 builtins, so the `exists` check in handle-settings.ts (the
 * `theme <name>` branch) rejected every crew theme:
 *   `/team-settings theme crew-gruvbox-dark` → "Unknown Pi theme: crew-gruvbox-dark".
 *
 * This test drives the REAL entry symbol used by the `/team-settings` command —
 * `handleTeamTool({ action: "settings", config: { args } }, ctx)`, which is
 * exactly the call made at src/extension/registration/commands/manage.ts:57 —
 * so it covers routing (facade → manage domain → handleSettings → theme branch).
 *
 * NOTE the call shape: the args live in `config.args` (a top-level `args` never
 * reaches the theme branch — it yields the settings *list*; verified in the
 * scout memo §2 and asserted below).
 *
 * Sandbox: HOME + USERPROFILE + PI_CREW_HOME + cwd all point into mkdtemp dirs,
 * so nothing can touch the real ~/.pi or the repo's .crew/. The isolation is
 * asserted explicitly (write target prefix + the real user settings.json is
 * byte-identical afterwards).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { handleTeamTool } from "../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../src/extension/tool-result.ts";

const REPO_THEMES_DIR = path.join(process.cwd(), "themes");
const NON_BUILTIN_THEME = "crew-gruvbox-dark";
const EXPECTED_CREW_THEMES = 11;

/** The real user's settings.json — must stay byte-identical across this test. */
const REAL_HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
const REAL_SETTINGS = REAL_HOME ? path.join(REAL_HOME, ".pi", "agent", "settings.json") : "";
const realSettingsBefore = REAL_SETTINGS && fs.existsSync(REAL_SETTINGS) ? fs.readFileSync(REAL_SETTINGS, "utf8") : null;

let tmpHome = "";
let tmpCwd = "";
let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let savedCrewHome: string | undefined;

function settingsFile(): string {
	return path.join(tmpHome, ".pi", "agent", "settings.json");
}

/** Mirror the `/team-settings <args>` command call shape. */
function runSettings(args: string) {
	return handleTeamTool({ action: "settings", config: { args } } as never, { cwd: tmpCwd } as never);
}

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function installThemeFixture(): void {
	const dir = path.join(tmpHome, ".pi", "agent", "themes");
	fs.mkdirSync(dir, { recursive: true });
	const files = fs.readdirSync(REPO_THEMES_DIR).filter((f) => f.endsWith(".json"));
	assert.equal(files.length, EXPECTED_CREW_THEMES, `fixture premise: expected ${EXPECTED_CREW_THEMES} crew themes in ${REPO_THEMES_DIR}`);
	for (const file of files) fs.copyFileSync(path.join(REPO_THEMES_DIR, file), path.join(dir, file));
	fs.writeFileSync(settingsFile(), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, "utf8");
}

before(() => {
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	savedCrewHome = process.env.PI_CREW_HOME;
	tmpHome = makeTempDir("pi-crew-theme-settings-home-");
	tmpCwd = makeTempDir("pi-crew-theme-settings-cwd-");
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome;
	// PI_CREW_SKIP_HOME_CHECK=1 is injected by scripts/test-runner.mjs, so this is honoured.
	process.env.PI_CREW_HOME = tmpHome;
	installThemeFixture();
});

after(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	if (savedCrewHome === undefined) delete process.env.PI_CREW_HOME;
	else process.env.PI_CREW_HOME = savedCrewHome;
	fs.rmSync(tmpHome, { recursive: true, force: true });
	fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("M1-3 P0-1: /team-settings theme <non-builtin>", () => {
	it("switches to a crew theme instead of answering 'Unknown Pi theme'", async () => {
		const res = await runSettings(`theme ${NON_BUILTIN_THEME}`);
		const text = textFromToolResult(res);

		assert.ok(!text.includes("Unknown Pi theme"), `pre-fix symptom regressed — the exists check rejected a real crew theme:\n${text}`);
		assert.equal(res.details?.status, "ok", `expected status ok, got ${JSON.stringify(res.details)}\n${text}`);
		assert.ok(text.includes("✓ Pi theme set to"), `expected the success line, got:\n${text}`);
		assert.ok(text.includes(NON_BUILTIN_THEME), `expected the theme name in the reply, got:\n${text}`);
		assert.equal((res.details as { theme?: string } | undefined)?.theme, NON_BUILTIN_THEME);
	});

	it("writes the throwaway settings file INSIDE the tmpdir (isolation)", async () => {
		fs.writeFileSync(settingsFile(), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`, "utf8");
		await runSettings(`theme ${NON_BUILTIN_THEME}`);

		assert.ok(fs.existsSync(settingsFile()), `expected ${settingsFile()} to be written`);
		const written = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { theme?: string };
		assert.equal(written.theme, NON_BUILTIN_THEME, "the sandboxed settings.json must carry the new theme");

		// Nothing may be written outside the sandbox.
		assert.ok(
			!fs.existsSync(path.join(tmpCwd, ".pi")),
			`cwd must stay untouched (found ${path.join(tmpCwd, ".pi")}) — the theme path must not write into the repo config`,
		);
		// The real user's settings.json is byte-identical (read, never written).
		if (REAL_SETTINGS) {
			const after1 = fs.existsSync(REAL_SETTINGS) ? fs.readFileSync(REAL_SETTINGS, "utf8") : null;
			assert.equal(after1, realSettingsBefore, `the real ${REAL_SETTINGS} must not be touched by this test`);
		}
	});

	it("still rejects a theme that does not exist (negative control)", async () => {
		const text = textFromToolResult(await runSettings("theme crew-definitely-not-a-theme"));
		assert.ok(text.includes("Unknown Pi theme: crew-definitely-not-a-theme"), `bogus names must still be rejected, got:\n${text}`);
	});

	it("reproduces the pre-fix symptom when discovery finds no crew themes", async () => {
		// Empty HOME == the post-mutant world where discoverPiThemes() returned
		// only the 2 builtins. This is exactly the user-visible P0-1 failure and
		// it proves the assertions above are not vacuous.
		const emptyHome = makeTempDir("pi-crew-theme-settings-empty-");
		const saved = process.env.HOME;
		try {
			process.env.HOME = emptyHome;
			process.env.USERPROFILE = emptyHome;
			const text = textFromToolResult(await runSettings(`theme ${NON_BUILTIN_THEME}`));
			assert.ok(
				text.includes(`Unknown Pi theme: ${NON_BUILTIN_THEME}`),
				`with no discoverable themes the call must fail exactly like the pre-fix bug, got:\n${text}`,
			);
		} finally {
			process.env.HOME = saved;
			process.env.USERPROFILE = tmpHome;
			fs.rmSync(emptyHome, { recursive: true, force: true });
		}
	});

	it("`theme` with no name lists all 11 crew themes (discovery flows through the real entry)", async () => {
		const text = textFromToolResult(await runSettings("theme"));
		assert.ok(text.includes("Usage: team-settings theme <name>"), `expected usage help, got:\n${text}`);
		assert.ok(text.includes(NON_BUILTIN_THEME), `the picker list must include crew themes, got:\n${text}`);
		assert.ok(text.includes("crew-nord") && text.includes("crew-tokyo-night") && text.includes("crew-dracula"));
	});

	it("a top-level `args` (not config.args) never reaches the theme branch", async () => {
		// Guards the call-shape trap: the facade reads params.config.args only.
		const res = await handleTeamTool({ action: "settings", args: `theme ${NON_BUILTIN_THEME}` } as never, { cwd: tmpCwd } as never);
		const text = textFromToolResult(res);
		assert.ok(!text.includes("Pi theme set to"), `a top-level args must not switch themes, got:\n${text.slice(0, 200)}`);
		assert.ok(
			text.includes("effective settings") || text.includes("pi-crew"),
			`expected the settings listing, got:\n${text.slice(0, 200)}`,
		);
	});
});

describe("M1-3 guard: the theme branch really uses discovery", () => {
	it("handle-settings.ts feeds discoverPiThemes() into the exists check", () => {
		const source = fs.readFileSync(
			path.join(import.meta.dirname ?? __dirname, "../../../src/extension/team-tool/handle-settings.ts"),
			"utf8",
		);
		assert.ok(source.includes("discoverPiThemes()"), "the exists check must be backed by discoverPiThemes()");
		assert.ok(source.includes("Unknown Pi theme"), "the rejection message must stay reachable");
		assert.ok(source.includes("setPiTheme(name)"), "the success path must persist via setPiTheme()");
	});
});
