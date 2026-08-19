/**
 * WP-1/R1 — ownership-map store tests.
 *
 * Store-level: upsert under the run lock, fresh-reload merge (a pid write does
 * NOT lose the subagentId from an earlier write, and vice versa), round-trip
 * resolve by taskId / subagentId, atomic JSON shape on disk, and
 * missing/corrupt file → empty map with no throw.
 *
 * Back-compat (regression discriminator): a persisted subagent record WITHOUT
 * taskId/runId steers to the existing "not linked" message — no throw, no
 * steering file. On PRE-FIX code the steer stub emits "Steering request noted",
 * so the NOT-contains assertion FAILS — the required red on pre-fix. It turns
 * green once the real steer handler (adaptive-04, subagent-tools.ts) lands.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { registerSubagentTools } from "../../../../src/extension/registration/subagent-tools.ts";
import { SubagentManager, savePersistedSubagentRecord } from "../../../../src/runtime/subagent-manager.ts";
import {
	type OwnershipEntry,
	ownershipMapPath,
	readOwnershipMap,
	recordOwnership,
	resolveEntryBySubagentId,
	resolveEntryByTaskId,
	upsertOwnershipEntry,
} from "../../../../src/state/stores/ownership-map.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { textFromToolResult } from "../../../fixtures/tool-result-helpers.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

const testTeam: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

/** Create a real per-run manifest (stateRoot under <cwd>/.crew/state/runs). */
function makeRun(cwd: string): { manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const { manifest } = createRunManifest({ cwd, team: testTeam, goal: "Ownership map test" });
	return { manifest };
}

function entry(manifest: ReturnType<typeof makeRun>["manifest"], overrides: Partial<OwnershipEntry> = {}): OwnershipEntry {
	return {
		taskId: "01_01-agent",
		runId: manifest.runId,
		subagentId: "agent_abc123",
		artifactsDir: manifest.artifactsRoot,
		depth: 0,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

// ── Store-level tests ─────────────────────────────────────────────────────

// Review finding (WP-1 round 1): a module-level shared EMPTY_MAP singleton is
// mutated by the upsert path (fresh.entries[x] = ...), leaking every prior
// run's entries into the next run's ownership-map.json (createTaskId is
// deterministic — ids repeat). Each fallback must allocate a FRESH map.
test("readOwnershipMap empty-map branches return FRESH objects (no cross-run contamination)", () => {
	const cwd = createTrackedTempDir("pi-crew-ownermap-isolation-");
	try {
		const a = readOwnershipMap(makeRun(cwd).manifest);
		assert.deepEqual(a, { version: 1, entries: {} });
		// Mutate the returned map exactly like upsertOwnershipEntry does.
		a.entries["t-1"] = { taskId: "t-1", runId: "run-A", subagentId: "agent-a", artifactsDir: "/x" } as OwnershipEntry;
		// A second read (same/different run) must NOT see the mutation.
		const b = readOwnershipMap(makeRun(cwd).manifest);
		assert.notEqual(a, b, "each empty-map read must be a distinct object");
		assert.deepEqual(b.entries, {}, "a fresh read must not inherit earlier mutation");
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("readOwnershipMap returns empty map when file is missing (no throw)", () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	try {
		const { manifest } = makeRun(cwd);
		assert.deepEqual(readOwnershipMap(manifest), { version: 1, entries: {} });
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("readOwnershipMap returns empty map for corrupt JSON (no throw)", () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	try {
		const { manifest } = makeRun(cwd);
		fs.mkdirSync(manifest.stateRoot, { recursive: true });
		fs.writeFileSync(ownershipMapPath(manifest), "not json");
		assert.deepEqual(readOwnershipMap(manifest), { version: 1, entries: {} });
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("upsertOwnershipEntry writes atomic JSON under the run lock and round-trips", () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	try {
		const { manifest } = makeRun(cwd);
		upsertOwnershipEntry(manifest, entry(manifest));

		// On-disk atomic JSON shape: {version:1, entries:{<taskId>: {...}}}.
		const raw = JSON.parse(fs.readFileSync(ownershipMapPath(manifest), "utf-8")) as {
			version?: unknown;
			entries?: Record<string, OwnershipEntry>;
		};
		assert.equal(raw.version, 1);
		assert.equal(raw.entries?.["01_01-agent"]?.subagentId, "agent_abc123");

		// Round-trip via the resolve APIs.
		assert.equal(resolveEntryByTaskId(manifest, "01_01-agent")?.subagentId, "agent_abc123");
		assert.equal(resolveEntryByTaskId(manifest, "01_01-agent")?.runId, manifest.runId);
		assert.equal(resolveEntryBySubagentId(manifest, "agent_abc123")?.taskId, "01_01-agent");
		assert.equal(resolveEntryBySubagentId(manifest, "agent_unknown")?.taskId, undefined);
		assert.equal(resolveEntryByTaskId(manifest, "missing-task")?.runId, undefined);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("fresh-reload merge: pid write does not lose subagentId (and vice versa)", () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	try {
		const { manifest } = makeRun(cwd);
		// One-shot Agent-tool spawn path writer.
		upsertOwnershipEntry(manifest, entry(manifest));
		// Child-executor dispatch writer (separate call, same taskId, only pid).
		upsertOwnershipEntry(manifest, {
			taskId: "01_01-agent",
			runId: manifest.runId,
			pid: 4242,
			artifactsDir: manifest.artifactsRoot,
			updatedAt: new Date().toISOString(),
		});

		const merged = resolveEntryByTaskId(manifest, "01_01-agent");
		assert.equal(merged?.subagentId, "agent_abc123", "dispatch write must not clobber subagentId");
		assert.equal(merged?.pid, 4242, "dispatch write must add pid");
		assert.equal(merged?.depth, 0, "one-shot depth must survive the merge");
		assert.equal(merged?.artifactsDir, manifest.artifactsRoot);
		assert.equal(merged?.runId, manifest.runId);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("recordOwnership alias writes the same per-run file with merge semantics", () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	try {
		const { manifest } = makeRun(cwd);
		// Explorer-2 contract shape: cwd + manifest + partial entry.
		recordOwnership(cwd, manifest, { taskId: "01_01-agent", subagentId: "agent_alias" });
		recordOwnership(cwd, manifest, { taskId: "01_01-agent", pid: 99 });

		const merged = resolveEntryBySubagentId(manifest, "agent_alias");
		assert.ok(merged, "alias write must be resolvable by subagentId");
		assert.equal(merged?.pid, 99, "second alias write must add pid without losing subagentId");
		assert.equal(merged?.runId, manifest.runId, "runId defaults to manifest.runId when omitted");
		assert.equal(merged?.artifactsDir, manifest.artifactsRoot, "artifactsDir defaults to manifest.artifactsRoot");
	} finally {
		removeTrackedTempDir(cwd);
	}
});

// ── Back-compat (regression discriminator) ────────────────────────────────

/** Minimal fake pi with just enough to register tools (subagent-cross-session pattern). */
function createFakePi() {
	const tools = new Map<string, any>();
	return {
		tools,
		api: {
			events: {
				on: () => () => undefined,
				emit: () => undefined,
			},
			on: () => () => undefined,
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand: () => undefined,
			sendMessage: () => undefined,
			sendUserMessage: () => undefined,
		},
	};
}

/** Fake tool-execution ctx with a sessionManager returning a fixed id. */
function fakeCtx(cwd: string, sessionId: string | undefined): any {
	const ctx: Record<string, unknown> = {
		cwd,
		hasUI: false,
		ui: {
			notify() {
				/* no-op */
			},
			setWidget() {
				/* no-op */
			},
			setStatus() {
				/* no-op */
			},
		},
	};
	if (sessionId !== undefined) {
		ctx.sessionManager = { getSessionId: () => sessionId };
	}
	return ctx;
}

test("back-compat: steer on an unlinked record returns the 'not linked' message, no throw (fails on pre-fix stub)", async () => {
	const cwd = createTrackedTempDir("pi-crew-ownership-map-");
	const manager = new SubagentManager();
	try {
		// Legacy persisted record WITHOUT taskId / depth / runId (back-compat shape).
		savePersistedSubagentRecord(cwd, {
			id: "agent_legacy",
			type: "explorer",
			description: "Legacy agent",
			prompt: "Do work",
			status: "running",
			startedAt: Date.now(),
			background: true,
		});

		const fake = createFakePi();
		registerSubagentTools(fake.api as never, manager);
		const steer = fake.tools.get("steer_subagent");
		assert.ok(steer, "steer_subagent tool must be registered");

		const result = await steer.execute(
			"call",
			{ agent_id: "agent_legacy", message: "STOP" },
			undefined,
			undefined,
			fakeCtx(cwd, "session-A"),
		);
		assert.equal(result.isError, false, "steer on an unlinked record must not report an error");

		const text = textFromToolResult(result);
		assert.ok(text.includes("not available yet"), `expected steer.unavailable in: ${text}`);
		assert.ok(
			!text.includes("Steering request noted"),
			"pre-fix stub emits 'Steering request noted' — regression discriminator must be red on pre-fix",
		);
	} finally {
		removeTrackedTempDir(cwd);
	}
});
