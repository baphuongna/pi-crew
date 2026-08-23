/**
 * Unit tests for openPane's async hardening (inline-panel/index.ts).
 *
 * The contract under test:
 *  - A pi extension ctx whose session was replaced (switchSession / resume /
 *    new) throws on ANY property access (`ExtensionRunner.assertActive` guards
 *    every getter). openPane awaits across the session's lifetime, so its
 *    continuation can run AFTER the ctx went stale — an unguarded `ctx.ui.*`
 *    there was an unhandled rejection that killed the whole pi process
 *    ("pi exiting due to uncaughtException: This extension ctx is stale…").
 *  - One view-open at a time: while the first attempt settles (or its
 *    "/crew-view" command sits parked in pi's pendingUserInputs until the
 *    current turn ends), every extra Enter queues ANOTHER command — when the
 *    turn finished they all executed back-to-back and the successive session
 *    teardowns cancelled live work. Repeats must be swallowed with feedback.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { agentEventsPath } from "../../../src/runtime/crew-agent-records.ts";
import { __test__clearManifestCache, createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { __test__openPane, __test__resetViewOpenState } from "../../../src/ui/inline-panel/index.ts";
import { resetCrewViewSessionState } from "../../../src/ui/inline-panel/view-session-store.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};

const workflow: WorkflowConfig = {
	name: "test-workflow",
	description: "Test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "step1", role: "explorer", task: "Do thing" }],
};

interface Fixture {
	cwd: string;
	runId: string;
	taskId: string;
	eventsFile: string;
	viewFile: string;
	mainFile: string;
}

function makeFixture(): Fixture {
	const cwd = createTrackedTempDir("pi-crew-openpane-");
	const created = createRunManifest({ cwd, team, workflow, goal: "openpane hardening" });
	const runId = created.manifest.runId;
	const taskId = created.tasks[0].id;
	const eventsFile = agentEventsPath(created.manifest, taskId);
	fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
	fs.appendFileSync(
		eventsFile,
		`${JSON.stringify({ seq: 1, time: new Date().toISOString(), event: { type: "message", message: { role: "assistant", content: [{ type: "text", text: "working" }] } } })}\n`,
		"utf8",
	);
	// A main session file that EXISTS on disk (settle's switchability check).
	const mainFile = path.join(cwd, "main-session.jsonl");
	fs.writeFileSync(mainFile, `${JSON.stringify({ type: "session", id: "main-1", cwd, time: new Date().toISOString() })}\n`, "utf8");
	return { cwd, runId, taskId, eventsFile, viewFile: path.join(path.dirname(eventsFile), "view-session.jsonl"), mainFile };
}

interface CtxOverrides {
	/** File getSessionFile reports; default = an existing file. */
	sessionFile?: string;
	/** Whether the session reads as idle; default true. */
	idle?: boolean;
	/**
	 * Make the ctx go STALE after the Nth getSessionFile read (mirrors a
	 * session replacement landing mid-open: pi's assertActive throws from
	 * every getter once the session is gone). 1 = buildViewPath's read.
	 */
	staleAfterSessionFileReads?: number;
	/** Collected notify texts when the ctx is alive. */
	notify?: string[];
}

function makeCtx(fixture: Fixture, overrides: CtxOverrides = {}): Record<string, unknown> {
	let stale = false;
	let reads = 0;
	const ctx: Record<string, unknown> = {
		cwd: fixture.cwd,
		isIdle: () => overrides.idle ?? true,
		sessionManager: {
			getSessionFile: () => {
				reads += 1;
				if (overrides.staleAfterSessionFileReads && reads >= overrides.staleAfterSessionFileReads) stale = true;
				return overrides.sessionFile ?? fixture.mainFile;
			},
			getSessionId: () => "sess-main-1",
		},
		ui: {
			notify: (text: string) => {
				overrides.notify?.push(text);
			},
			confirm: async () => true,
		},
	};
	// Mirror pi's stale ctx: assertActive throws from every getter.
	for (const key of ["ui", "cwd", "sessionManager", "isIdle"]) {
		const value = ctx[key];
		Object.defineProperty(ctx, key, {
			get() {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				return value;
			},
			configurable: true,
		});
	}
	return ctx;
}

function flush(ms = 50): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("openPane survives a ctx that went stale mid-open (no unhandled rejection)", async () => {
	const fixture = makeFixture();
	__test__resetViewOpenState();
	resetCrewViewSessionState();
	try {
		// The session dies between buildViewPath and the settle refusal (a
		// previously parked command landed): pre-fix the continuation reached
		// ctx.ui.notify on the dead ctx and killed the whole process.
		const ctx = makeCtx(fixture, {
			staleAfterSessionFileReads: 2,
			sessionFile: path.join(fixture.cwd, "missing.jsonl"),
		});
		__test__openPane(ctx as never, { runId: fixture.runId, taskId: fixture.taskId });
		await flush();
		// The view file was still built (the flow ran past buildViewPath)…
		assert.ok(fs.existsSync(fixture.viewFile), "view file should be built from events");
		// …and reaching here at all means nothing rejected uncaught.
	} finally {
		__test__resetViewOpenState();
		resetCrewViewSessionState();
		__test__clearManifestCache();
		removeTrackedTempDir(fixture.cwd);
	}
});

test("openPane swallows repeated Enters while one open is in flight (no command storm)", async () => {
	const fixture = makeFixture();
	__test__resetViewOpenState();
	resetCrewViewSessionState();
	const notify: string[] = [];
	try {
		const ctx = makeCtx(fixture, { notify });
		const target = { runId: fixture.runId, taskId: fixture.taskId };
		__test__openPane(ctx as never, target);
		await flush(20);
		__test__openPane(ctx as never, target);
		__test__openPane(ctx as never, target);
		await flush();
		const repeats = notify.filter((text) => text.includes("Already opening"));
		assert.equal(repeats.length, 2, `expected repeat feedback, got: ${JSON.stringify(notify)}`);
	} finally {
		__test__resetViewOpenState();
		resetCrewViewSessionState();
		__test__clearManifestCache();
		removeTrackedTempDir(fixture.cwd);
	}
});

test("openPane unblocks after the queued /crew-view command actually runs", async () => {
	const fixture = makeFixture();
	__test__resetViewOpenState();
	resetCrewViewSessionState();
	const notify: string[] = [];
	try {
		const ctx = makeCtx(fixture, { notify });
		const target = { runId: fixture.runId, taskId: fixture.taskId };
		__test__openPane(ctx as never, target);
		await flush(20);
		__test__openPane(ctx as never, target);
		assert.ok(notify.some((text) => text.includes("Already opening")));
		// The queued command executing clears the in-flight mark: the next
		// Enter starts a fresh open instead of being swallowed.
		__test__resetViewOpenState(); // simulates clearPendingViewOpen() from the command handler
		notify.length = 0;
		__test__openPane(ctx as never, target);
		await flush(20);
		assert.ok(!notify.some((text) => text.includes("Already opening")), `unexpected repeat block: ${JSON.stringify(notify)}`);
	} finally {
		__test__resetViewOpenState();
		resetCrewViewSessionState();
		__test__clearManifestCache();
		removeTrackedTempDir(fixture.cwd);
	}
});
