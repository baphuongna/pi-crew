/**
 * M1-5 (audit P1-7) — every `team` / `agent` tool render branch must fit inside
 * the card frame, for mixed-width content (CJK / emoji / ANSI).
 *
 * Audit repro: 32 CJK chars (= 64 visual columns) with the renderer's
 * `innerW = 40` overflowed the frame because the `team` expanded non-run branch
 * used `text.slice(0, innerW - 2)` (UTF-16 code units) + `padVisual` (which only
 * pads). The fix routes that branch through `truncVisual` → `truncateToWidth`.
 *
 * Measurement note: the renderers hand back a pi-tui `Text`, whose
 * `render(width)` WRAPS any overflowing line into extra lines — asserting on
 * that output would hide the very bug under test. These tests read the
 * pre-wrap frame text (pi-tui's `Text` keeps it in a plain `text` field;
 * `private` is compile-time only) so an over-wide line stays visible.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { asCrewTheme, type CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { setBrief } from "../../../src/ui/tool-renderers/brief-mode.ts";
import { agentToolRenderer, teamToolRenderer } from "../../../src/ui/tool-renderers/index.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

// ── Fixtures ───────────────────────────────────────────────────────────

/** Total width handed to the renderer (matches the default 116-wide card shape). */
const WIDTH = 44;
/** The renderer's own `innerW = width - 4`; a frame line is `│` + innerW + `│`. */
const INNER = WIDTH - 4;

const plainTheme: CrewTheme = asCrewTheme({});

/** A theme that emits real SGR codes + exposes the bg/fg probes: exercises the
 *  `padWithBackground` frame path and ANSI inside content lines. */
const ansiTheme: CrewTheme = asCrewTheme({
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	getFgAnsi: () => "\x1b[38;2;120;200;120m",
	getBgAnsi: () => "\x1b[48;2;12;12;12m",
});

function agentRecord(overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		id: "agent_1",
		runId: "run_1",
		taskId: "task_1",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process",
		status: "completed",
		startedAt: "2026-09-15T00:00:00.000Z",
		completedAt: "2026-09-15T00:01:00.000Z",
		toolUses: 3,
		model: "openai/gpt-5",
		usage: { input: 1200, output: 400, cost: 0.02 },
		...overrides,
	} as CrewAgentRecord;
}

function textContent(text: string): Array<Record<string, unknown>> {
	return [{ type: "text", text }];
}

/**
 * Render through the REAL path (R2: AdaptiveCard builds the frame at the
 * width the caller provides), then read the produced lines.
 */
function rawText(component: unknown): string {
	const lines = (component as { render?: (w: number) => string[] } | null)?.render?.(WIDTH);
	// Text.render pads every line to the full column width (background fill) —
	// that cosmetic pad is not overflow; strip it before measuring.
	return Array.isArray(lines) ? lines.map((l) => l.replace(/\s+$/, "")).join("\n") : "";
}

/** Assert every pre-wrap frame line fits the frame (`innerW + 2` columns). */
function assertFrame(component: unknown, label: string): void {
	const lines = rawText(component)
		.split("\n")
		.filter((line) => line.length > 0);
	assert.ok(lines.length >= 1, `${label}: expected at least one rail line, got ${lines.length}`);
	const RAIL_GLYPHS = ["┏", "┃", "┗"];
	for (const line of lines) {
		// R3 invariant: nothing exceeds the render width, and every line is a
		// rail line (the card carries no box frame any more).
		const width = visibleWidth(line);
		assert.ok(width <= WIDTH, `${label}: line overflows width=${WIDTH} (${width} cols): ${JSON.stringify(line.slice(0, 70))}`);
		const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(
			RAIL_GLYPHS.some((g) => plain.startsWith(g)),
			`${label}: line lost its rail glyph: ${JSON.stringify(line.slice(0, 30))}`,
		);
	}
}

// ── Fuzz corpus: 20 mixed-width strings (CJK / emoji / ANSI / combining) ─

const PATTERNS: Array<(i: number) => string> = [
	// CJK — double width, 8..65 chars (the audit's failure mode)
	(i) => "汉".repeat(8 + i * 3),
	// Emoji — surrogate pairs, width 2 each
	(i) => "🚀".repeat(6 + i * 3),
	// ANSI-wrapped ASCII
	(i) => `\x1b[31m${"wide".repeat(4 + i * 2)}\x1b[0m`,
	// CJK + emoji + ANSI mix
	(i) => `\x1b[1m汉🚀 ${"x".repeat(10 + i * 2)} 漢字\x1b[22m 🚀🚀`,
	// Combining marks (zero width) + long ASCII
	(i) => `${"e\u0301".repeat(10 + i)}${"z".repeat(20 + i * 2)}`,
];

const CASES: string[] = Array.from({ length: 20 }, (_, i) => PATTERNS[i % PATTERNS.length]!(i));

// ── Render-branch scenario table ───────────────────────────────────────
// Every content branch of teamToolRenderer / agentToolRenderer, driven with the
// fuzz string where the branch renders caller-provided text.

interface Scenario {
	readonly label: string;
	readonly render: (s: string, theme: CrewTheme) => unknown;
}

const TEAM: Scenario[] = [
	{
		label: "team.renderCall(action+goal)",
		render: (s, theme) =>
			teamToolRenderer.renderCall({ action: "run", goal: s, team: "impl" }, theme, { expanded: false, width: WIDTH }),
	},
	{
		label: "team.renderCall(no goal)",
		render: (_s, theme) => teamToolRenderer.renderCall({ action: "status" }, theme, { expanded: false, width: WIDTH }),
	},
	{
		label: "team.renderResult(partial, task counts)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{ details: { action: "run" }, content: textContent("team run=run_1 elapsed=11s\n  tasks 2/5 done completed=2 running=3") },
				{ isPartial: true },
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "team.renderResult(partial, starting)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{ details: { action: "run" }, content: textContent("team status=starting elapsed=11s") },
				{ isPartial: true },
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "team.renderResult(partial, unparsed preview)",
		render: (s, theme) =>
			teamToolRenderer.renderResult({ details: { action: "run" }, content: textContent(s) }, { isPartial: true }, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "team.renderResult(brief, non-run)",
		render: (s, theme) =>
			teamToolRenderer.renderResult({ details: { action: "status", status: "completed" }, content: textContent(s) }, {}, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "team.renderResult(collapsed run, records)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{ details: { action: "run", status: "completed", runId: "run_1", agentRecords: [agentRecord()] } },
				{},
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "team.renderResult(collapsed run, metrics)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{
					details: {
						action: "run",
						status: "completed",
						runId: "run_1",
						metrics: { taskCount: 4, completedCount: 3, durationMs: 1234, totalTokens: 5000, totalCost: 0.12 },
					},
				},
				{},
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "team.renderResult(collapsed run, simple card)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult({ details: { action: "run", status: "completed", runId: "run_1" } }, {}, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "team.renderResult(collapsed non-run, simple card)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult({ details: { action: "status", status: "completed", runId: "run_1" } }, {}, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "team.renderResult(expanded run, records)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{
					details: {
						action: "run",
						status: "completed",
						runId: "run_1",
						agentRecords: [agentRecord(), agentRecord({ id: "agent_2", status: "failed", error: "boom" })],
					},
				},
				{},
				theme,
				{ expanded: true, width: WIDTH },
			),
	},
	{
		label: "team.renderResult(expanded run, metrics)",
		render: (_s, theme) =>
			teamToolRenderer.renderResult(
				{
					details: {
						action: "run",
						status: "completed",
						runId: "run_1",
						metrics: { taskCount: 4, completedCount: 1, durationMs: 9000, totalTokens: 400 },
					},
				},
				{},
				theme,
				{ expanded: true, width: WIDTH },
			),
	},
	{
		// P1-7 — the branch that used `text.slice(0, innerW - 2)`.
		label: "team.renderResult(expanded non-run, content text)",
		render: (s, theme) =>
			teamToolRenderer.renderResult({ details: { action: "status" }, content: textContent(s) }, {}, theme, {
				expanded: true,
				width: WIDTH,
			}),
	},
];

const AGENT: Scenario[] = [
	{
		label: "agent.renderCall(agent+prompt)",
		render: (s, theme) => agentToolRenderer.renderCall({ agent: "explorer", prompt: s }, theme, { expanded: false, width: WIDTH }),
	},
	{
		label: "agent.renderCall(no prompt)",
		render: (_s, theme) => agentToolRenderer.renderCall({}, theme, { expanded: false, width: WIDTH }),
	},
	{
		label: "agent.renderResult(partial, progress text)",
		render: (_s, theme) =>
			agentToolRenderer.renderResult(
				{
					details: { agentId: "agent_1" },
					content: textContent(
						"agent=agent_1 status=running elapsed=12s\n  explorer->explorer turn=5 tokens=2400\n  tool: Read (#3)",
					),
				},
				{ isPartial: true },
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "agent.renderResult(partial, empty content)",
		render: (_s, theme) =>
			agentToolRenderer.renderResult({ details: { agentId: "agent_1" } }, { isPartial: true }, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "agent.renderResult(brief agent)",
		render: (_s, theme) =>
			agentToolRenderer.renderResult({ details: { status: "completed" }, content: textContent("") }, {}, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "agent.renderResult(collapsed, output preview)",
		render: (s, theme) =>
			agentToolRenderer.renderResult(
				{ details: { agentId: "agent_1", status: "completed", results: [{ agentId: "agent_1", status: "completed", output: s }] } },
				{},
				theme,
				{ expanded: false, width: WIDTH },
			),
	},
	{
		label: "agent.renderResult(collapsed, error preview)",
		render: (s, theme) =>
			agentToolRenderer.renderResult({ details: { agentId: "agent_1", status: "failed", error: s } }, {}, theme, {
				expanded: false,
				width: WIDTH,
			}),
	},
	{
		label: "agent.renderResult(expanded, result rows)",
		render: (s, theme) =>
			agentToolRenderer.renderResult(
				{
					details: {
						status: "completed",
						results: [
							{ agentId: "agent_1", status: "failed", error: s },
							{ agentId: "agent_2", status: "completed", output: s },
						],
					},
				},
				{},
				theme,
				{ expanded: true, width: WIDTH },
			),
	},
	{
		label: "agent.renderResult(expanded, agentId row + error)",
		render: (s, theme) =>
			agentToolRenderer.renderResult({ details: { agentId: "agent_1", status: "failed", error: s } }, {}, theme, {
				expanded: true,
				width: WIDTH,
			}),
	},
	{
		label: "agent.renderResult(expanded, content text fallback)",
		render: (s, theme) =>
			agentToolRenderer.renderResult({ details: { status: "completed" }, content: textContent(s) }, {}, theme, {
				expanded: true,
				width: WIDTH,
			}),
	},
];

// ── Tests ──────────────────────────────────────────────────────────────

test("M1-5: audit repro — 32 CJK chars (64 cols) at innerW=40 no longer overflow", () => {
	const cjk = "汉".repeat(32);
	// The audit's measurement, asserted so the repro cannot silently drift.
	assert.equal(visibleWidth(cjk), 64);

	const component = teamToolRenderer.renderResult({ details: { action: "status" }, content: textContent(cjk) }, {}, plainTheme, {
		expanded: true,
		width: WIDTH,
	});
	const lines = rawText(component)
		.split("\n")
		.filter((line) => line.length > 0);
	// Before the fix this line was 67 columns wide (1 + 64 + 2).
	assert.ok(
		lines.every((line) => visibleWidth(line) <= INNER + 2),
		`frame overflowed: ${lines.map((l) => visibleWidth(l)).join(",")}`,
	);
	assertFrame(component, "team expanded non-run (CJK audit repro)");
});

test("M1-5: every team render branch fits the frame (20 mixed-width strings, plain + ANSI theme)", () => {
	try {
		for (const scenario of TEAM) {
			for (const s of CASES) {
				assertFrame(scenario.render(s, plainTheme), `${scenario.label} [plain]`);
				assertFrame(scenario.render(s, ansiTheme), `${scenario.label} [ansi]`);
			}
		}
	} finally {
		setBrief(false);
	}
});

test("M1-5: every agent render branch fits the frame (20 mixed-width strings, plain + ANSI theme)", () => {
	try {
		for (const scenario of AGENT) {
			for (const s of CASES) {
				assertFrame(scenario.render(s, plainTheme), `${scenario.label} [plain]`);
				assertFrame(scenario.render(s, ansiTheme), `${scenario.label} [ansi]`);
			}
		}
	} finally {
		setBrief(false);
	}
});

test("M1-5: brief-mode team branch (isBrief) also fits the frame", () => {
	try {
		setBrief(true);
		const scenario = TEAM.find((s) => s.label.includes("brief"));
		assert.ok(scenario, "brief scenario missing from the table");
		for (const s of CASES) {
			assertFrame(scenario.render(s, plainTheme), `${scenario.label} [plain]`);
			assertFrame(scenario.render(s, ansiTheme), `${scenario.label} [ansi]`);
		}
	} finally {
		// Never leak brief state into other test files.
		setBrief(false);
	}
});
