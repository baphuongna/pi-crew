/**
 * Unit tests for src/runtime/foreground-watchdog.ts (ZERO-COVERAGE module).
 *
 * Public API under test:
 *   - startForegroundWatchdog(opts: WatchdogOptions): void
 *   - stopWatchdog(runId: string): void
 *
 * Strategy: drive the REAL watchdog against manifests + agents persisted on
 * disk in an isolated temp project (mirrors heartbeat-watcher.test.ts). This
 * exercises the real loadRunManifestById → readCrewAgents →
 * isLikelyOrphanedActiveRun path plus the timer/scheduling + pi.sendUserMessage
 * notification wiring. A tiny checkIntervalMs makes checks fire promptly.
 *
 * The Pi callback is stubbed to capture sendUserMessage calls; no LLM/SDK is
 * involved. The watchdog timers are unref()'d and explicitly stopped in
 * finally blocks.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../src/runtime/crew-agent-runtime.ts";
import { startForegroundWatchdog, stopWatchdog } from "../../src/runtime/foreground-watchdog.ts";
import { createRunManifest, saveRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

// Minimal team/workflow fixtures (cast as never — matches heartbeat-watcher.test.ts).
const team = {
	name: "watchdog-team",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "worker", agent: "agent-a" }],
} as never;
const workflow = {
	name: "watchdog-flow",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "do", role: "worker", task: "do the thing" }],
} as never;

interface CapturedMessage {
	text: string;
	options: unknown;
}

interface PiStub {
	messages: CapturedMessage[];
}

/** A pi stub capturing sendUserMessage calls. No extensions → isPiDiffLoaded false. */
function makePi(): PiStub & Record<string, unknown> {
	const messages: CapturedMessage[] = [];
	return {
		messages,
		sendUserMessage: (text: string, options: unknown): void => {
			messages.push({ text, options });
		},
	};
}

/** Resolve predicate true within timeoutMs, polling on the event loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = "waitFor timed out"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new assert.AssertionError({ message });
}

/** Sleep helper for negative assertions (give timers a chance to misbehave). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SetupOptions {
	status: TeamRunManifest["status"];
	/** How far in the past to backdate updatedAt (ms). 0 = now. */
	ageMs: number;
	/** Optional agent records to persist to agents.json. */
	agents?: CrewAgentRecord[];
}

interface PreparedRun {
	cwd: string;
	runId: string;
	manifest: TeamRunManifest;
}

/** Create an isolated temp project + run manifest with the requested state. */
function prepareRun(opts: SetupOptions): PreparedRun {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fg-watchdog-"));
	// Canonicalize to long-name form (mirrors production path resolution).
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

	const created = createRunManifest({ cwd, team, workflow, goal: "watchdog goal" });
	const updatedAt = new Date(Date.now() - opts.ageMs).toISOString();
	const manifest: TeamRunManifest = { ...created.manifest, status: opts.status, updatedAt };
	saveRunManifest(manifest);
	if (opts.agents) {
		saveCrewAgents(manifest, opts.agents);
	}
	return { cwd, runId: manifest.runId, manifest };
}

function queuedAgent(runId: string): CrewAgentRecord {
	return {
		id: `${runId}:do`,
		runId,
		taskId: "do",
		agent: "agent-a",
		role: "worker",
		runtime: "scaffold",
		status: "queued",
		startedAt: new Date().toISOString(),
	};
}

function runningAgent(runId: string): CrewAgentRecord {
	return {
		id: `${runId}:do`,
		runId,
		taskId: "do",
		agent: "agent-a",
		role: "worker",
		runtime: "scaffold",
		status: "running",
		startedAt: new Date().toISOString(),
		progress: { recentTools: [], recentOutput: [], toolCount: 1 },
	};
}

test("startForegroundWatchdog: detects a hung run (stale heartbeat + idle agents) and notifies via followUp", async () => {
	// Create the run first (no agents yet), then persist agents with the real runId.
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 5 * 60_000 });
	saveCrewAgents(manifest, [queuedAgent(runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("appears hung")), 2000);

		const hung = pi.messages.find((m) => m.text.includes("appears hung"));
		assert.ok(hung, "a 'hung' notification was sent");
		assert.ok(hung.text.includes(runId), "notification names the runId");
		assert.ok(hung.text.includes("watchdog"), "message is the watchdog message");
		assert.deepEqual(hung.options, { deliverAs: "followUp" }, "delivered as followUp");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: notifies exactly once on terminal completion then self-stops", async () => {
	const { cwd, runId } = prepareRun({ status: "completed", ageMs: 0 });
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("run completed")), 2000);

		// Give the scheduler several more intervals to (wrongly) re-fire.
		await sleep(60);

		const completions = pi.messages.filter((m) => m.text.includes("run completed"));
		assert.equal(completions.length, 1, "exactly one completion notification (watchdog self-stopped)");
		assert.ok(completions[0].text.includes(runId), "names the runId");
		assert.ok(completions[0].text.includes("watchdog-team/watchdog-flow"), "names team/workflow");
		assert.deepEqual(completions[0].options, { deliverAs: "followUp" });
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: a healthy active run (fresh heartbeat, running agent) is NOT flagged", async () => {
	const { cwd, runId, manifest } = prepareRun({ status: "running", ageMs: 0 });
	saveCrewAgents(manifest, [runningAgent(runId)]);
	const pi = makePi();
	try {
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		// Let several check intervals elapse — a healthy run produces no message.
		await sleep(80);

		assert.equal(pi.messages.length, 0, "no notification sent for a healthy active run");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: does not stack duplicate timers for the same runId", async () => {
	const { cwd, runId } = prepareRun({ status: "completed", ageMs: 0 });
	const pi = makePi();
	try {
		// Start the watchdog twice for the same run — second call must be a no-op.
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });

		await waitFor(() => pi.messages.some((m) => m.text.includes("run completed")), 2000);
		await sleep(60);

		const completions = pi.messages.filter((m) => m.text.includes("run completed"));
		assert.equal(completions.length, 1, "dedup ensures a single timer → single notification");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("startForegroundWatchdog: stops silently when the run manifest is gone (no crash, no message)", async () => {
	const { cwd, runId } = prepareRun({ status: "running", ageMs: 0 });
	const pi = makePi();
	try {
		// Delete the run state dir so loadRunManifestById returns undefined.
		fs.rmSync(path.join(cwd, ".crew", "state", "runs", runId), { recursive: true, force: true });

		startForegroundWatchdog({ pi: pi as never, cwd, runId, checkIntervalMs: 5 });
		await sleep(80);

		assert.equal(pi.messages.length, 0, "missing manifest → no notification and no throw");
	} finally {
		stopWatchdog(runId);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
