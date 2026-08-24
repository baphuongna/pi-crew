/**
 * Unit tests for team-tool inspect handlers (events, artifacts, summary).
 * @see src/extension/team-tool/inspect.ts
 *
 * NOTE: These handlers depend heavily on filesystem state (run manifests, events).
 * We test argument validation and error handling for missing/invalid parameters.
 * Full integration tests would require creating run manifests on disk.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { handleArtifacts, handleEvents, handleSummary } from "../../../../src/extension/team-tool/inspect.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

function makeCtx(overrides: Partial<TeamContext> = {}): TeamContext {
	return { cwd: "/tmp/inspect-test", ...overrides };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

const fixtureTeam: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const fixtureWorkflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/** Real-run fixture (same .git + .crew markers as the state-store tests) with
 *  `count` seq-stamped task.progress events pre-written to events.jsonl. */
function makeRunWithEvents(count: number): { cwd: string; runId: string } {
	let cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-inspect-events-"));
	try {
		const real = fs.realpathSync.native(cwd);
		cwd = real.startsWith("\\\\?\\") ? real.slice(4) : real;
	} catch {
		/* keep as-is */
	}
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const { manifest } = createRunManifest({ cwd, team: fixtureTeam, workflow: fixtureWorkflow, goal: "events display" });
	const lines: string[] = [];
	for (let i = 1; i <= count; i++) {
		// Zero-padded markers so "ev-0001" is not a substring of any later marker.
		lines.push(
			JSON.stringify({
				time: "2026-08-24T00:00:00.000Z",
				type: "task.progress",
				runId: manifest.runId,
				message: `ev-${String(i).padStart(4, "0")}`,
				metadata: { seq: i },
			}),
		);
	}
	fs.appendFileSync(manifest.eventsPath, `${lines.join("\n")}\n`, "utf-8");
	return { cwd, runId: manifest.runId };
}

// ─── handleEvents ─────────────────────────────────────────────────────────────

describe("handleEvents", () => {
	it("returns error when runId is missing", () => {
		const res = handleEvents(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleEvents(makeParams({ runId: "nonexistent-run-999" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=events in details", () => {
		const res = handleEvents(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "events");
	});

	it("shows a truncation indicator and drops the oldest events when the run exceeds 500 events", () => {
		const { cwd, runId } = makeRunWithEvents(505);
		try {
			const res = handleEvents(makeParams({ runId }), makeCtx({ cwd }));
			const text = textFromToolResult(res);
			assert.strictEqual(res.isError, false);
			// createRunManifest also appends lifecycle events (e.g. run.created),
			// so the cursor total is 505 + those — match the indicator shape and
			// require a total strictly above the 500-event display slice.
			const indicator = text.match(/\(showing last (\d+) of (\d+) events\)/);
			assert.ok(indicator, `indicator must be present, got: ${text.slice(0, 200)}`);
			assert.equal(indicator[1], "500", "display slice is the last 500 events");
			assert.ok(Number(indicator[2]) > 500, `cursor total must exceed the slice (got ${indicator[2]})`);
			assert.ok(text.includes("ev-0505"), "latest event must be displayed");
			assert.ok(!text.includes("ev-0001"), "oldest event must be dropped by the 500-event slice");
			assert.ok(!text.includes("ev-0005"), "5th-oldest event must be dropped by the 500-event slice");
			assert.equal((text.match(/ev-\d{4}/g) ?? []).length, 500, "exactly 500 events displayed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("shows no truncation indicator when the run has 500 or fewer events", () => {
		const { cwd, runId } = makeRunWithEvents(3);
		try {
			const res = handleEvents(makeParams({ runId }), makeCtx({ cwd }));
			const text = textFromToolResult(res);
			assert.strictEqual(res.isError, false);
			assert.ok(!text.includes("showing last"), `no indicator expected, got: ${text.slice(0, 200)}`);
			assert.ok(text.includes("ev-0001"), "all events displayed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── handleArtifacts ──────────────────────────────────────────────────────────

describe("handleArtifacts", () => {
	it("returns error when runId is missing", () => {
		const res = handleArtifacts(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleArtifacts(makeParams({ runId: "missing-run" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=artifacts in details", () => {
		const res = handleArtifacts(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "artifacts");
	});
});

// ─── handleSummary ────────────────────────────────────────────────────────────

describe("handleSummary", () => {
	it("returns error when runId is missing", () => {
		const res = handleSummary(makeParams(), makeCtx());

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("runId"));
	});

	it("returns error when run is not found", () => {
		const res = handleSummary(makeParams({ runId: "missing-run" }), makeCtx({ cwd: "/tmp/no-such-dir" }));

		assert.strictEqual(res.isError, true);
		const text = textFromToolResult(res);
		assert.ok(text.includes("not found"));
	});

	it("includes action=summary in details", () => {
		const res = handleSummary(makeParams({ runId: "any-run" }), makeCtx());

		assert.strictEqual(res.details.action, "summary");
	});
});
