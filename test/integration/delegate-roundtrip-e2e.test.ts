/**
 * Delegate broker E2E roundtrip — verify the delegate broker ROUNDTRIP:
 * worker-side delegate tool → real broker socket → admission → grandchild
 * spawner → fenced result -> DURABLE mailbox -> worker poll loop sees it and
 * returns "completed" (not "timed-out").
 *
 * This is the exact binding the commit 1d4ea24b flagged as the "separate
 * runtime issue" (delegate poll was not seen completing in a real worker
 * tail). It runs the REAL CrewBrokerClient over a REAL unix socket against
 * the REAL CrewBroker with an injected fake grandchild spawner — no LLM, no
 * pi CLI, deterministic.
 *
 * Promoted from the SDD Task 3 brieftest (loadout/nesting/messaging,
 * 2026-08-26) into the integration suite so the roundtrip binding stays
 * pinned against regression.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "../../src/extension/pi-api.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { createDelegateTool, type DelegateToolDefinition } from "../../src/prompt/prompt-runtime.ts";
import { CrewBroker } from "../../src/runtime/broker/crew-broker.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../src/runtime/delegate-spawn.ts";
import { loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";

function tempSocketPath(suffix: string): string {
	const tok = randomBytes(3).toString("hex");
	return path.join(os.tmpdir(), `e2e-dlg-${tok}-${suffix}.sock`);
}

test("E2E roundtrip: delegate tool poll completes over the real broker + mailbox", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-e2e-roundtrip-"));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));

	const spawns: GrandchildSpawnInput[] = [];
	const fakeSpawner = async (input: GrandchildSpawnInput): Promise<GrandchildSpawnResult> => {
		spawns.push(input);
		return { ok: true, resultText: "grandchild result via real mailbox", usageTokens: 42 };
	};
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "e2e-roundtrip" },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const parent = loaded.tasks.find((t) => t.role === "executor") ?? loaded.tasks[0];
	const now = new Date().toISOString();
	saveRunTasks(
		loaded.manifest,
		loaded.tasks.map((t) =>
			t.id === parent.id
				? { ...t, status: "running" as const, startedAt: now, depth: 1, allocation: { tokensGranted: 1000, tokensSpent: 0 } }
				: t,
		),
	);

	const socketPath = tempSocketPath("e2e");
	const broker = new CrewBroker({
		sessionId: "session-e2e-roundtrip",
		socketPath,
		enabled: true,
		cwd,
		nestingEnabled: true,
		nestingTrustedEscalation: true,
		grandchildSpawner: fakeSpawner,
		modelCatalog: () => ["angie/opm-5-structure", "zai/glm-5.3"],
	});
	await broker.start();
	try {
		const token = broker.issueRunToken(runId, parent.id);
		const tool = createDelegateTool({
			env: {
				PI_CREW_DELEGATE_ENABLED: "1",
				PI_CREW_TASK_ID: parent.id,
				PI_CREW_BROKER_RUN_ID: runId,
				PI_CREW_STATE_ROOT: loaded.manifest.stateRoot,
				PI_CREW_BROKER_SOCKET: socketPath,
				PI_CREW_BROKER_TOKEN: token,
			} as NodeJS.ProcessEnv,
			// Poll as fast as possible — this E2E is about the roundtrip binding,
			// not the 500ms steering cadence.
			sleep: async () => {
				await new Promise((r) => setTimeout(r, 5));
			},
		}) as DelegateToolDefinition;
		const res = await tool.execute(
			"tc-1",
			{ prompt: "summarize the nested output", role: "explorer" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		assert.equal(res.details.status, "completed", `roundtrip must complete: ${JSON.stringify(res)}`);
		assert.match(res.details.grandchildTaskRef ?? "", /^gc-/);
		const text = (res.content[0] as { text: string }).text;
		assert.match(text, /<delegate-result>/);
		assert.match(text, /grandchild result via real mailbox/);
		assert.equal(spawns.length, 1);
		// The grandchild's shadow task on the run record flipped terminal.
		const fresh = loadRunManifestById(cwd, runId)!;
		const shadow = fresh.tasks.find((t) => t.id === res.details.grandchildTaskRef);
		assert.ok(shadow, "grandchild shadow task must exist on the run record");
		assert.equal(shadow!.status, "completed");
	} finally {
		await broker.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("E2E roundtrip negated: poll with NO grandchild delivery times out (binding proof)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-e2e-roundtrip-nt-"));
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "e2e-roundtrip-nt" },
		{ cwd },
	);
	const runId = run.details.runId!;
	const loaded = loadRunManifestById(cwd, runId)!;
	const parent = loaded.tasks[0];
	const now = new Date().toISOString();
	saveRunTasks(
		loaded.manifest,
		loaded.tasks.map((t) =>
			t.id === parent.id
				? { ...t, status: "running" as const, startedAt: now, depth: 1, allocation: { tokensGranted: 1000, tokensSpent: 0 } }
				: t,
		),
	);
	const socketPath = tempSocketPath("e2e-nt");
	const broker = new CrewBroker({
		sessionId: "session-e2e-roundtrip-nt",
		socketPath,
		enabled: true,
		cwd,
		nestingEnabled: true,
		nestingTrustedEscalation: true,
		// spawner never resolves — the poll should hit its deadline.
		grandchildSpawner: () => new Promise<GrandchildSpawnResult>(() => undefined),
		modelCatalog: () => ["angie/opm-5-structure", "zai/glm-5.3"],
	});
	await broker.start();
	try {
		const token = broker.issueRunToken(runId, parent.id);
		const tool = createDelegateTool({
			env: {
				PI_CREW_DELEGATE_ENABLED: "1",
				PI_CREW_TASK_ID: parent.id,
				PI_CREW_BROKER_RUN_ID: runId,
				PI_CREW_STATE_ROOT: loaded.manifest.stateRoot,
				PI_CREW_BROKER_SOCKET: socketPath,
				PI_CREW_BROKER_TOKEN: token,
			} as NodeJS.ProcessEnv,
			sleep: async () => {
				await new Promise((r) => setTimeout(r, 5));
			},
		}) as DelegateToolDefinition;
		const before = Date.now();
		const res = await tool.execute(
			"tc-1",
			{ prompt: "forever", role: "explorer", timeoutSec: 1 },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const waited = Date.now() - before;
		assert.equal(res.details.status, "timed-out");
		assert.ok(waited >= 900, `poll had to actually wait: ${waited}ms`);
	} finally {
		await broker.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
