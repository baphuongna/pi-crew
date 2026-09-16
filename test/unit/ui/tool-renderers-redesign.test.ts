/**
 * R3 — RAIL card behavioural locks.
 *
 * R3 replaced the rounded-box / `◀ BADGE ▶` language with the rail card
 * (`┏ ┃ ┗` rail column + `NAME ▸ SUBJECT` canopy + dot leaders + eighth-block
 * gauge). These assertions carry the same BEHAVIOUR guarantees as R1, phrased
 * against the new vocabulary, plus the R3-only rules (rail on every line,
 * no line wider than the render width, placeholder canopy while args stream).
 *
 * Structural width fuzzing lives in tool-renderers-frame-width.test.ts; the
 * producer↔consumer contract lock lives in tool-progress-formatter.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { asCrewTheme, type CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { formatCompactToolProgress } from "../../../src/ui/tool-progress-formatter.ts";
import { agentToolRenderer, teamToolRenderer } from "../../../src/ui/tool-renderers/index.ts";

const theme: CrewTheme = asCrewTheme({});
const W = 72;

const raw = (c: unknown, w: number = W): string => {
	const lines = (c as { render?: (width: number) => string[] } | null)?.render?.(w);
	return Array.isArray(lines) ? lines.map((l) => l.replace(/\s+$/, "")).join("\n") : "";
};

function record(overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		id: "ag_t1",
		runId: "team_rail_demo",
		taskId: "t1",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process",
		status: "completed",
		startedAt: new Date(Date.now() - 120_000).toISOString(),
		completedAt: new Date(Date.now() - 60_000).toISOString(),
		model: "openai/gpt-5",
		toolUses: 18,
		usage: { input: 12_000, output: 4_100, cost: 0.031 },
		...overrides,
	} as CrewAgentRecord;
}

// ── W3 / R3: identity canopy ────────────────────────────────────────────

test("W3: team renderCall opens with the CREW canopy + team name", () => {
	const text = raw(teamToolRenderer.renderCall({ action: "run", goal: "g", team: "implementation" }, theme, { expanded: false }));
	assert.match(text, /┏ CREW ▸ implementation/);
	assert.match(text, /^┃ g/m, "goal follows on a rail body line");
});

test("W3: a non-run action becomes the canopy word and the run id the subject", () => {
	const text = raw(teamToolRenderer.renderCall({ action: "status", runId: "team_abcdefgh" }, theme, { expanded: false }));
	assert.match(text, /┏ STATUS ▸ abcdefgh/);
});

test("W3: agent renderCall opens with the AGENT canopy + agent name", () => {
	const text = raw(agentToolRenderer.renderCall({ agent: "explorer", prompt: "p" }, theme, { expanded: false }));
	assert.match(text, /┏ AGENT ▸ explorer/);
});

test("R3: args still streaming ⇒ `▸ …` placeholder, never a dangling chevron", () => {
	const teamEmpty = raw(teamToolRenderer.renderCall({}, theme, { expanded: false, argsComplete: false }));
	assert.match(teamEmpty, /┏ CREW ▸ …/, "streaming args show the placeholder subject");
	for (const line of teamEmpty.split("\n")) assert.ok(!/▸\s*$/.test(line), "no dangling chevron with an empty subject");

	const agentEmpty = raw(agentToolRenderer.renderCall({}, theme, { expanded: false, argsComplete: false }));
	assert.match(agentEmpty, /┏ AGENT ▸ …/);
});

test("R3: a COMPLETE call with no subject prints the canopy word alone", () => {
	const list = raw(teamToolRenderer.renderCall({ action: "list" }, theme, { expanded: false, argsComplete: true }));
	assert.match(list, /┏ LIST/, "no-subject action keeps a clean canopy");
	assert.ok(!list.includes("▸"), "no dangling chevron when args are complete and there is nothing to name");
});

test("R3: subagent_type is accepted as the agent name (SDK convention)", () => {
	const text = raw(agentToolRenderer.renderCall({ subagent_type: "verifier", prompt: "p" }, theme, { expanded: false }));
	assert.match(text, /┏ AGENT ▸ verifier/);
});

// ── W2: agent streaming is labeled ──────────────────────────────────────

test("W2: agent streaming names the agent and keeps the elapsed/rate meta", () => {
	const text = raw(
		agentToolRenderer.renderResult(
			{
				details: { agentId: "sub_01", agentName: "adaptive-01-executor", status: "running" },
				content: [{ type: "text", text: "agent status=running elapsed=95s" }],
			},
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assert.match(text, /┃ /, "rail body line");
	assert.match(text, /adaptive-01-executor/);
	assert.match(text, /1m35s/);
});

test("W2: agent streaming falls back to agentId when no name is available", () => {
	const text = raw(
		agentToolRenderer.renderResult(
			{ details: { agentId: "sub_02", status: "running" }, content: [{ type: "text", text: "agent status=running elapsed=5s" }] },
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assert.match(text, /sub_02/);
});

// ── W7: streaming gauge ─────────────────────────────────────────────────

test("W7: streaming gauge merges tally and percentage, elapsed right-aligned", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{
				details: { action: "run" },
				content: [
					{
						type: "text",
						text: formatCompactToolProgress({
							agentId: "team_w7_stream",
							status: "running",
							runId: "team_w7_stream",
							startedAt: Date.now() - 372_000,
							tasks: [
								{
									id: "t1",
									role: "explorer",
									agent: "explorer",
									title: "a",
									status: "completed",
									dependsOn: [],
									cwd: "/tmp",
								},
								{ id: "t2", role: "executor", agent: "executor", title: "b", status: "open", dependsOn: [], cwd: "/tmp" },
								{ id: "t3", role: "executor", agent: "executor", title: "c", status: "open", dependsOn: [], cwd: "/tmp" },
								{ id: "t4", role: "executor", agent: "executor", title: "d", status: "open", dependsOn: [], cwd: "/tmp" },
								{ id: "t5", role: "verifier", agent: "verifier", title: "e", status: "open", dependsOn: [], cwd: "/tmp" },
							] as never,
						}),
					},
				],
			},
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assert.match(text, /1\/5 · 20%/, "tally and pct share one segment");
	assert.match(text, /▕/, "eighth-block gauge is used");
	const row = text.split("\n").find((l) => l.includes("1/5")) ?? "";
	assert.match(row, /6m1[0-9]s$/, "elapsed sits at the right edge");
});

test("R3: agent rows say `1 tool`, not `1 tools` (live-data nit)", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{
				details: {
					action: "run",
					status: "completed",
					runId: "team_plural",
					team: "fast-fix",
					agentRecords: [record({ toolUses: 1 }), record({ id: "ag_t2", taskId: "t2", toolUses: 11 })],
				},
			},
			{ action: "run" },
			theme,
			{ expanded: true },
		),
	);
	assert.match(text, /1 tool ·/, `singular expected:\n${text}`);
	assert.match(text, /11 tools ·/, `plural expected:\n${text}`);
	assert.ok(!/(^|[^0-9])1 tools/.test(text), "no bare `1 tools` (plural form)");
});

test("R3: caps advertise pi's REAL expand chord (ctrl+o), never the phantom ⌘E", () => {
	// `⌘E` is bound by pi to `tui.editor.cursorLineEnd` (move the editor cursor) —
	// pressing it left the card collapsed. `app.tools.expand` = `ctrl+o`
	// (pi 0.85.1 docs/keybindings.md), so that is what the caps must print.
	const teamCard = raw(
		teamToolRenderer.renderResult(
			{
				details: {
					action: "run",
					status: "completed",
					runId: "team_chord",
					team: "fast-fix",
					agentRecords: [record({})],
				},
			},
			{ action: "run" },
			theme,
			{ expanded: false },
		),
	);
	const agentCard = raw(
		agentToolRenderer.renderResult(
			{ details: { action: "run", status: "completed", agentId: "ag_x", agentName: "explorer", results: [] } },
			{},
			theme,
			{ expanded: false },
		),
	);
	for (const [name, text] of [
		["team", teamCard],
		["agent", agentCard],
	] as const) {
		assert.match(text, /ctrl\+o/, `${name} cap must print the real expand chord:\n${text}`);
		assert.ok(!text.includes("⌘E"), `${name} cap must not print the phantom ⌘E:\n${text}`);
	}
});

test("R3: the AGENT cap always advertises the expand chord (live 2026-09-16)", () => {
	// A collapsed agent card whose result carries no output preview used to end on
	// a bare `┗ ● explorer` — the expand affordance disappeared exactly on the card
	// that is hardest to read. The team card always shows the chord; now this one does.
	const noPreview = raw(
		agentToolRenderer.renderResult(
			{
				details: {
					action: "run",
					status: "completed",
					agentId: "ag_x",
					agentName: "explorer",
					results: [{ agentId: "explorer", status: "completed" }],
				},
			},
			{},
			theme,
			{ expanded: false },
		),
	);
	assert.match(noPreview, /┗ ● explorer/, `cap badge+name expected:\n${noPreview}`);
	assert.match(noPreview, /ctrl\+o/, `expand chord missing from the cap:\n${noPreview}`);

	const withPreview = raw(
		agentToolRenderer.renderResult(
			{
				details: {
					action: "run",
					status: "completed",
					agentId: "ag_x",
					agentName: "explorer",
					results: [{ agentId: "explorer", status: "completed", output: "first line of the report" }],
				},
			},
			{},
			theme,
			{ expanded: false },
		),
	);
	assert.match(withPreview, /┗ ● explorer.*first line of the report.*ctrl\+o/, `preview + chord expected:\n${withPreview}`);
});

test("R3: `role/agent` duplication is collapsed on the live agent line", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{
				details: { action: "run" },
				content: [
					{
						type: "text",
						text: formatCompactToolProgress({
							agentId: "team_dedupe",
							status: "running",
							runId: "team_dedupe",
							startedAt: Date.now() - 30_000,
							tasks: [
								{
									id: "t1",
									role: "verifier",
									agent: "verifier",
									title: "a",
									status: "completed",
									dependsOn: [],
									cwd: "/tmp",
								},
								{
									id: "t2",
									role: "verifier",
									agent: "verifier",
									title: "b",
									status: "completed",
									dependsOn: [],
									cwd: "/tmp",
								},
								{
									id: "t3",
									role: "verifier",
									agent: "verifier",
									title: "c",
									status: "completed",
									dependsOn: [],
									cwd: "/tmp",
								},
							] as never,
							agents: [
								{
									id: "ag_v",
									runId: "team_dedupe",
									taskId: "t3",
									agent: "verifier",
									role: "verifier",
									runtime: "child-process",
									status: "running",
									startedAt: new Date(Date.now() - 20_000).toISOString(),
									progress: { currentTool: "bash", toolCount: 3, turns: 2, tokens: 900 },
								} as never,
							],
						}),
					},
				],
			},
			{ isPartial: true },
			theme,
			{ expanded: false },
		),
	);
	assert.match(text, /verifier/, "agent line keeps the name");
	assert.ok(!text.includes("verifier/verifier"), `role/agent duplication must collapse:\n${text}`);
});

test("W7: expanded gauge uses the same merged format", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{
				details: {
					action: "run",
					status: "completed",
					runId: "team_w7b_demo",
					agentRecords: [record(), record({ id: "ag_t2", taskId: "t2" })],
				},
			},
			{ action: "run" },
			theme,
			{ expanded: true },
		),
	);
	assert.match(text, /2\/2 · 100%/);
});

// ── W1: fail-visible ────────────────────────────────────────────────────

test("W1: a throwing payload renders an ERROR line, never a fake 'done'", () => {
	const bomb = {
		get details(): unknown {
			throw new Error("payload exploded");
		},
	};
	const teamText = raw(teamToolRenderer.renderResult(bomb as never, {}, theme, { expanded: false }));
	assert.match(teamText, /✖ card render error: payload exploded/);
	assert.ok(!teamText.includes("done"), "must not claim done");

	const agentText = raw(agentToolRenderer.renderResult(bomb as never, {}, theme, { expanded: false }));
	assert.match(agentText, /✖ card render error/, "agent renderer must fail visibly too");
});

// ── W6: status aliases ──────────────────────────────────────────────────

test("W6: status alias 'done' maps to the success badge, not the dim fallback", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{ details: { action: "run", status: "done", runId: "team_alias_demo", agentRecords: [record()] } },
			{ action: "run" },
			theme,
			{ expanded: false },
		),
	);
	assert.ok(text.includes("●"), "done ⇒ filled success badge");
	assert.ok(!text.includes("○"), "done must not render the dim fallback dot");
});

// ── W5: the run card identifies the team ────────────────────────────────

test("W5: the collapsed end cap carries the tally and the team name", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{ details: { action: "run", status: "completed", runId: "team_w5_demo", team: "implementation", agentRecords: [record()] } },
			{ action: "run" },
			theme,
			{ expanded: false },
		),
	);
	assert.match(text, /^┗ ● 1\/1 · implementation/m);
	assert.match(text, /ctrl\+o/, "expand hint survives the leaders");
});

test("W5: the expanded card closes with a rail cap carrying the team", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{
				details: { action: "run", status: "completed", runId: "team_w5b_demo", team: "research", agentRecords: [record()] },
			},
			{ action: "run" },
			theme,
			{ expanded: true },
		),
	);
	const lines = text.split("\n");
	assert.ok(
		lines.some((l) => l.startsWith("┗")),
		"expanded card closes with an end cap",
	);
	assert.match(text, /research/);
});

// ── R3-only invariants ──────────────────────────────────────────────────

test("R3: every line keeps the rail column at a narrow width", () => {
	const cases: Array<() => unknown> = [
		() => teamToolRenderer.renderCall({ action: "run", goal: "x".repeat(90), team: "implementation" }, theme, { expanded: false }),
		() =>
			teamToolRenderer.renderResult(
				{ details: { action: "run", status: "done", runId: "team_narrow", team: "implementation", agentRecords: [record()] } },
				{ action: "run" },
				theme,
				{ expanded: false },
			),
		() =>
			teamToolRenderer.renderResult(
				{ details: { action: "run", status: "completed", runId: "team_narrow2", agentRecords: [record()] } },
				{ action: "run" },
				theme,
				{ expanded: true },
			),
		() =>
			agentToolRenderer.renderResult(
				{
					details: { agentId: "sub_03", agentName: "adaptive-with-a-very-long-executor-name", status: "running" },
					content: [{ type: "text", text: "agent status=running elapsed=95s" }],
				},
				{ isPartial: true },
				theme,
				{ expanded: false },
			),
	];
	for (const w of [44, 72, 200]) {
		for (const [i, make] of cases.entries()) {
			for (const line of raw(make(), w).split("\n").filter(Boolean)) {
				assert.ok(line.length <= w, `w=${w} case ${i}: overflow (${line.length} cols)`);
				assert.match(line, /^[┏┃┗] /, `w=${w} case ${i}: line keeps its rail column`);
			}
		}
	}
});

test("R3: a wide column keeps the end cap at the rail width (no ragged tail)", () => {
	const text = raw(
		teamToolRenderer.renderResult(
			{ details: { action: "run", status: "completed", runId: "team_wide", team: "implementation", agentRecords: [record()] } },
			{ action: "run" },
			theme,
			{ expanded: false },
		),
		200,
	);
	const cap = text.split("\n").find((l) => l.startsWith("┗")) ?? "";
	assert.ok(cap.length <= 200);
	assert.match(cap, /ctrl\+o$/);
});
