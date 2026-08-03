/**
 * Unit tests for ZERO-COVERAGE `team action:"api"` operation WIRING branches
 * in handleApi() (src/extension/team-tool/api.ts).
 *
 * The underlying helper functions (buildCapabilityInventory, resolveCrewRuntime,
 * probeLiveSessionRuntime, live-agent-manager, etc.) had their own unit tests,
 * but the handleApi() dispatch branch — config.operation → result — was never
 * exercised. This file drives the API WIRING end-to-end through handleApi().
 *
 * Operations covered (8):
 *  - inventory            (buildCapabilityInventory wiring — no runId required)
 *  - runtime-capabilities (resolveCrewRuntime wiring)
 *  - probe-live-session   (probeLiveSessionRuntime wiring)
 *  - diff                 (diff artifact read wiring)
 *  - follow-up-agent      (live-agent control wiring: live + queued)
 *  - stop-agent           (live-agent control wiring: live + queued)
 *  - resume-agent         (live-agent control wiring: live + queued)
 *  - interrupt-agent      (live-agent control wiring: falls through to stop)
 *
 * For EACH operation we assert:
 *  - happy-path: valid params → status "ok" + expected payload shape
 *  - error-path: missing required field → isError + paramRequired example
 *  - live-agent ops: both the live-registered path AND the queued-control path
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { handleApi } from "../../src/extension/team-tool/api.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { readLiveAgentControlRequests } from "../../src/runtime/live-session/live-agent-control.ts";
import { clearLiveAgentsForTest, registerLiveAgent } from "../../src/runtime/live-session/live-agent-manager.ts";
import type { TeamToolParamsValue } from "../../src/schema/team-tool-schema.ts";
import { createRunManifest, saveRunManifestAsync, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

function makeCtx(cwd: string): TeamContext {
	return { cwd };
}

function makeParams(overrides: Partial<TeamToolParamsValue> = {}): TeamToolParamsValue {
	return { ...overrides };
}

const team: TeamConfig = {
	name: "api-ops-test",
	description: "",
	source: "builtin",
	filePath: "api-ops-test.team.md",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf",
	description: "",
	source: "builtin",
	filePath: "api-ops-test.workflow.md",
	steps: [{ id: "one", role: "worker", task: "Do work" }],
};

/** Seed a minimal run with one task. Returns manifest + runId + taskId. */
function seedRun(cwd: string): { manifest: TeamRunManifest; runId: string; taskId: string } {
	const created = createRunManifest({ cwd, team, workflow, goal: "api ops coverage" });
	const taskId = "task-1";
	saveRunTasks(created.manifest, [
		{
			id: taskId,
			runId: created.manifest.runId,
			role: "worker",
			agent: "worker",
			title: "task",
			status: "running",
			dependsOn: [],
			cwd,
		},
	]);
	return { manifest: created.manifest, runId: created.manifest.runId, taskId };
}

/** Register a live agent belonging to the run (for live-path tests). */
function registerRunLiveAgent(runId: string, taskId: string, cwd: string, session: Record<string, unknown>): string {
	const agentId = `${runId}:${taskId}`;
	registerLiveAgent({
		agentId,
		runId,
		taskId,
		status: "running",
		workspaceId: cwd,
		session,
	});
	return agentId;
}

/** Save a crew agent record so the queued-control path can find it. */
function saveRunCrewAgent(manifest: TeamRunManifest, taskId: string): string {
	const agentId = `${manifest.runId}:${taskId}`;
	saveCrewAgents(manifest, [
		{
			id: agentId,
			runId: manifest.runId,
			taskId,
			agent: "worker",
			role: "worker",
			runtime: "child-process",
			status: "running",
			startedAt: new Date().toISOString(),
		},
	]);
	return agentId;
}

function parseJson(text: string): Record<string, unknown> {
	return JSON.parse(text) as Record<string, unknown>;
}

// ─── inventory ──────────────────────────────────────────────────────────────

describe("api inventory operation wiring", () => {
	it("returns capability inventory WITHOUT a runId (branch is before runId guard)", async () => {
		const tmp = createTrackedTempDir("api-inventory-");
		try {
			// No runId — inventory branch runs before the runId-required guard.
			const res = await handleApi(makeParams({ config: { operation: "inventory" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const text = textFromToolResult(res);
			const inventory = JSON.parse(text) as unknown[];
			assert.ok(Array.isArray(inventory), "inventory payload is an array");
			// Builtin teams/workflows are always discoverable, so the array is non-empty.
			assert.ok(inventory.length > 0, "at least one capability is returned");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── runtime-capabilities ───────────────────────────────────────────────────

describe("api runtime-capabilities operation wiring", () => {
	it("happy-path: returns resolved runtime capabilities object", async () => {
		const tmp = createTrackedTempDir("api-runtime-caps-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "runtime-capabilities" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const caps = parseJson(textFromToolResult(res));
			// CrewRuntimeCapabilities shape
			assert.ok("kind" in caps, "payload has 'kind'");
			assert.ok("requestedMode" in caps, "payload has 'requestedMode'");
			assert.ok("available" in caps, "payload has 'available'");
			assert.ok("safety" in caps, "payload has 'safety'");
			assert.strictEqual(res.details.runId, runId);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing runId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-runtime-caps-err-");
		try {
			const res = await handleApi(makeParams({ config: { operation: "runtime-capabilities" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /requires runId/i);
			assert.match(text, /action:\s*['"]api['"]/);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── probe-live-session ─────────────────────────────────────────────────────

describe("api probe-live-session operation wiring", () => {
	it("happy-path: returns probe result with 'available' field", async () => {
		const tmp = createTrackedTempDir("api-probe-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "probe-live-session" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const probe = parseJson(textFromToolResult(res));
			assert.ok("available" in probe, "probe payload has 'available'");
			assert.strictEqual(res.details.runId, runId);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing runId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-probe-err-");
		try {
			const res = await handleApi(makeParams({ config: { operation: "probe-live-session" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /requires runId/i);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── diff ───────────────────────────────────────────────────────────────────

describe("api diff operation wiring", () => {
	it("happy-path (no artifacts): reports no diff artifacts", async () => {
		const tmp = createTrackedTempDir("api-diff-empty-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "diff" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const text = textFromToolResult(res);
			assert.match(text, /No diff artifacts found/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("happy-path (with artifact): reads diff file content", async () => {
		const tmp = createTrackedTempDir("api-diff-content-");
		try {
			const { manifest, runId } = seedRun(tmp);
			// Write a diff file into artifactsRoot
			const diffContent = "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n+new line\n";
			const diffRelPath = "changes.patch";
			fs.writeFileSync(path.join(manifest.artifactsRoot, diffRelPath), diffContent, "utf-8");
			const diffArtifact: ArtifactDescriptor = {
				kind: "patch",
				path: diffRelPath,
				createdAt: new Date().toISOString(),
				producer: "task-1",
				retention: "run",
			};
			await saveRunManifestAsync({ ...manifest, artifacts: [...manifest.artifacts, diffArtifact] });
			const res = await handleApi(makeParams({ runId, config: { operation: "diff" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const text = textFromToolResult(res);
			assert.match(text, /Diff artifacts for run/);
			assert.match(text, /changes\.patch/);
			assert.ok(text.includes("+new line"), "diff content is included in output");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing runId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-diff-err-");
		try {
			const res = await handleApi(makeParams({ config: { operation: "diff" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /requires runId/i);
			assert.match(text, /runId:\s*['"]team_\.\.\.['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── follow-up-agent ────────────────────────────────────────────────────────

describe("api follow-up-agent operation wiring", () => {
	it("happy-path (live): delivers follow-up + records mailbox message", async () => {
		const tmp = createTrackedTempDir("api-followup-live-");
		try {
			const { manifest, runId, taskId } = seedRun(tmp);
			const prompted: string[] = [];
			const agentId = registerRunLiveAgent(runId, taskId, tmp, {
				prompt: async (msg: string) => {
					prompted.push(msg);
				},
			});
			const res = await handleApi(
				makeParams({ runId, config: { operation: "follow-up-agent", agentId, prompt: "do step X" } }),
				makeCtx(tmp),
			);
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const payload = parseJson(textFromToolResult(res));
			assert.ok("realtime" in payload, "payload has realtime handle");
			assert.ok("mailboxMessage" in payload, "payload has mailboxMessage");
			assert.ok(prompted.length > 0, "live session.prompt was invoked");
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});

	it("happy-path (queued): no live agent → queues control request", async () => {
		const tmp = createTrackedTempDir("api-followup-queued-");
		try {
			const { manifest, runId, taskId } = seedRun(tmp);
			const agentId = saveRunCrewAgent(manifest, taskId);
			const res = await handleApi(
				makeParams({ runId, config: { operation: "follow-up-agent", agentId, prompt: "next step" } }),
				makeCtx(tmp),
			);
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const payload = parseJson(textFromToolResult(res));
			assert.strictEqual(payload.queued, true);
			const request = payload.request as Record<string, unknown>;
			assert.strictEqual(request.operation, "follow-up");
			assert.strictEqual(request.taskId, taskId);
			// Verify the control request was actually persisted on disk.
			const { requests } = readLiveAgentControlRequests(manifest, taskId);
			assert.ok(
				requests.some((r) => r.operation === "follow-up"),
				"control request persisted",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing agentId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-followup-err-agentid-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "follow-up-agent", prompt: "x" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API follow-up-agent requires config\.agentId/);
			assert.match(text, /operation:\s*['"]follow-up-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: live agent registered but prompt missing → paramRequired", async () => {
		const tmp = createTrackedTempDir("api-followup-err-prompt-");
		try {
			const { runId, taskId } = seedRun(tmp);
			const agentId = registerRunLiveAgent(runId, taskId, tmp, { prompt: async () => undefined });
			const res = await handleApi(makeParams({ runId, config: { operation: "follow-up-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API follow-up-agent requires config\.prompt or config\.message/);
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── stop-agent ─────────────────────────────────────────────────────────────

describe("api stop-agent operation wiring", () => {
	it("happy-path (live): stops the live agent", async () => {
		const tmp = createTrackedTempDir("api-stop-live-");
		try {
			const { runId, taskId } = seedRun(tmp);
			let aborted = false;
			const agentId = registerRunLiveAgent(runId, taskId, tmp, {
				abort: async () => {
					aborted = true;
				},
			});
			const res = await handleApi(makeParams({ runId, config: { operation: "stop-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const handle = parseJson(textFromToolResult(res));
			assert.strictEqual(handle.agentId, agentId);
			assert.strictEqual(handle.status, "stopped");
			assert.ok(aborted, "live session.abort was invoked");
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});

	it("happy-path (queued): no live agent → queues control request", async () => {
		const tmp = createTrackedTempDir("api-stop-queued-");
		try {
			const { manifest, runId, taskId } = seedRun(tmp);
			const agentId = saveRunCrewAgent(manifest, taskId);
			const res = await handleApi(makeParams({ runId, config: { operation: "stop-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const payload = parseJson(textFromToolResult(res));
			assert.strictEqual(payload.queued, true);
			const request = payload.request as Record<string, unknown>;
			assert.strictEqual(request.operation, "stop");
			const { requests } = readLiveAgentControlRequests(manifest, taskId);
			assert.ok(
				requests.some((r) => r.operation === "stop"),
				"stop control request persisted",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing agentId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-stop-err-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "stop-agent" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API stop-agent requires config\.agentId/);
			assert.match(text, /operation:\s*['"]stop-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── resume-agent ───────────────────────────────────────────────────────────

describe("api resume-agent operation wiring", () => {
	it("happy-path (live): resumes the live agent with prompt", async () => {
		const tmp = createTrackedTempDir("api-resume-live-");
		try {
			const { runId, taskId } = seedRun(tmp);
			const prompted: string[] = [];
			const agentId = registerRunLiveAgent(runId, taskId, tmp, {
				prompt: async (msg: string) => {
					prompted.push(msg);
				},
			});
			const res = await handleApi(
				makeParams({ runId, config: { operation: "resume-agent", agentId, prompt: "resume work" } }),
				makeCtx(tmp),
			);
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const handle = parseJson(textFromToolResult(res));
			assert.strictEqual(handle.agentId, agentId);
			assert.strictEqual(handle.status, "completed");
			assert.ok(prompted.length > 0, "live session.prompt was invoked");
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});

	it("happy-path (queued): no live agent → queues control request", async () => {
		const tmp = createTrackedTempDir("api-resume-queued-");
		try {
			const { manifest, runId, taskId } = seedRun(tmp);
			const agentId = saveRunCrewAgent(manifest, taskId);
			const res = await handleApi(
				makeParams({ runId, config: { operation: "resume-agent", agentId, prompt: "resume" } }),
				makeCtx(tmp),
			);
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const payload = parseJson(textFromToolResult(res));
			assert.strictEqual(payload.queued, true);
			const request = payload.request as Record<string, unknown>;
			assert.strictEqual(request.operation, "resume");
			const { requests } = readLiveAgentControlRequests(manifest, taskId);
			assert.ok(
				requests.some((r) => r.operation === "resume"),
				"resume control request persisted",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing agentId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-resume-err-agentid-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "resume-agent", prompt: "x" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API resume-agent requires config\.agentId/);
			assert.match(text, /operation:\s*['"]resume-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: live agent registered but prompt missing → paramRequired", async () => {
		const tmp = createTrackedTempDir("api-resume-err-prompt-");
		try {
			const { runId, taskId } = seedRun(tmp);
			const agentId = registerRunLiveAgent(runId, taskId, tmp, { prompt: async () => undefined });
			const res = await handleApi(makeParams({ runId, config: { operation: "resume-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API resume-agent requires config\.prompt or config\.message/);
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});
});

// ─── interrupt-agent ────────────────────────────────────────────────────────
// interrupt-agent shares the live-agent-control branch but has no explicit
// case — it falls through to stopLiveAgent (live) / operation "stop" (queued).

describe("api interrupt-agent operation wiring", () => {
	it("happy-path (live): interrupts (stops) the live agent", async () => {
		const tmp = createTrackedTempDir("api-interrupt-live-");
		try {
			const { runId, taskId } = seedRun(tmp);
			let aborted = false;
			const agentId = registerRunLiveAgent(runId, taskId, tmp, {
				abort: async () => {
					aborted = true;
				},
			});
			const res = await handleApi(makeParams({ runId, config: { operation: "interrupt-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const handle = parseJson(textFromToolResult(res));
			assert.strictEqual(handle.agentId, agentId);
			assert.strictEqual(handle.status, "stopped");
			assert.ok(aborted, "live session.abort was invoked (interrupt falls through to stop)");
		} finally {
			clearLiveAgentsForTest();
			removeTrackedTempDir(tmp);
		}
	});

	it("happy-path (queued): no live agent → queues stop control request", async () => {
		const tmp = createTrackedTempDir("api-interrupt-queued-");
		try {
			const { manifest, runId, taskId } = seedRun(tmp);
			const agentId = saveRunCrewAgent(manifest, taskId);
			const res = await handleApi(makeParams({ runId, config: { operation: "interrupt-agent", agentId } }), makeCtx(tmp));
			assert.strictEqual(res.isError, false);
			assert.strictEqual(res.details.status, "ok");
			const payload = parseJson(textFromToolResult(res));
			assert.strictEqual(payload.queued, true);
			const request = payload.request as Record<string, unknown>;
			// interrupt-agent maps to "stop" in the queued control-request path.
			assert.strictEqual(request.operation, "stop");
			const { requests } = readLiveAgentControlRequests(manifest, taskId);
			assert.ok(
				requests.some((r) => r.operation === "stop"),
				"interrupt→stop control request persisted",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("error-path: missing agentId → paramRequired example", async () => {
		const tmp = createTrackedTempDir("api-interrupt-err-");
		try {
			const { runId } = seedRun(tmp);
			const res = await handleApi(makeParams({ runId, config: { operation: "interrupt-agent" } }), makeCtx(tmp));
			assert.strictEqual(res.isError, true);
			const text = textFromToolResult(res);
			assert.match(text, /API interrupt-agent requires config\.agentId/);
			assert.match(text, /operation:\s*['"]interrupt-agent['"]/);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
