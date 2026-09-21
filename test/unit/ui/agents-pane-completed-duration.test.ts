import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentsPane } from "../../../src/ui/dashboard-panes/agents-pane.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

/**
 * Tier 13 real-run finding (2026-09-21, run team_20260921092240_b76be11620c9855b):
 * the dashboard AGENTS pane reported `01_explore … 29m39s` for a COMPLETED agent
 * while the tool card reported `8m22s` for the same agent.
 *
 * Cause: the non-live branch (no LiveAgentHandle — every agent of a finished run)
 * computed `nowMs - startedAt` and IGNORED `completedAt`. So a run that ended
 * hours ago kept inflating every finished agent's duration forever; two surfaces
 * describing the same agent disagreed by the run's age.
 *
 * `live-duration.ts` already solved this for the live path
 * (`computeLiveDurationMs` prefers `completedAtMs`); this test pins the fallback
 * branch to the same rule.
 */

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

function makeSnapshot(
	agents: Array<{ id: string; status: string; role: string; startedAt?: string; completedAt?: string }>,
): RunUiSnapshot {
	return {
		runId: "team_test",
		status: "completed",
		team: "fast-fix",
		workflow: "fast-fix",
		goal: "test",
		progress: { total: agents.length, completed: agents.length, running: 0, failed: 0, queued: 0 },
		tasks: [],
		agents: agents.map((a) => ({
			id: a.id,
			taskId: a.id,
			status: a.status as "completed",
			role: a.role,
			agent: a.role,
			runtime: "child-process",
			startedAt: a.startedAt,
			completedAt: a.completedAt,
		})),
	} as unknown as RunUiSnapshot;
}

test("agents pane: a COMPLETED agent's duration uses completedAt, not the wall clock", () => {
	const lines = renderAgentsPane(
		makeSnapshot([
			{
				id: "01_explore",
				status: "completed",
				role: "explorer",
				startedAt: "2026-09-21T09:22:48.987Z",
				completedAt: "2026-09-21T09:31:11.080Z", // +8m22s
			},
		]),
		{ nowMs: NOW }, // 2h38m after completion
	);
	const text = lines.join("\n");
	assert.match(text, /8m22s/, `expected the real 8m22s span, got: ${text}`);
	assert.doesNotMatch(text, /2h3[0-9]m/, "must not measure from completedAt to now");
});

test("agents pane: a RUNNING agent (no completedAt) still ticks against now", () => {
	const lines = renderAgentsPane(
		makeSnapshot([
			{
				id: "01_explore",
				status: "running",
				role: "explorer",
				startedAt: "2026-09-21T11:50:00.000Z", // 10m before NOW
			},
		]),
		{ nowMs: NOW },
	);
	assert.match(lines.join("\n"), /10m0s|10m/, "a running agent must show live elapsed time");
});

test("agents pane: a missing/invalid completedAt falls back to now (never a negative or 0 span)", () => {
	const lines = renderAgentsPane(
		makeSnapshot([
			{
				id: "01_explore",
				status: "completed",
				role: "explorer",
				startedAt: "2026-09-21T11:50:00.000Z",
				completedAt: "not-a-date",
			},
		]),
		{ nowMs: NOW },
	);
	assert.match(lines.join("\n"), /10m/, "invalid completedAt must degrade to the live span, not NaN/0");
});

test("agents pane: a FUTURE completedAt (clock skew) is rejected, not trusted", () => {
	const lines = renderAgentsPane(
		makeSnapshot([
			{
				id: "01_explore",
				status: "completed",
				role: "explorer",
				startedAt: "2026-09-21T11:50:00.000Z",
				completedAt: "2026-09-21T13:00:00.000Z", // 1h AFTER nowMs
			},
		]),
		{ nowMs: NOW },
	);
	// Trusting it would print a 1h10m span for an agent that started 10m ago.
	assert.match(lines.join("\n"), /10m/, "a future completedAt must fall back to now");
	assert.doesNotMatch(lines.join("\n"), /1h/, "must not trust a future completedAt");
});

test("agents pane: a completedAt BEFORE startedAt is rejected (no negative span)", () => {
	const lines = renderAgentsPane(
		makeSnapshot([
			{
				id: "01_explore",
				status: "completed",
				role: "explorer",
				startedAt: "2026-09-21T11:50:00.000Z",
				completedAt: "2026-09-21T11:00:00.000Z", // before startedAt
			},
		]),
		{ nowMs: NOW },
	);
	const text = lines.join("\n");
	assert.doesNotMatch(text, /-/i, "must never render a negative duration");
	assert.match(text, /10m/, "must fall back to the live span");
});
