/**
 * R3-9 — OSC-8 hyperlink on the crew dock (widget-renderer).
 *
 * The dock's ONE clickable action: the subject segment links to the LATEST
 * run's artifacts directory via pi-tui's `hyperlink()` (OSC-8). Under test:
 *   - single run → subject wrapped in `\x1b]8;;file://…` open/close pair;
 *   - multiple runs → `N runs` label links to the newest `createdAt` run;
 *   - no artifactsRoot (legacy manifest) → NO escape bytes (clean degrade);
 *   - idle line (zero runs) → never linked;
 *   - `colorWidgetLine` still paints OSC-8-bearing lines (the guard must
 *     detect CSI styling only, not "any escape");
 *   - `truncateToWidth` clips link-bearing lines WITHOUT slicing inside an
 *     escape (visual.ts OSC awareness) and the measured width stays honest.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { asCrewTheme } from "../../../src/ui/theme-adapter.ts";
import { buildWidgetLines, colorWidgetLine, idleWidgetLine } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";
import { truncateToWidth, visibleWidth } from "../../../src/utils/visual.ts";

const T0 = new Date("2026-10-03T05:00:00.000Z");
const FAKE_CWD = "/tmp/pi-crew-osc8-widget-test";

afterEach(() => {
	// no reader seams used here — runs are injected via `providedRuns`
});

function makeRun(overrides: {
	runId: string;
	createdAt: string;
	artifactsRoot?: string;
	team?: string;
	status?: "running" | "completed";
}): WidgetRun {
	return {
		run: {
			schemaVersion: 1,
			runId: overrides.runId,
			team: overrides.team ?? "default",
			workflow: "default",
			goal: "osc8 test",
			status: overrides.status ?? "running",
			createdAt: overrides.createdAt,
			updatedAt: overrides.createdAt,
			workspaceMode: "single",
			cwd: FAKE_CWD,
			stateRoot: FAKE_CWD,
			artifactsRoot: overrides.artifactsRoot,
			tasksPath: "/tmp/tasks.jsonl",
			eventsPath: "/tmp/events.jsonl",
			pendingTasks: [],
			artifacts: {} as never,
		},
		agents: [
			{
				id: `agent_${overrides.runId}`,
				runId: overrides.runId,
				agent: "explorer",
				role: "explorer",
				taskId: "task_1",
				status: overrides.status === "completed" ? "completed" : "running",
				startedAt: overrides.createdAt,
				prompt: "go",
			} as never,
		],
		snapshot: undefined,
	} as unknown as WidgetRun;
}

const OSC8_OPEN = "\u001b]8;;";

test("single run: dock subject is wrapped in an OSC-8 file:// link to the artifacts dir", () => {
	const runs = [makeRun({ runId: "run_aaa", createdAt: T0.toISOString(), artifactsRoot: "/tmp/arts-a" })];
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, runs);
	assert.equal(lines.length, 1);
	const line = lines[0]!;
	const open = line.indexOf(`${OSC8_OPEN}file://`);
	assert.ok(open !== -1, `expected OSC-8 open in: ${JSON.stringify(line)}`);
	// pi-tui's hyperlink() builds the URL via Node's pathToFileURL(), which on
	// win32 resolves a rooted posix fixture path against the current drive
	// (e.g. "/tmp/arts-a" → "file:///D:/tmp/arts-a"). Compute the expectation
	// with the same primitive so the assertion holds on every CI matrix OS.
	assert.ok(line.includes(pathToFileURL("/tmp/arts-a").href), "URL must point at the artifacts dir");
	// The label stays visible between the open and the close pair.
	const closeIdx = line.indexOf(`${OSC8_OPEN}\u001b\\`, open + 1);
	assert.ok(closeIdx !== -1, "expected OSC-8 close pair");
	assert.ok(line.slice(open, closeIdx).includes("default"), "run label remains the link text");
});

test("multiple runs: the aggregate label links to the NEWEST run's artifacts dir", () => {
	const older = makeRun({ runId: "run_old", createdAt: "2026-10-01T00:00:00.000Z", artifactsRoot: "/tmp/arts-old" });
	const newer = makeRun({ runId: "run_new", createdAt: "2026-10-02T00:00:00.000Z", artifactsRoot: "/tmp/arts-new" });
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [older, newer]);
	const line = lines[0]!;
	assert.ok(line.includes(pathToFileURL("/tmp/arts-new").href), `newest run wins: ${JSON.stringify(line)}`);
	assert.ok(!line.includes("arts-old"), "older run must not be linked");
	assert.ok(line.includes("2 runs"), "aggregate label stays");
});

test("no artifactsRoot (legacy manifest): the dock degrades to plain text", () => {
	const runs = [makeRun({ runId: "run_legacy", createdAt: T0.toISOString(), artifactsRoot: undefined })];
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, runs);
	const line = lines[0]!;
	assert.ok(!line.includes("\u001b"), `no escapes expected: ${JSON.stringify(line)}`);
	assert.ok(line.includes("default"));
});

test("zero runs: the idle line is never linked", () => {
	const idle = idleWidgetLine("\u23F0 1 sched \u00b7 next 5m", false, 100);
	if (idle === undefined) return; // nothing to paint — vacuously fine
	assert.ok(!idle.includes(OSC8_OPEN), "idle dock must not carry a link");
});

test("colorWidgetLine still paints lines that carry ONLY an OSC-8 link (guard detects CSI, not any ESC)", () => {
	// A theme that actually emits escapes — the default asCrewTheme(undefined)
	// is the NOOP theme, which would make "paint applied" unobservable.
	const theme = asCrewTheme({
		fg: (_color: string, text: string) => `\u001b[90m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
	});
	const runs = [makeRun({ runId: "run_paint", createdAt: T0.toISOString(), artifactsRoot: "/tmp/arts-p" })];
	const [plain] = buildWidgetLines(FAKE_CWD, 0, 8, runs);
	const painted = colorWidgetLine(plain!, 0, theme);
	// Identity word gets the accent paint AND the link survives re-emission.
	assert.ok(painted.includes(OSC8_OPEN), "link must survive the paint pass");
	assert.ok(painted.includes("\u001b["), "identity paint must still apply");
});

test("truncateToWidth clips a link-bearing line without slicing inside an escape", () => {
	// Emitting theme (see paint test) so truncation runs against the REAL
	// painted line shape (CSI + OSC-8 interleaved).
	const theme = asCrewTheme({
		fg: (_color: string, text: string) => `\u001b[90m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
	});
	const runs = [makeRun({ runId: "run_trunc", createdAt: T0.toISOString(), artifactsRoot: "/tmp/arts-t" })];
	const [plain] = buildWidgetLines(FAKE_CWD, 0, 8, runs);
	const painted = colorWidgetLine(plain!, 0, theme);
	for (const width of [120, 80, 60, 40, 20]) {
		const clipped = truncateToWidth(painted, width);
		assert.ok(visibleWidth(clipped) <= width, `width respected at ${width}`);
		// OSC-8 sequences must remain whole units: every URL-bearing open has a
		// matching close (close = same prefix with an EMPTY url).
		const totalOsc8 = clipped.split(OSC8_OPEN).length - 1;
		const closes = clipped.split(`${OSC8_OPEN}\u001b\\`).length - 1;
		const opens = totalOsc8 - closes;
		assert.equal(opens, closes, `balanced OSC-8 pairs at width ${width}: ${JSON.stringify(clipped)}`);
		// After stripping complete sequences, no dangling ESC-] introducer remains.
		const stripped = clipped.replaceAll(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
		assert.ok(!stripped.includes("\u001b]"), `no dangling OSC introducers at width ${width}`);
	}
});
