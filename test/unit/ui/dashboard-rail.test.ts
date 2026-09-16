/**
 * E2 (M4, 2026-09-16) — RAIL grammar locks for the FULL-SCREEN surfaces.
 *
 * The three full-screen surfaces (run dashboard, agents & jobs browser,
 * settings overlay) migrated off the pre-R3 language — rounded boxes
 * `╭╮╰╯`, `── label ──` rules, `│` frame edges, `→` cursors, four overflow
 * dialects, hand-typed hints — onto the RAIL grammar defined in
 * `docs/UI-DESIGN-SYSTEM.md` §2.C/§2.D/§2.E and implemented in
 * `src/ui/rail.ts`:
 *
 *   `┏ NAME ▸ SUBJECT`   canopy (identity)
 *   `┣ SECTION ▸ n`      section header (replaces `── label ──`)
 *   `┃`                  body row (owned by the frame owner, never a pane)
 *   `┗ <hint>`           end cap (close action LAST)
 *   `›`                  the ONLY selection cursor
 *   `▲ n above`/`▼ m below`  the ONLY overflow dialect
 *   `······`             dot leaders joining left/right segments
 *
 * Each assertion below runs against REAL rendered output — a live
 * component/overlay instance, `render(width)`, ANSI-stripped — never against a
 * helper in isolation, so a surface that stops using the shared primitives
 * fails here even while `rail.ts` itself stays correct.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { clearLiveAgentsForTest, registerLiveAgent } from "../../../src/runtime/live-session/live-agent-manager.ts";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { type AgentsBrowserAgentEntry, AgentsJobsBrowser } from "../../../src/ui/agents-jobs-browser.ts";
import { RunDashboard } from "../../../src/ui/run-dashboard.ts";
import { createSettingsOverlay } from "../../../src/ui/settings-overlay.ts";
import type { CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

// ─── Harness ───────────────────────────────────────────────────────────────

const CURSOR = "›";
/** The retired vocabulary: rounded box + `── label ──` rule glyphs. */
const RETIRED_GLYPHS = /[╭╮╰╯├┤]/;

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Raw rendered lines (ANSI intact — used for the width contract). */
const rawLines = (component: { render(w: number): string[] }, width: number): string[] => component.render(width);

/** Visible, right-trimmed lines (used for grammar assertions). */
const view = (component: { render(w: number): string[] }, width: number): string[] =>
	strip(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""));

const joined = (component: { render(w: number): string[] }, width: number): string => view(component, width).join("\n");

const noopTheme: CrewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

/** A theme that really emits ANSI — proves the width helpers are escape-aware. */
const ansiTheme: CrewTheme = {
	fg: (_color, text) => `\u001b[36m${text}\u001b[0m`,
	bold: (text) => `\u001b[1m${text}\u001b[0m`,
	inverse: (text) => `\u001b[7m${text}\u001b[0m`,
};

let tmpDir: string | undefined;

afterEach(() => {
	clearLiveAgentsForTest();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});

function makeRun(id: string, status: TeamRunManifest["status"] = "running", overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "implementation",
		workflow: "implementation",
		goal: `Ship ${id}`,
		status,
		workspaceMode: "single",
		createdAt: "2026-09-16T00:00:00.000Z",
		updatedAt: "2026-09-16T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
		...overrides,
	};
}

// ─── Run dashboard (§2.C) ──────────────────────────────────────────────────

describe("full-screen RAIL: run dashboard", () => {
	test("canopy carries the identity + the dot-led hint segment", () => {
		const dashboard = new RunDashboard([makeRun("team_rail_0001", "running"), makeRun("team_rail_0002", "completed")], () => undefined);
		const canopy = view(dashboard, 100)[0] ?? "";
		dashboard.dispose();
		assert.match(canopy, /^┏ DASHBOARD ▸ 2 runs/, `canopy missing: ${JSON.stringify(canopy)}`);
		assert.match(canopy, /1-8 pane · ↑\/↓ move · Enter select · \? help/, `hint segment missing: ${JSON.stringify(canopy)}`);
		// dot leaders connect the identity to the hint segment
		assert.match(canopy, /····/, `canopy is not dot-led: ${JSON.stringify(canopy)}`);
	});

	test("rail-only frame: no rounded box, no `── label ──` rule, rail glyph on every line", () => {
		const dashboard = new RunDashboard([makeRun("team_rail_0001", "running")], () => undefined);
		const out = view(dashboard, 100);
		dashboard.dispose();
		const text = out.join("\n");
		assert.doesNotMatch(text, RETIRED_GLYPHS, "retired box glyph leaked into the dashboard");
		assert.ok(!text.includes("── "), `inline rule survived: ${text}`);
		const offenders = out.filter((line) => line.length > 0 && !/^[┏┣┃┗]( |$)/.test(line));
		assert.deepEqual(offenders, [], "every non-empty row must start with the rail glyph");
	});

	test("sections use `┣` (run groups + the active pane header)", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-crew-rail-sections-"));
		const manifest = makeRun("team_rail_0001", "running", { stateRoot: tmpDir });
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:01`,
				runId: manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "child-process",
				status: "running",
				startedAt: new Date(Date.now() - 5_000).toISOString(),
			},
		]);
		const dashboard = new RunDashboard([manifest, makeRun("team_rail_0002", "completed")], () => undefined);
		const text = view(dashboard, 100).join("\n");
		dashboard.dispose();
		assert.match(text, /^┣ (ACTIVE|RECENT) ▸ \d/m, `group section missing: ${text}`);
		// the default pane is `agents` — its header is a section, not a `── agents ──` rule
		assert.match(text, /^┣ AGENTS$/m, `pane section missing: ${text}`);
		assert.match(text, /^┣ RUN$/m, `run section missing: ${text}`);
	});

	test("the selected run carries the `›` cursor and the surface caps with `┗ <hint>`", () => {
		const dashboard = new RunDashboard([makeRun("team_rail_0001", "running"), makeRun("team_rail_0002", "completed")], () => undefined);
		const out = view(dashboard, 100);
		dashboard.dispose();
		assert.ok(
			out.some((line) => line.startsWith(`┃ ${CURSOR} `)),
			`no cursor row: ${out.join("\n")}`,
		);
		const cursorRows = out.filter((line) => line.includes(CURSOR));
		assert.equal(cursorRows.length, 1, `exactly one row may carry the cursor: ${out.join("\n")}`);
		assert.match(cursorRows[0] ?? "", /^┃ › /, "the cursor row must be a body row");
		const cap = out.filter((line) => line.startsWith("┗ "));
		assert.deepEqual(cap.slice(-1), ["┗ R reload · Esc close"], `cap missing/misplaced: ${out.join("\n")}`);
		assert.equal(cap.length, 1, "exactly one end cap");
	});

	test("overflow uses `▲ n above` / `▼ m below` (windowed run list)", () => {
		const runs = Array.from({ length: 11 }, (_, i) =>
			makeRun(`team_many${String(i).padStart(4, "0")}`, i === 0 ? "running" : "completed"),
		);
		const dashboard = new RunDashboard(runs, () => undefined);
		const first = view(dashboard, 100).join("\n");
		assert.match(first, /┃ ▼ \d+ below/, `no bottom overflow hint: ${first}`);
		assert.ok(!/more below|more above|… \d+ above/.test(first), "retired overflow dialect leaked");
		for (let i = 0; i < 9; i++) dashboard.handleInput("j");
		const scrolled = view(dashboard, 100).join("\n");
		dashboard.dispose();
		assert.match(scrolled, /┃ ▲ \d+ above/, `no top overflow hint after scrolling: ${scrolled}`);
	});

	test("the context footer is a RAIL gauge (bar + number)", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-crew-rail-ctx-"));
		const manifest = makeRun("team_rail_ctx", "running", { stateRoot: tmpDir });
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:01`,
				runId: manifest.runId,
				taskId: "01",
				agent: "explorer",
				role: "explorer",
				runtime: "live-session",
				status: "running",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
			},
		]);
		registerLiveAgent({
			agentId: "01",
			taskId: "01",
			runId: manifest.runId,
			workspaceId: "ws",
			session: { getSessionStats: () => ({ contextUsage: { percent: 42 } }) },
			status: "running",
		});
		const dashboard = new RunDashboard([manifest], () => undefined);
		const text = view(dashboard, 100).join("\n");
		dashboard.dispose();
		assert.match(text, /42% ctx/, `context number missing: ${text}`);
		assert.match(text, /▕[█▏▎▍▌▋▊▉]+░*▏ 42% ctx/, `context gauge bar missing: ${text}`);
	});

	test("unvalidated disk records never print `undefined`", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-crew-rail-undef-"));
		const manifest = makeRun("team_rail_undef", "running", { stateRoot: tmpDir });
		// agents.json is NOT schema-validated at read time — role/agent can be missing.
		saveCrewAgents(manifest, [
			{
				id: `${manifest.runId}:01`,
				runId: manifest.runId,
				taskId: "01",
				runtime: "child-process",
				status: "running",
				startedAt: new Date(Date.now() - 5_000).toISOString(),
			} as unknown as CrewAgentRecord,
		]);
		const dashboard = new RunDashboard([manifest], () => undefined);
		const text = view(dashboard, 100).join("\n");
		dashboard.dispose();
		assert.ok(!text.includes("undefined"), `\`undefined\` reached the render: ${text}`);
		assert.match(text, /Agent: .* 01 \?▸\?/, `missing-field guard not applied: ${text}`);
	});

	test("no line exceeds the render width, ANSI or not (60/100/160)", () => {
		for (const theme of [noopTheme, ansiTheme]) {
			for (const width of [60, 100, 160]) {
				const dashboard = new RunDashboard(
					[makeRun("team_rail_0001", "running"), makeRun("team_rail_0002", "completed")],
					() => undefined,
					theme,
				);
				for (const line of rawLines(dashboard, width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`dashboard line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(strip(line))}`,
					);
				}
				dashboard.dispose();
			}
		}
	});
});

// ─── Agents & jobs browser (§2.D) ──────────────────────────────────────────

function jobFixture(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "watch: omo",
		description: "watch-loop",
		schedule: "0 */2 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: "2026-09-15T00:00:00.000Z",
		runCount: 0,
		nextRun: "2026-09-16T03:00:00.000Z",
		...overrides,
	};
}

function makeBrowser(
	overrides: { agents?: AgentsBrowserAgentEntry[]; jobs?: ScheduledJob[]; theme?: CrewTheme; rows?: number } = {},
): AgentsJobsBrowser {
	return new AgentsJobsBrowser({
		cwd: "/tmp",
		now: () => Date.UTC(2026, 8, 16, 1, 0, 0),
		refreshTtlMs: 0,
		rows: overrides.rows ?? 24,
		theme: overrides.theme,
		agentsProvider: () =>
			overrides.agents ?? [
				{ kind: "agent", runId: "run-1", taskId: "01_01-agent", role: "Explorer", status: "running", tokPerSec: 41 },
				{ kind: "agent", runId: "run-1", taskId: "01_02-writer", role: "Writer", status: "completed" },
			],
		jobsProvider: () => ({ jobs: overrides.jobs ?? [jobFixture()], hiddenCount: 0 }),
	});
}

describe("full-screen RAIL: agents & jobs browser", () => {
	test("canopy + `┗` cap, rail-only frame, no `│` frame column", () => {
		const browser = makeBrowser();
		const out = view(browser, 100);
		browser.dispose();
		const text = out.join("\n");
		assert.match(out[0] ?? "", /^┏ AGENTS ▸ 2 agents · 1 job/, `canopy missing: ${JSON.stringify(out[0])}`);
		assert.match(text, /┗ Q close$/, `cap missing: ${text}`);
		assert.doesNotMatch(text, RETIRED_GLYPHS, "retired box glyph leaked into the browser");
		assert.ok(!text.includes("│"), `inner frame column survived: ${text}`);
		const offenders = out.filter((line) => line.length > 0 && !/^[┏┣┃┗]( |$)/.test(line));
		assert.deepEqual(offenders, [], "every non-empty row must start with the rail glyph");
	});

	test("the two columns are joined by dot leaders, never by a `│` divider", () => {
		const browser = makeBrowser();
		const body = view(browser, 100).filter((line) => line.startsWith("┃ "));
		browser.dispose();
		assert.ok(body.length > 0, "no body rows");
		assert.ok(
			body.some((line) => /[·]{3,}/.test(line)),
			`no dot-leader join (leaders must absorb the slack): ${body.join("\n")}`,
		);
		// the list column keeps the cursor rail: `┃ › <entry>`
		assert.ok(
			body.some((line) => line.startsWith(`┃ ${CURSOR} `)),
			`selected list entry lost its cursor: ${body.join("\n")}`,
		);
	});

	test("the retired overflow dialect is gone from the detail column", () => {
		const browser = makeBrowser({ rows: 12 });
		browser.handleInput("\u001b[B"); // job row
		browser.handleInput("\r"); // inline detail
		for (let i = 0; i < 8; i++) browser.handleInput("j"); // scroll it
		const text = view(browser, 100).join("\n");
		browser.dispose();
		assert.ok(!/… \d+ (above|below)/.test(text), `retired detail-overflow dialect leaked: ${text}`);
		assert.ok(!/more above|more below/.test(text), `retired overflow wording leaked: ${text}`);
	});

	test("unvalidated entries never print `undefined`", () => {
		const browser = makeBrowser({
			agents: [
				{
					kind: "agent",
					runId: "run-1",
					taskId: undefined,
					role: undefined,
					status: undefined,
				} as unknown as AgentsBrowserAgentEntry,
			],
			jobs: [],
		});
		const text = view(browser, 100).join("\n");
		browser.dispose();
		assert.ok(!text.includes("undefined"), `\`undefined\` reached the render: ${text}`);
	});

	test("no line exceeds the render width, ANSI or not (60/100/160)", () => {
		for (const theme of [noopTheme, ansiTheme]) {
			for (const width of [60, 100, 160]) {
				const browser = makeBrowser({
					theme,
					agents: [
						{
							kind: "agent",
							runId: "run-1",
							taskId: "very-long-task-id-that-must-truncate-0123456789",
							role: "Security-Reviewer",
							status: "running",
							tokPerSec: 1234,
						},
					],
					jobs: [jobFixture({ name: "extremely-long-job-name-that-will-need-truncating-in-the-list-column-0123456789" })],
				});
				for (const line of rawLines(browser, width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`browser line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(strip(line))}`,
					);
				}
				browser.dispose();
			}
		}
	});
});

// ─── Settings overlay (§2.E) ───────────────────────────────────────────────

function makeSettings(): ReturnType<typeof createSettingsOverlay>["overlay"] {
	return createSettingsOverlay(
		{},
		noopTheme,
		() => undefined,
		() => undefined,
	).overlay;
}

describe("full-screen RAIL: settings overlay", () => {
	test("canopy + `┗ Esc close` cap, rail-only frame, no `│` tab divider", () => {
		const overlay = makeSettings();
		const out = view(overlay, 100);
		const text = out.join("\n");
		assert.match(out[0] ?? "", /^┏ SETTINGS ▸ pi-crew/, `canopy missing: ${JSON.stringify(out[0])}`);
		assert.match(text, /┗ Esc close$/, `cap missing: ${text}`);
		assert.doesNotMatch(text, RETIRED_GLYPHS, "retired box glyph leaked into the settings overlay");
		assert.ok(!text.includes("│"), `inner frame column survived: ${text}`);
		const offenders = out.filter((line) => line.length > 0 && !/^[┏┃┗]( |$)/.test(line));
		assert.deepEqual(offenders, [], "every non-empty row must start with the rail glyph");
		// the tab bar is a plain rail row joined by ` · ` (no `│`, no rule)
		assert.match(text, /Runtime\s+·\s+.*Limits/, `tab bar lost its join: ${text}`);
	});

	test("`›` is the only cursor and hints use the RAIL format", () => {
		const overlay = makeSettings();
		const text = joined(overlay, 100);
		assert.ok(!text.includes(" → "), `\`→\` cursor survived: ${text}`);
		assert.ok(text.includes(` ${CURSOR} Runtime Mode`), `no cursor row: ${text}`);
		assert.match(text, /↑\/↓ Navigate · Enter\/Space Change · Tab switch/, `hint not in RAIL format: ${text}`);
	});

	test("the scroll indicator uses the RAIL overflow dialect", () => {
		const overlay = makeSettings();
		overlay.handleInput("\u001b[Z"); // shift+tab → advanced (13 settings > 10 visible)
		const text = joined(overlay, 80);
		assert.match(text, /\(1\/13\) ▼ \d+ below/, `overflow indicator missing: ${text}`);
		assert.ok(!/↑\d|↓\d|more (above|below)/.test(text), `retired overflow dialect leaked: ${text}`);
		// scrolling to the end flips to `▲ n above`
		for (let i = 0; i < 13; i++) overlay.handleInput("\u001b[B");
		assert.match(joined(overlay, 80), /▲ \d+ above/, "no `▲ n above` after scrolling to the end");
	});

	test("the enum submenu renders under the rail with `›` + a RAIL hint", () => {
		const overlay = makeSettings();
		overlay.handleInput("\r"); // open the Runtime Mode enum submenu
		const out = view(overlay, 100);
		const text = out.join("\n");
		assert.ok(text.includes(`  ${CURSOR} auto`), `submenu cursor missing: ${text}`);
		assert.ok(!text.includes(" → "), `\`→\` cursor survived in the submenu: ${text}`);
		assert.match(text, /↑\/↓ navigate · Enter to select · Esc to go back/, `submenu hint not in RAIL format: ${text}`);
		const offenders = out.filter((line) => line.length > 0 && !/^[┏┃┗]( |$)/.test(line));
		assert.deepEqual(offenders, [], "every non-empty row must start with the rail glyph");
	});

	test("the agent-overrides edit title is undefined-guarded", () => {
		const overlay = makeSettings();
		overlay.handleInput("\t"); // limits
		overlay.handleInput("\t"); // agents
		overlay.handleInput("\r"); // open Agent Model Overrides
		overlay.handleInput("\r"); // edit the model of the first agent
		assert.match(joined(overlay, 100), /Edit explorer model/, "edit title lost the agent name");
		// White-box: force the cursor out of range — the GUARD must hold.
		(overlay as unknown as { submenu: { selectedIndex: number } }).submenu.selectedIndex = 99;
		const text = joined(overlay, 100);
		assert.ok(!text.includes("undefined"), `\`Edit undefined model\` reached the render: ${text}`);
		assert.match(text, /Edit \? model/, `out-of-range cursor is not guarded: ${text}`);
	});

	test("no line exceeds the render width, ANSI or not (60/100/160)", () => {
		for (const theme of [noopTheme, ansiTheme]) {
			for (const width of [60, 100, 160]) {
				const { overlay } = createSettingsOverlay(
					{},
					theme,
					() => undefined,
					() => undefined,
				);
				for (const line of rawLines(overlay, width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`settings line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(strip(line))}`,
					);
				}
				overlay.handleInput("\r"); // submenu open at the same width
				for (const line of rawLines(overlay, width)) {
					assert.ok(
						visibleWidth(line) <= width,
						`settings submenu line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(strip(line))}`,
					);
				}
			}
		}
	});
});
