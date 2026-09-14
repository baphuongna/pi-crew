import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import { type AgentsBrowserAgentEntry, AgentsJobsBrowser } from "../../../src/ui/agents-jobs-browser.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 14, 4, 0, 0);

function agent(partial: Partial<AgentsBrowserAgentEntry>): AgentsBrowserAgentEntry {
	return {
		kind: "agent",
		runId: "run-x",
		taskId: "task-x",
		role: "Explorer",
		status: "completed",
		...partial,
	};
}

function job(partial: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "watch: omo",
		description: "watch-loop",
		schedule: "0 */2 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: new Date(NOW - 86_400_000).toISOString(),
		runCount: 0,
		nextRun: new Date(NOW + 3_600_000).toISOString(),
		...partial,
	};
}

let tmpCwd: string;

beforeEach(() => {
	tmpCwd = mkdtempSync(join(tmpdir(), "agents-browser-"));
});

afterEach(() => {
	rmSync(tmpCwd, { recursive: true, force: true });
});

function makeBrowser(overrides: {
	agents?: AgentsBrowserAgentEntry[];
	jobs?: ScheduledJob[];
	hiddenCount?: number;
	surfaceReachable?: boolean;
}) {
	return new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => overrides.agents ?? [],
		jobsProvider: () => ({ jobs: overrides.jobs ?? [], hiddenCount: overrides.hiddenCount ?? 0 }),
		surfaceReachable: overrides.surfaceReachable ?? false,
		surfaceAgent: async () => true,
	});
}

// ─── List merging & ordering ───────────────────────────────────────────────

test("merges agents before jobs, running agents first", () => {
	const browser = makeBrowser({
		agents: [
			agent({ taskId: "done-1", role: "Writer", status: "completed" }),
			agent({ taskId: "run-1", role: "Explorer", status: "running", tokPerSec: 41 }),
		],
		jobs: [job()],
	});
	browser.dispose();

	const entries = browser.entriesView;
	assert.equal(entries.length, 3);
	assert.equal(entries[0].kind, "agent");
	assert.equal(entries[0].kind === "agent" ? entries[0].taskId : "?", "run-1", "running agent sorts first");
	assert.equal(entries[1].kind === "agent" ? entries[1].taskId : "?", "done-1");
	assert.equal(entries[2].kind, "job");
	assert.equal(browser.selectedIndex, 0);
});

test("empty providers render a placeholder list without crashing", () => {
	const browser = makeBrowser({});
	browser.dispose();

	assert.equal(browser.entriesView.length, 0);
	const lines = browser.render(100);
	assert.ok(lines.length > 0, "renders a placeholder");
});

test("selection clamps when the list shrinks", () => {
	let agents: AgentsBrowserAgentEntry[] = [agent({ taskId: "a" }), agent({ taskId: "b" }), agent({ taskId: "c" })];
	const browser = new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => agents,
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		surfaceReachable: false,
	});
	browser.handleInput("j");
	browser.handleInput("j");
	assert.equal(browser.selectedIndex, 2);
	agents = [agents[0]];
	browser.refreshData(true);
	browser.dispose();
	assert.equal(browser.selectedIndex, 0, "clamped to last available entry");
});

// ─── Detail rendering ──────────────────────────────────────────────────────

test("job detail reuses schedule details and appends enabled + hidden lines", () => {
	const browser = makeBrowser({ jobs: [job()], hiddenCount: 2 });
	browser.dispose();

	const lines = browser.detailLinesFor(browser.entriesView[0]);
	const text = lines.join("\n");
	assert.match(text, /watch: omo/, "job name present");
	assert.match(text, /enabled: ● on/, "enabled line appended");
	assert.match(text, /hidden project-tier jobs: 2/, "hidden-tier count appended");
});

test("agent detail without a durable record falls back to a stub, never throws", () => {
	const browser = makeBrowser({ agents: [agent({ taskId: "ghost", role: "Verifier", status: "failed" })] });
	browser.dispose();

	const lines = browser.detailLinesFor(browser.entriesView[0]);
	assert.match(lines.join("\n"), /agent record unavailable/);
});

// ─── Keyboard navigation ───────────────────────────────────────────────────

test("j/k and arrows move selection with bounds; Enter focuses detail; Esc returns", () => {
	const browser = makeBrowser({
		agents: [agent({ taskId: "a" }), agent({ taskId: "b", status: "running" }), agent({ taskId: "c" })],
		jobs: [job()],
	});

	browser.handleInput("j");
	assert.equal(browser.selectedIndex, 1);
	browser.handleInput("\x1b[B"); // down arrow
	assert.equal(browser.selectedIndex, 2);
	browser.handleInput("\x1b[B");
	assert.equal(browser.selectedIndex, 3, "lands on the job row");
	browser.handleInput("\x1b[B");
	assert.equal(browser.selectedIndex, 3, "clamped at the end");
	browser.handleInput("k");
	assert.equal(browser.selectedIndex, 2);

	assert.equal(browser.focusMode, "list");
	browser.handleInput("\r");
	assert.equal(browser.focusMode, "detail", "Enter opens detail");
	browser.handleInput("j");
	browser.handleInput("\x1b");
	assert.equal(browser.focusMode, "list", "Esc backs out of detail");
	browser.dispose();
});

test("q or raw ESC closes the browser from list focus", () => {
	const browser = makeBrowser({ agents: [agent({ taskId: "a" })] });
	assert.equal(browser.isClosed, false);
	browser.handleInput("q");
	assert.equal(browser.isClosed, true);
	browser.dispose();
});

test("[p] triggers surface only for agent entries on a reachable surface", () => {
	const opened: string[] = [];
	const browser = new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => [agent({ taskId: "a", status: "running" })],
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		surfaceReachable: false,
		surfaceAgent: async (entry: AgentsBrowserAgentEntry) => {
			opened.push(entry.taskId);
			return true;
		},
	});
	browser.handleInput("p");
	assert.deepEqual(opened, [], "surface unreachable → no-op");
	browser.dispose();

	const opened2: string[] = [];
	const browser2 = new AgentsJobsBrowser({
		cwd: tmpCwd,
		now: () => NOW,
		refreshTtlMs: 0,
		agentsProvider: () => [agent({ taskId: "a", status: "running" })],
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
		surfaceReachable: true,
		surfaceAgent: async (entry: AgentsBrowserAgentEntry) => {
			opened2.push(entry.taskId);
			return true;
		},
	});
	browser2.handleInput("p");
	assert.deepEqual(opened2, ["a"], "surface reachable → pane requested");
	browser2.dispose();
});

// ─── Width discipline ──────────────────────────────────────────────────────

test("render lines never exceed the terminal width (80 and 200 cols)", () => {
	const browser = makeBrowser({
		agents: [
			agent({
				taskId: "very-long-task-id-that-must-truncate-0123456789",
				role: "Security-Reviewer",
				status: "running",
				tokPerSec: 1234,
			}),
			agent({ taskId: "b", role: "Writer", status: "waiting" }),
		],
		jobs: [job({ name: "extremely-long-job-name-that-will-need-truncating-in-the-list-column-0123456789" })],
	});
	for (const width of [80, 200]) {
		const lines = browser.render(width);
		assert.ok(lines.length > 0, `renders at ${width}`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: visibleWidth=${visibleWidth(line)}: ${JSON.stringify(line)}`);
		}
	}
	const wide = browser.render(200).join("\n");
	assert.match(wide, /1 agent.*1 job|Agents & Jobs/, "header carries counts");
	browser.dispose();
});

// ─── Headless no-op ────────────────────────────────────────────────────────

test("openAgentsJobsBrowser is a no-op returning false without UI", async () => {
	const { openAgentsJobsBrowser } = await import("../../../src/extension/registration/viewers.ts");
	const result = await openAgentsJobsBrowser({ hasUI: false } as never);
	assert.equal(result, false);
});

// ─── Freeze regression (2026-09-14): kitty/enhanced keyboard protocol ───
// Live bug: terminals delivering keys as kitty CSI-u sequences (Escape =
// "\x1b[27u", letters as "\x1b[<code>u") left the browser permanently
// stuck — raw byte comparisons matched NOTHING, so no key worked and the
// overlay could not close. matchesKey normalizes all encodings.
test("kitty-protocol key sequences navigate and close (freeze regression)", () => {
	const browser = makeBrowser({
		agents: [agent({ taskId: "a", status: "running" }), agent({ taskId: "b", status: "completed" })],
		jobs: [job()],
	});
	// down as kitty CSI-u (j = 106): moves selection
	browser.handleInput("\x1b[106u");
	assert.equal(browser.selectedIndex, 1, "kitty j moves down");
	// up (k = 107)
	browser.handleInput("\x1b[107u");
	assert.equal(browser.selectedIndex, 0, "kitty k moves up");
	// enter as kitty CSI-u (return = 13)
	browser.handleInput("\x1b[13u");
	assert.equal(browser.focusMode, "detail", "kitty enter opens detail");
	browser.handleInput("\x1b[27u");
	assert.equal(browser.focusMode, "list", "kitty escape backs out");
	// q as kitty CSI-u (113) closes
	browser.handleInput("\x1b[113u");
	assert.equal(browser.isClosed, true, "kitty q closes the browser");
	browser.dispose();
});

test("default agents source mirrors the widget pipeline (state/runs agents.json)", () => {
	// Regression (live probe 2026-09-14): Agent-tool subagents (foreground AND
	// background) run as child processes and never registerLiveAgent() in the
	// extension process — the old default (in-process live-agent registry) listed
	// NOTHING while the widget said "1 running". The browser must read the same
	// `.crew/state/runs/*/agents.json` pipeline the widget counts use.
	const dir = mkdtempSync(join(tmpdir(), "crew-browser-default-"));
	try {
		const runId = "team_test_browser_default";
		const stateRoot = join(dir, ".crew", "state", "runs", runId);
		mkdirSync(stateRoot, { recursive: true });
		const now = new Date();
		const iso = now.toISOString();
		writeFileSync(
			join(stateRoot, "manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				runId,
				sessionId: "sess-test",
				team: "direct-explorer",
				workflow: "direct-agent",
				goal: "live probe fixture",
				status: "running",
				createdAt: iso,
				updatedAt: iso,
				stateRoot,
			}),
		);
		writeFileSync(
			join(stateRoot, "agents.json"),
			JSON.stringify([
				{
					id: `${runId}:01_01-agent`,
					runId,
					taskId: "01_01-agent",
					agent: "explorer",
					role: "Explorer",
					runtime: "child-process",
					status: "running",
					startedAt: iso,
				},
			]),
		);
		const browser = new AgentsJobsBrowser({
			cwd: dir,
			now: () => now.getTime() + 5000,
			refreshTtlMs: 0,
		});
		const agents = browser.entriesView.filter((e) => e.kind === "agent");
		assert.equal(agents.length, 1, `expected 1 agent, got ${agents.length}`);
		assert.equal(agents[0].role, "Explorer");
		assert.equal(agents[0].status, "running");
		const text = browser.render(100).join("\n");
		assert.match(text, /Live agents \(1\)/);
		assert.match(text, /Explorer/);
		browser.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Enter on an agent fires onOpenTranscript seam; job still focuses inline detail", () => {
	const opened: Array<{ runId: string; taskId: string }> = [];
	const browser = new AgentsJobsBrowser({
		cwd: tmpdir(),
		now: () => Date.UTC(2026, 8, 14, 12),
		refreshTtlMs: 0,
		agentsProvider: () => [{ kind: "agent", runId: "r1", taskId: "t1", role: "Explorer", status: "running" }],
		jobsProvider: () => ({
			jobs: [job()],
			hiddenCount: 0,
		}),
		onOpenTranscript: (entry) => opened.push(entry),
	});
	browser.handleInput("\r");
	assert.deepEqual(opened, [{ runId: "r1", taskId: "t1" }], "Enter opens the transcript overlay via the seam");
	assert.equal(browser.focusMode, "list", "focus stays on list — the overlay owns the detail now");

	// Move down to the job row (agents sort before jobs) and Enter → inline detail.
	opened.length = 0;
	browser.handleInput("j");
	browser.handleInput("\r");
	assert.equal(opened.length, 0, "jobs do not use the transcript seam");
	assert.equal(browser.focusMode, "detail", "job Enter focuses the inline detail column");
	browser.dispose();
});

test("p outside a tmux/herdr surface shows a header notice instead of silence", () => {
	let rendered = 0;
	const browser = new AgentsJobsBrowser({
		cwd: tmpdir(),
		now: () => Date.UTC(2026, 8, 14, 12),
		refreshTtlMs: 0,
		surfaceReachable: false, // no tmux/herdr — the live case that swallowed `p`
		requestRender: () => rendered++,
		agentsProvider: () => [{ kind: "agent", runId: "r1", taskId: "t1", role: "Explorer", status: "running" }],
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
	});
	browser.handleInput("p");
	assert.ok(rendered > 0, "notice triggers a re-render");
	const header = browser.render(100)[0] ?? "";
	assert.match(header, /no tmux\/herdr surface/g, `header explains the dead key: ${header}`);
	// Notice expiry is covered by the next test.
	browser.dispose();
});

test("notice expires and the top border returns to counts", () => {
	let clock = Date.UTC(2026, 8, 14, 12);
	const browser = new AgentsJobsBrowser({
		cwd: tmpdir(),
		now: () => clock,
		refreshTtlMs: 0,
		surfaceReachable: false,
		agentsProvider: () => [{ kind: "agent", runId: "r1", taskId: "t1", role: "Explorer", status: "running" }],
		jobsProvider: () => ({ jobs: [], hiddenCount: 0 }),
	});
	browser.handleInput("p");
	assert.match(browser.render(100)[0] ?? "", /no tmux\/herdr surface/g);
	clock += 3000; // past the 2.5s notice window
	assert.doesNotMatch(browser.render(100)[0] ?? "", /no tmux\/herdr surface/g);
	assert.match(browser.render(100)[0] ?? "", /1 agent/);
	browser.dispose();
});
