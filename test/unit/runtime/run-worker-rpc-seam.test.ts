/**
 * run-worker-rpc-seam.test.ts — W7 (P2-3): the run-worker transport seam.
 *
 * Guarantees under test:
 *   1. PI_CREW_WORKER_TRANSPORT=rpc → runWorker returns the structured
 *      not-implemented result WITHOUT spawning (returns before runChildPi is
 *      ever reached — no child process, no PI_TEAMS_PI_BIN needed) and WITHOUT
 *      taking a worker-cap slot.
 *   2. The same holds for the capped path (cap: true) — the slot is released.
 *
 * The default (env unset → stdio) path is deliberately NOT exercised here: it
 * delegates to the real runChildPi and would spawn a real pi binary. Its
 * unchanged behavior is covered by run-worker-cap.test.ts (real spawn) and by
 * the resolveWorkerTransport failsafe tests in rpc/rpc-worker.test.ts.
 *
 * Worker-shell env gotcha (.crew/knowledge.md 2026-08-15): snapshot/restore
 * every crew-family var this file touches.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { runWorker } from "../../../src/runtime/run-worker.ts";

const ENV_KEYS = ["PI_CREW_WORKER_TRANSPORT"] as const;

const agent: AgentConfig = {
	name: "worker",
	description: "rpc-seam test worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

let envBackup: Map<string, string | undefined>;
test.beforeEach(() => {
	envBackup = new Map();
	for (const key of ENV_KEYS) envBackup.set(key, process.env[key]);
	process.env.PI_CREW_WORKER_TRANSPORT = "rpc";
});
test.afterEach(() => {
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("rpc transport: structured not-implemented result, no spawn", async () => {
	const result = await runWorker({ cwd: process.cwd(), task: "x", agent, cap: false });
	assert.equal(result.exitCode, null);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	assert.match(result.error ?? "", /not implemented/);
	assert.match(result.error ?? "", /PI_CREW_WORKER_TRANSPORT/);
	assert.match(result.error ?? "", /src\/runtime\/rpc/);
	// Prototype honesty: no exitStatus/aborted/steered set on this path.
	assert.equal(result.exitStatus, undefined);
	assert.equal(result.aborted, undefined);
});

test("rpc transport: capped path returns the same structured result (slot released)", async () => {
	const first = await runWorker({ cwd: process.cwd(), task: "x", agent, cap: true });
	assert.match(first.error ?? "", /not implemented/);
	// If the slot had leaked, a second acquire would deadlock the test timeout.
	const second = await runWorker({ cwd: process.cwd(), task: "x", agent, cap: true });
	assert.match(second.error ?? "", /not implemented/);
});
