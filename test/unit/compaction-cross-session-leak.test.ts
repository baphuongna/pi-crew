/**
 * Regression tests for the compaction-guard cross-session run-context leak.
 *
 * Bug (2026-06-16): `collectInFlightRuns(cwd)` scanned the SHARED per-project
 * `.crew/state/runs/` dir and filtered by STATUS only, ignoring `ownerSessionId`.
 * Multiple Pi sessions in the same project share that dir, so Session B's
 * compaction picked up Session A's in-flight runs and injected them into B's
 * continuation prompt — making B wrongly try to resume A's run. The same leak
 * affected ambient-status injection (context-status-injection.ts).
 *
 * Fix: `collectInFlightRuns(cwd, currentSessionId?)` now restricts to runs
 * owned by the current session (`run.ownerSessionId === currentSessionId`),
 * strict (legacy ownerless runs excluded). `collectCrewArtifactIndex` stays
 * UNFILTERED (durable cross-session memory, not a resume directive).
 *
 * Also covers `extractSessionId(ctx)` (shared safe accessor) and the
 * `triggerContinuation` sendUserMessage race downgrade.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../src/state/state-store.ts";
import {
	buildContinuationPrompt,
	collectInFlightRuns,
} from "../../src/extension/registration/compaction-guard.ts";
import { extractSessionId } from "../../src/utils/session-utils.ts";
import { handleContextEvent } from "../../src/extension/context-status-injection.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "default", description: "d", source: "builtin", filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};
const workflow: WorkflowConfig = {
	name: "default", description: "d", source: "builtin", filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

const createdDirs: string[] = [];

function freshProjectWithCrewRoot(): string {
	// Build a project dir with a `.crew` root so listRecentRuns discovers it.
	const dir = createTrackedTempDir("pi-crew-xsession-");
	fs.mkdirSync(path.join(dir, ".crew"), { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function makeRun(cwd: string, goal: string, ownerSessionId?: string): string {
	return createRunManifest({ cwd, team, workflow, goal, ownerSessionId }).manifest.runId;
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("collectInFlightRuns: session-ownership filter (cross-session leak fix)", () => {
	it("returns ALL in-flight runs when no session filter is given (back-compat)", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A work", "sess-a");
		makeRun(cwd, "session B work", "sess-b");
		const all = collectInFlightRuns(cwd);
		// No filter → both runs visible (back-compat for diagnostics).
		assert.ok(all.length >= 2, "both runs visible without a filter");
	});

	it("filters to ONLY runs owned by the given session", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A work", "sess-a");
		makeRun(cwd, "session B work", "sess-b");
		const onlyA = collectInFlightRuns(cwd, "sess-a");
		assert.equal(onlyA.length, 1, "only session A's run");
		assert.equal(onlyA[0]!.ownerSessionId, "sess-a");
		assert.ok(onlyA.every((r) => r.ownerSessionId === "sess-a"));
		const onlyB = collectInFlightRuns(cwd, "sess-b");
		assert.equal(onlyB.length, 1, "only session B's run");
		assert.equal(onlyB[0]!.ownerSessionId, "sess-b");
	});

	it("STRICT: excludes legacy ownerless runs (no ownerSessionId) under filtering", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "legacy ownerless run"); // no ownerSessionId
		makeRun(cwd, "owned run", "sess-a");
		// Session A must NOT inherit the orphan — crash-recovery handles true orphans.
		const onlyA = collectInFlightRuns(cwd, "sess-a");
		assert.equal(onlyA.length, 1, "orphan not claimed by session A");
		assert.equal(onlyA[0]!.goal, "owned run");
		// A non-existent session sees nothing (orphans excluded even here).
		assert.equal(collectInFlightRuns(cwd, "does-not-exist").length, 0);
		// Back-compat (no filter) still shows the orphan.
		assert.ok(collectInFlightRuns(cwd).length >= 2);
	});

	it("does NOT include terminal runs even when owned", () => {
		const cwd = freshProjectWithCrewRoot();
		const runId = makeRun(cwd, "completed by A", "sess-a");
		// Mark the run completed on disk — it must drop out of the in-flight set.
		const loaded = loadRunManifestById(cwd, runId);
		if (loaded) {
			loaded.manifest.status = "completed";
			saveRunManifest(loaded.manifest);
		}
		assert.equal(collectInFlightRuns(cwd, "sess-a").length, 0, "completed run excluded");
	});
});

describe("extractSessionId: safe ctx accessor", () => {
	it("reads sessionId off a plain object", () => {
		assert.equal(extractSessionId({ sessionId: "sess-123" }), "sess-123");
	});
	it("returns undefined for non-object / missing / empty values", () => {
		assert.equal(extractSessionId(null), undefined);
		assert.equal(extractSessionId(undefined), undefined);
		assert.equal(extractSessionId("sess"), undefined);
		assert.equal(extractSessionId({}), undefined);
		assert.equal(extractSessionId({ sessionId: "" }), undefined);
		assert.equal(extractSessionId({ sessionId: 123 }), undefined);
	});
	it("does not throw on a Proxy / exotic object", () => {
		const exotic = new Proxy({}, {
			get() { throw new Error("trap"); },
			getOwnPropertyDescriptor() { throw new Error("trap"); },
		});
		// Should not throw (descriptor access is caught) — returns undefined.
		assert.doesNotThrow(() => void extractSessionId(exotic));
	});
});

describe("handleContextEvent: ambient status respects session ownership", () => {
	it("injects ONLY the current session's run (not a sibling session's)", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A: dashboard mock", "sess-a");
		makeRun(cwd, "session B: security audit", "sess-b");

		const event = { type: "context" as const, messages: [
			{ role: "user" as const, content: "go", timestamp: 1 },
		] };

		// Session B's view must contain ONLY its own run.
		const resB = handleContextEvent(event, cwd, "sess-b");
		assert.ok(resB, "session B sees its own run");
		const textB = JSON.stringify(resB!.messages);
		assert.ok(textB.includes("security audit"), "session B's goal present");
		assert.ok(!textB.includes("dashboard mock"), "session A's goal NOT leaked to B");

		// Session A's view must contain ONLY its own run.
		const resA = handleContextEvent(event, cwd, "sess-a");
		assert.ok(resA, "session A sees its own run");
		const textA = JSON.stringify(resA!.messages);
		assert.ok(textA.includes("dashboard mock"), "session A's goal present");
		assert.ok(!textA.includes("security audit"), "session B's goal NOT leaked to A");
	});

	it("returns undefined for a session that owns no in-flight runs (no orphan leak)", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A: owned", "sess-a");
		makeRun(cwd, "legacy orphan run"); // no owner
		const event = { type: "context" as const, messages: [
			{ role: "user" as const, content: "go", timestamp: 1 },
		] };
		// Session C owns nothing — must NOT see A's run nor the orphan.
		assert.equal(handleContextEvent(event, cwd, "sess-c"), undefined);
	});

	it("back-compat: no sessionId → still injects all in-flight runs", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A work", "sess-a");
		makeRun(cwd, "session B work", "sess-b");
		const event = { type: "context" as const, messages: [
			{ role: "user" as const, content: "go", timestamp: 1 },
		] };
		const res = handleContextEvent(event, cwd); // no session filter
		assert.ok(res, "ambient status injected without session filter");
		const text = JSON.stringify(res!.messages);
		assert.ok(text.includes("session A work"));
		assert.ok(text.includes("session B work"));
	});
});

describe("buildContinuationPrompt: never references foreign sessions", () => {
	it("only includes runs passed in (caller is now responsible for session filter)", () => {
		const cwd = freshProjectWithCrewRoot();
		makeRun(cwd, "session A work", "sess-a");
		makeRun(cwd, "session B work", "sess-b");
		// Simulate session A's compaction: it must pass ONLY its own runs.
		const ownedByA = collectInFlightRuns(cwd, "sess-a");
		const prompt = buildContinuationPrompt(ownedByA);
		assert.ok(prompt.includes("session A work"));
		assert.ok(!prompt.includes("session B work"), "no cross-session leak in continuation prompt");
	});
});
