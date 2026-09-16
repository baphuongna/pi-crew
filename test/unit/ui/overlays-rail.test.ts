/**
 * E1 (M4 / docs/UI-DESIGN-SYSTEM.md §2.E/§2.F/§3) — RAIL locks for the OVERLAY
 * surfaces (src/ui/overlays/*.ts + src/ui/live-conversation-overlay.ts).
 *
 * Every assertion below runs against a REAL `render(width)` output of the real
 * overlay classes (never a helper in isolation) with a flat theme, so the locks
 * hold on the bytes the TUI actually paints:
 *
 *   1. the RAIL canopy `┏ NAME ▸ SUBJECT` opens every surface;
 *   2. the retired rounded box (`╭ ╮ ╰ ╯ ├ ┤`) is gone everywhere, and `│`
 *      survives ONLY as an inner two-column separator (never a frame edge);
 *   3. hints come from the shared `formatHint` (close LAST, `Esc` not `ESC`);
 *   4. the help table no longer paints a RAW TAB byte (the retired local
 *      `keyToken` had no `case "\t"`);
 *   5. a record with missing optional fields can never print `undefined`;
 *   6. no line ever exceeds the render width (40 / 80 / 120).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import type { LiveAgentHandle } from "../../../src/runtime/live-session/live-agent-manager.ts";
import { appendMailboxMessage } from "../../../src/state/coordination/mailbox.ts";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import { LiveConversationOverlay } from "../../../src/ui/live-conversation-overlay.ts";
import { AgentPickerOverlay } from "../../../src/ui/overlays/agent-picker-overlay.ts";
import { ConfirmOverlay } from "../../../src/ui/overlays/confirm-overlay.ts";
import { HelpOverlay } from "../../../src/ui/overlays/help-overlay.ts";
import { MailboxComposeOverlay } from "../../../src/ui/overlays/mailbox-compose-overlay.ts";
import { MailboxDetailOverlay } from "../../../src/ui/overlays/mailbox-detail-overlay.ts";
import { formatHint } from "../../../src/ui/rail.ts";
import { asCrewTheme, type CrewTheme } from "../../../src/ui/theme-adapter.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

const WIDTHS = [40, 80, 120] as const;
const RAIL_GLYPHS = ["┏", "┣", "┃", "┗"];
/** Retired rounded-box vocabulary (audit §2.E) — must appear NOWHERE. */
const RETIRED_GLYPHS = ["╭", "╮", "╰", "╯", "├", "┤"];
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const theme = asCrewTheme({});

/** Strip ANSI so the assertions run on the glyphs a terminal shows. */
function plain(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(ANSI, ""));
}

function joined(lines: readonly string[]): string {
	return plain(lines).join("\n");
}

/**
 * Shared RAIL locks for one surface render: rail glyph at the head of every
 * line, no retired box vocabulary, `│` only ever as an inner column separator,
 * no `undefined`, no line wider than `width`.
 */
function assertRailSurface(lines: readonly string[], surface: string, width: number): void {
	assert.ok(lines.length >= 2, `${surface} @${width}: expected a canopy + at least one body/cap line`);
	const bars: string[] = plain(lines);
	const separatorColumns = new Set<number>();
	for (const line of bars) {
		assert.ok(
			RAIL_GLYPHS.some((glyph) => line.startsWith(glyph)),
			`${surface} @${width}: every line must open with a rail glyph, got ${JSON.stringify(line)}`,
		);
		for (const glyph of RETIRED_GLYPHS) {
			assert.ok(!line.includes(glyph), `${surface} @${width}: retired frame glyph ${glyph} in ${JSON.stringify(line)}`);
		}
		let index = line.indexOf("│");
		while (index !== -1) {
			assert.ok(index >= 2, `${surface} @${width}: │ at column ${index} is a frame edge in ${JSON.stringify(line)}`);
			separatorColumns.add(index);
			index = line.indexOf("│", index + 1);
		}
		assert.ok(!line.includes("undefined"), `${surface} @${width}: undefined leaked into ${JSON.stringify(line)}`);
		assert.ok(
			visibleWidth(line) <= width,
			`${surface} @${width}: line exceeds the render width (${visibleWidth(line)}): ${JSON.stringify(line)}`,
		);
	}
	assert.ok(
		separatorColumns.size <= 1,
		`${surface} @${width}: │ must be ONE inner column (got columns ${[...separatorColumns].join(",")})`,
	);
	assert.ok(bars[0]!.startsWith("┏ "), `${surface} @${width}: canopy missing, got ${JSON.stringify(bars[0])}`);
	assert.ok(bars[bars.length - 1]!.startsWith("┗ "), `${surface} @${width}: close cap missing`);
	// §1 text rule: `Esc`, never `ESC`/`esc`.
	assert.ok(!/ESC/.test(joined(lines)), `${surface} @${width}: hint spells ESC (must be Esc)`);
}

function assertWidthsAt(lines: (width: number) => string[], surface: string): void {
	for (const width of WIDTHS) assertRailSurface(lines(width), surface, width);
}

// ── Fixtures ────────────────────────────────────────────────────────────

interface Fixture {
	cwd: string;
	runId: string;
	taskId: string;
}

/** One run with two agents (the second MISSING status/role/agent on disk) and
 *  two mailbox messages — the exact shapes the overlays read. */
function makeRun(): Fixture {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-overlays-rail-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "rail",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [
			{ id: "one", role: "worker" },
			{ id: "two", role: "worker" },
		],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "rail" });
	const taskId = created.tasks[0]?.id ?? "one";
	saveCrewAgents(created.manifest, [
		{
			id: `${created.manifest.runId}:${taskId}`,
			runId: created.manifest.runId,
			taskId,
			agent: "worker",
			role: "executor",
			runtime: "child-process",
			status: "running",
			startedAt: created.manifest.createdAt,
		} as never,
		// Disk-sourced record with the optional fields absent (audit §4).
		{ id: `${created.manifest.runId}:02_second`, runId: created.manifest.runId, taskId: "02_second" } as never,
	]);
	appendMailboxMessage(created.manifest, {
		direction: "inbox",
		from: "lead",
		to: taskId,
		body: "ping",
		taskId,
	});
	appendMailboxMessage(created.manifest, {
		direction: "outbox",
		from: taskId,
		to: "lead",
		body: "pong reply with a long enough body to truncate at narrow widths",
		taskId,
	});
	return { cwd, runId: created.manifest.runId, taskId };
}

function withRun(fn: (fixture: Fixture) => void): void {
	const fixture = makeRun();
	try {
		fn(fixture);
	} finally {
		fs.rmSync(fixture.cwd, { recursive: true, force: true });
	}
}

/** Live handle built inline (the type import is erased at runtime). */
function makeLiveHandle(overrides: { session?: Record<string, unknown>; partial?: boolean } = {}): LiveAgentHandle {
	const base = overrides.partial
		? { agentId: "agent-1", runId: "run-1", workspaceId: "ws-1", session: overrides.session ?? {} }
		: {
				agentId: "agent-1",
				taskId: "task-1",
				runId: "run-1",
				workspaceId: "ws-1",
				role: "executor",
				agent: "worker",
				description: "building feature",
				modelName: "sonnet",
				session: overrides.session ?? {},
			};
	return {
		...base,
		status: "running",
		activity: {
			activeTools: new Map(),
			toolUses: 3,
			turnCount: 2,
			maxTurns: 10,
			responseText: "",
			compactionCount: 0,
			startedAtMs: Date.now() - 5000,
			completedAtMs: 0,
		},
		pendingSteers: [],
		pendingFollowUps: [],
		pendingMessages: [],
	} as unknown as LiveAgentHandle;
}

/** A theme that records every `fg(color, text)` call so the colour ROLE of a
 *  rail glyph can be asserted (the flat theme discards it). */
function recordingTheme(): { theme: CrewTheme; calls: Array<{ color: string; text: string }> } {
	const calls: Array<{ color: string; text: string }> = [];
	const raw = {
		fg: (color: string, text: string): string => {
			calls.push({ color, text });
			return text;
		},
		bold: (text: string): string => text,
	};
	return { theme: asCrewTheme(raw), calls };
}

// ── 1. Agent picker ─────────────────────────────────────────────────────

test("agent-picker: RAIL canopy + guarded disk fields (no `undefined`, `->` retired)", () => {
	withRun(({ cwd, runId }) => {
		const overlay = new AgentPickerOverlay({ cwd, runId, done: () => undefined, theme });
		const lines = overlay.render(80);
		const out = joined(lines);
		assert.ok(out.startsWith("┏ AGENTS ▸ "), `canopy must name the run: ${out}`);
		assert.ok(out.includes("› "), "the selected row keeps the `›` cursor");
		assert.ok(!out.includes("->"), "`->` is retired in favour of `▸`");
		assert.ok(out.includes(" ▸ worker"), "role → agent uses the `▸` identity separator");
		assert.ok(out.includes("? · ? ▸ ?"), `missing disk fields must render as \`?\`: ${out}`);
		assertRailSurface(lines, "agent-picker", 80);
		assertWidthsAt((width) => overlay.render(width), "agent-picker");
		assert.ok(
			plain(lines).some((line) =>
				line.startsWith(
					`┗ ${formatHint([
						[["up", "down"], "move"],
						["enter", "select"],
						["escape", "cancel"],
					])}`,
				),
			),
			`hint must be the shared formatHint output: ${out}`,
		);
	});
});

// ── 2. Confirm ──────────────────────────────────────────────────────────

test("confirm: canopy + body + cap, danger level colours the rail", () => {
	const { theme: recorder, calls } = recordingTheme();
	const overlay = new ConfirmOverlay({ title: "Delete run?", body: "Danger zone", dangerLevel: "high" }, () => undefined, recorder);
	const lines = overlay.render(80);
	const out = joined(lines);
	assert.ok(out.startsWith("┏ CONFIRM ▸ Delete run?"), `canopy must carry the title: ${out}`);
	assert.ok(out.includes("Danger zone"), "body line preserved");
	assert.ok(!out.includes("Are you sure?"), "explicit body replaces the default question");
	assertRailSurface(lines, "confirm", 80);
	assertWidthsAt((width) => overlay.render(width), "confirm");
	assert.ok(
		calls.some((call) => call.color === "error" && call.text === "┏"),
		`dangerLevel=high must paint the rail with the error slot: ${JSON.stringify(calls)}`,
	);
	const capped = plain(lines)[plain(lines).length - 1]!;
	assert.ok(
		capped.includes(
			formatHint([
				["y", "confirm"],
				[["enter", "n", "escape"], "cancel"],
			]),
		),
		`cancel goes LAST in the hint: ${capped}`,
	);
});

test("confirm: defaultAction=confirm flips the hint but keeps `Y confirm`", () => {
	const overlay = new ConfirmOverlay({ title: "Go?", defaultAction: "confirm" }, () => undefined, theme);
	const capped = plain(overlay.render(80)).at(-1)!;
	assert.ok(
		capped.includes(
			formatHint([
				[["enter", "y"], "confirm"],
				[["n", "escape"], "cancel"],
			]),
		),
		`Enter/Y confirm · N/Esc cancel expected: ${capped}`,
	);
});

// ── 3. Help cheatsheet ──────────────────────────────────────────────────

test("help: canopy + `┣ SECTION` groups + no RAW TAB byte in the table", () => {
	const overlay = new HelpOverlay(theme);
	const lines = overlay.render(100);
	const bars = plain(lines);
	const out = bars.join("\n");
	assert.ok(bars[0]!.startsWith("┏ HELP ▸ dashboard"), `canopy expected: ${bars[0]}`);
	assert.ok(out.includes("┣ GENERAL"), "group headers use the `┣ SECTION` glyph");
	assert.ok(out.includes("┣ SCHEDULES (PANE 8)"), "schedules section preserved");
	assert.equal(
		bars.some((line) => line.includes("\t")),
		false,
		"a RAW TAB byte must never reach the table (retired local keyToken)",
	);
	assert.ok(out.includes("Tab"), "the tab key renders as the shared `Tab` token");
	assert.ok(out.includes("↑/↓"), "arrow keys use the shared ↑/↓ token");
	assertRailSurface(lines, "help", 100);
	assertWidthsAt((width) => overlay.render(width), "help");
	assert.ok(
		bars.at(-1)!.startsWith(
			`┗ ${formatHint([
				["?", "toggle"],
				["escape", "dismiss"],
			])}`,
		),
		`help hint must be the shared formatHint output: ${bars.at(-1)}`,
	);
});

// ── 4. Mailbox detail ───────────────────────────────────────────────────

test("mailbox-detail: two-column body keeps `│` as an INNER separator only", () => {
	withRun(({ cwd, runId }) => {
		const overlay = new MailboxDetailOverlay({ runId, cwd, done: () => undefined, theme });
		const lines = overlay.render(100);
		const bars = plain(lines);
		const out = bars.join("\n");
		assert.ok(bars[0]!.startsWith("┏ MAILBOX ▸ "), `canopy must name the run: ${bars[0]}`);
		assert.ok(out.includes("Inbox") && out.includes("Outbox"), "both mailbox columns render");
		assert.ok(out.includes("ping"), "message rows render");
		assert.ok(!out.includes("->"), "`->` is retired in favour of `▸`");
		assert.ok(
			bars.some((line) => line.includes("│")),
			"the two-column body is joined by the inner │ separator",
		);
		assertRailSurface(lines, "mailbox-detail", 100);
		assertWidthsAt((width) => overlay.render(width), "mailbox-detail");
		for (const width of WIDTHS) {
			assert.ok(
				joined(overlay.render(width)).includes(formatHint([["escape", "close"]])),
				`@${width}: the close hint must survive the leader collapse`,
			);
		}
	});
});

test("mailbox-detail: the expanded message is a `┣ MESSAGE` section, not an inline rule", () => {
	withRun(({ cwd, runId }) => {
		const overlay = new MailboxDetailOverlay({ runId, cwd, done: () => undefined, theme });
		overlay.handleInput("\r");
		const lines = overlay.render(80);
		const out = joined(lines);
		assert.ok(out.includes("┣ MESSAGE"), `expanded section header expected: ${out}`);
		assert.equal(/─{4,}/.test(out), false, "the `────` inline rule is retired (sectionLine instead)");
		assert.ok(out.includes("ping"), "expanded body lines render");
		assertRailSurface(lines, "mailbox-detail(expanded)", 80);
	});
});

test("mailbox-detail: a truncated list uses the canonical `▼ n below` overflow hint", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-overlays-rail-overflow-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "rail",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "overflow" });
		const taskId = created.tasks[0]?.id ?? "one";
		for (let index = 0; index < 15; index += 1) {
			appendMailboxMessage(created.manifest, {
				direction: "inbox",
				from: "lead",
				to: taskId,
				body: `message ${index}`,
				taskId,
			});
		}
		const overlay = new MailboxDetailOverlay({ runId: created.manifest.runId, cwd, done: () => undefined, theme });
		const out = joined(overlay.render(100));
		assert.ok(out.includes("▼ 3 below"), `canonical overflow dialect expected (15 rows, 12 shown): ${out}`);
		assert.equal(/↑ \d+ more above|↓\d+|…\d+ above/.test(out), false, "legacy overflow dialects are retired");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── 5. Mailbox compose ──────────────────────────────────────────────────

test("compose: canopy, rail rows and the preview split as an INNER two-column body", () => {
	const overlay = new MailboxComposeOverlay({ done: () => undefined, theme, initial: { body: "# Title\n- item", to: "worker" } });
	const lines = overlay.render(100);
	const bars = plain(lines);
	assert.ok(bars[0]!.startsWith("┏ COMPOSE ▸ mailbox"), `canopy expected: ${bars[0]}`);
	assertRailSurface(lines, "compose", 100);
	assertWidthsAt((width) => overlay.render(width), "compose");
	assert.ok(
		bars.at(-1)!.includes(
			formatHint([
				["P", "preview"],
				["tab", "cycle"],
				["enter", "submit"],
				["escape", "discard"],
			]),
		),
		`compose hint must be the shared formatHint output: ${bars.at(-1)}`,
	);
	overlay.handleInput("P");
	const previewLines = overlay.render(100);
	const previewOut = joined(previewLines);
	assert.ok(previewOut.includes("Preview"), "preview column renders once toggled");
	assert.ok(previewOut.includes("│"), "preview split uses the inner │ column separator");
	assertRailSurface(previewLines, "compose(preview)", 100);
	assert.ok(plain(previewLines).at(-1)!.includes("close preview"), "the preview toggle label follows the state");
});

test("compose: a multi-line pre-filled field is flattened into its single-line cell", () => {
	const overlay = new MailboxComposeOverlay({ done: () => undefined, theme, initial: { to: "worker", body: "line one\nline two" } });
	const lines = overlay.render(80);
	assert.equal(lines.length, 7, `the rail rows stay single-line (got ${lines.length} lines)`);
	assertRailSurface(lines, "compose(multiline)", 80);
});

// ── 6. Live conversation ────────────────────────────────────────────────

test("live-conversation: canopy + meta + cap replaces the rounded box (no `╭─╮│` frame)", () => {
	let emit: ((event: unknown) => void) | undefined;
	const session = {
		subscribe(cb: (event: unknown) => void): () => void {
			emit = cb;
			return () => undefined;
		},
	};
	const overlay = new LiveConversationOverlay(makeLiveHandle({ session }), theme, 80, 12);
	try {
		assert.ok(typeof emit === "function", "session.subscribe callback captured");
		for (let index = 0; index < 30; index += 1) emit?.({ text: `line ${index}` });
		const lines = overlay.render(80);
		const bars = plain(lines);
		assert.ok(bars[0]!.startsWith("┏ LIVE ▸ worker"), `canopy must name the agent: ${bars[0]}`);
		assert.equal(
			bars.some((line) => line.startsWith("│") || line.endsWith("│")),
			false,
			"the `│` frame edges are retired (rail only)",
		);
		assert.ok(joined(lines).includes("line 29"), "the transcript tail is rendered inside the rail");
		assertRailSurface(lines, "live-conversation", 80);
		assertWidthsAt((width) => overlay.render(width), "live-conversation");
		const capped = bars.at(-1)!;
		assert.ok(
			capped.includes(
				formatHint([
					[["up", "down", "pageup", "pagedown", "g", "G"], "scroll"],
					["a", "pause"],
					[["escape", "q"], "close"],
				]),
			),
			`auto footer must advertise the shared hint (close LAST): ${capped}`,
		);
		assert.ok(capped.includes("auto-scroll"), "the scroll state rides the dot-led right segment");
		// One line up from the tail flips the state — keys and scroll behaviour
		// are unchanged by the migration.
		overlay.handleInput("k");
		const manual = plain(overlay.render(80)).at(-1)!;
		assert.match(manual, /manual \d+-\d+\/\d+/, `manual state expected: ${manual}`);
		assert.ok(manual.includes("A resume"), `manual footer advertises the a toggle: ${manual}`);
		overlay.handleInput("G");
		assert.ok(plain(overlay.render(80)).at(-1)!.includes("auto-scroll"), "G restores auto-scroll");
	} finally {
		overlay.close();
	}
});

test("live-conversation: a handle with missing identity fields never prints `undefined`", () => {
	const overlay = new LiveConversationOverlay(makeLiveHandle({ partial: true }), theme, 80, 12);
	try {
		const lines = overlay.render(80);
		const out = joined(lines);
		assert.ok(out.startsWith("┏ LIVE ▸ ?"), `missing name must degrade to \`?\`: ${out}`);
		assert.ok(!out.includes("undefined"), "guarded identity fields");
		assertRailSurface(lines, "live-conversation(partial)", 80);
	} finally {
		overlay.close();
	}
});

test("live-conversation: the running state paints the rail with the accent slot", () => {
	const { theme: recorder, calls } = recordingTheme();
	const overlay = new LiveConversationOverlay(makeLiveHandle(), recorder, 80, 12);
	try {
		overlay.render(80);
		assert.ok(
			calls.some((call) => call.color === "borderAccent" && call.text === "┃"),
			`statusSlot('running') must reach the rail: ${JSON.stringify(calls.slice(0, 12))}`,
		);
	} finally {
		overlay.close();
	}
});
