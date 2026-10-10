import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { clearLiveAgentsForTest } from "../../src/runtime/live-session/live-agent-manager.ts";
import { type LiveSessionRunResult, runLiveSessionTask } from "../../src/runtime/live-session/live-session-runtime.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

/**
 * U3 — key-free, network-free E2E for the in-process live-session worker.
 *
 * These tests drive the REAL `runLiveSessionTask` path (no
 * `PI_CREW_MOCK_LIVE_SESSION`, no `PI_TEAMS_MOCK_CHILD_PI`): a genuine pi SDK
 * AgentSession is created, but its model runtime is overridden with the faux
 * provider from `@earendil-works/pi-ai/providers/faux` through the
 * `modelProviderOverride` test seam in `live-session-runtime.ts`. Responses are
 * scripted per scenario (ok / tool-use / error / retry) via
 * `faux.setResponses`. The faux provider resolves its own auth
 * (`resolve: async () => ({ auth: {} })`), so no API keys are needed and the
 * faux stream function never touches the network.
 *
 * Hermeticity: `PI_CODING_AGENT_DIR` points at an empty temp directory so the
 * resource loader cannot pick up the host user's extensions/skills/auth.
 */

type FauxHandle = ReturnType<typeof fauxProvider>;
type FauxResponses = Parameters<FauxHandle["setResponses"]>[0];

const team: TeamConfig = {
	name: "faux-e2e",
	description: "faux e2e",
	source: "builtin",
	filePath: "faux-e2e.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "faux-e2e",
	description: "faux e2e",
	source: "builtin",
	filePath: "faux-e2e.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "do" }],
};

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

interface FauxScenario {
	cwd: string;
	agentDir: string;
	faux: FauxHandle;
	events: Array<Record<string, unknown>>;
	run: () => Promise<LiveSessionRunResult>;
}

function setupFauxScenario(responses: FauxResponses, options?: { yieldEnabled?: boolean }): FauxScenario {
	const cwd = createTrackedTempDir("pi-crew-faux-e2e-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const agentDir = path.join(cwd, "faux-agent-home");
	fs.mkdirSync(agentDir, { recursive: true });
	const faux = fauxProvider({ models: [{ id: "crew-e2e-faux", name: "Crew E2E Faux" }] });
	faux.setResponses(responses);
	const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "faux e2e" });
	const task = { ...tasks[0]!, startedAt: new Date().toISOString() };
	const events: Array<Record<string, unknown>> = [];
	const run = () =>
		runLiveSessionTask({
			manifest,
			task,
			step: { id: "execute", role: "executor", task: "faux e2e task" },
			agent: {
				name: "executor",
				description: "Executor",
				source: "builtin",
				filePath: "executor.md",
				systemPrompt: "Do it",
			},
			prompt: "Run the faux task",
			workspaceId: cwd,
			parentModel: faux.models[0],
			modelProviderOverride: faux.provider,
			runtimeConfig: { yield: { enabled: options?.yieldEnabled ?? false } },
			isCurrent: () => true,
			transcriptPath: path.join(cwd, "faux-transcript.jsonl"),
			onEvent: (event) => {
				events.push(event as Record<string, unknown>);
			},
		});
	return { cwd, agentDir, faux, events, run };
}

/** Activate the seam's hermetic environment (empty agent home, real session path). */
function activateRealSessionEnv(agentDir: string): void {
	// Guard against a leaked mock flag from other suites in the same process:
	// these tests must exercise the REAL live-session path.
	delete process.env.PI_CREW_MOCK_LIVE_SESSION;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

test.afterEach(() => clearLiveAgentsForTest());

test("faux E2E ok: real in-process worker completes a scripted text turn key-free", async () => {
	const scenario = setupFauxScenario([fauxAssistantMessage([fauxText("FAUX-E2E-OK: task complete")])], {
		yieldEnabled: false,
	});
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run();
		assert.equal(result.available, true);
		assert.equal(result.exitCode, 0);
		assert.ok(result.stdout.includes("FAUX-E2E-OK"), `stdout was: ${result.stdout}`);
		assert.ok(result.jsonEvents > 0, "expected streaming events from the real session");
		assert.equal(result.error, undefined);
		assert.equal(scenario.faux.state.callCount, 1, "exactly one scripted provider call");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("faux E2E tool-use: scripted submit_result tool call yields a structured result", async () => {
	const scenario = setupFauxScenario(
		[
			fauxAssistantMessage([
				fauxToolCall("submit_result", {
					summary: "faux tool yield",
					structuredData: { verdict: "ok" },
				}),
			]),
			fauxAssistantMessage([fauxText("FAUX-E2E-TOOL-USE complete")]),
		],
		{ yieldEnabled: true },
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run();
		assert.equal(result.available, true);
		assert.equal(result.exitCode, 0);
		assert.ok(result.yieldResult, "expected yieldResult from the submit_result tool call");
		assert.equal(result.yieldResult?.summary, "faux tool yield");
		assert.ok(result.stdout.includes("FAUX-E2E-TOOL-USE"), `stdout was: ${result.stdout}`);
		// Turn 1: tool call. Turn 2: closing text after the tool result.
		assert.equal(scenario.faux.state.callCount, 2);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("faux E2E error: assistant stopReason error flows through the real session pipeline", async () => {
	const scenario = setupFauxScenario(
		[
			fauxAssistantMessage([fauxText("FAUX-E2E-ERROR body")], {
				stopReason: "error",
				errorMessage: "FAUX-E2E simulated provider failure",
			}),
		],
		{ yieldEnabled: false },
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run();
		// pi's agent loop emits turn_end + agent_end for stopReason "error" and
		// prompt() still resolves — document that real behavior here.
		assert.equal(result.available, true);
		assert.equal(result.exitCode, 0);
		const errorMessages = scenario.events.filter((event) => {
			if (event?.type !== "message_end") return false;
			const message = event.message as { stopReason?: string; errorMessage?: string } | undefined;
			return message?.stopReason === "error";
		});
		assert.ok(errorMessages.length >= 1, "expected at least one error assistant message event");
		const first = errorMessages[0]?.message as { errorMessage?: string } | undefined;
		assert.ok(first?.errorMessage?.includes("FAUX-E2E") ?? false, `errorMessage was: ${first?.errorMessage ?? "<none>"}`);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		removeTrackedTempDir(scenario.cwd);
	}
});

test("faux E2E retry: yield reminder loop retries and the second scripted response yields", async () => {
	const scenario = setupFauxScenario(
		[
			fauxAssistantMessage([fauxText("FAUX-E2E-RETRY first pass, nothing submitted yet")]),
			fauxAssistantMessage([fauxToolCall("submit_result", { summary: "yielded after reminder" })]),
			// Turn after the tool result: the agent loop streams once more to
			// close the turn — script its closing text explicitly.
			fauxAssistantMessage([fauxText("FAUX-E2E-RETRY wrapped up")]),
		],
		{ yieldEnabled: true },
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	try {
		activateRealSessionEnv(scenario.agentDir);
		const result = await scenario.run();
		assert.equal(result.available, true);
		assert.equal(result.exitCode, 0);
		assert.ok(result.yieldResult, "expected yieldResult captured on the retry prompt");
		assert.equal(result.yieldResult?.summary, "yielded after reminder");
		assert.ok(result.stdout.includes("FAUX-E2E-RETRY"), `stdout was: ${result.stdout}`);
		assert.equal(scenario.faux.state.callCount, 3, "initial prompt + reminder prompt + closing turn");
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		removeTrackedTempDir(scenario.cwd);
	}
});
