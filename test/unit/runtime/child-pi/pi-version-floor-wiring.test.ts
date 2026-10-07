// U9 (pi 1.0.4 version floor): end-to-end wiring of the chosen async seam —
// runChildPi awaits the single-flight memoized probePiVersion() (fake exec
// seam injected) ONLY on parity (non-hermetic) spawns, threads the resolved
// version through prepareSpawnContext into buildPiWorkerArgs, and the
// resulting --no-mcp lands on the spawned argv (observed via the surface
// branch's launch script, the established no-real-spawn observation point —
// same pattern as pi-args-trust-pin.test.ts D1). Hermetic (default) spawns
// must NOT run the probe at all — default-path unit tests stay spawn-free.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import {
	__test_peekPiVersionMemo,
	__test_resetPiVersionMemo,
	type ExecPiVersionFn,
	probePiVersion,
} from "../../../../src/runtime/child-pi/pi-version.ts";
import type {
	SurfaceExitReason,
	SurfaceHandle,
	SurfaceProvider,
	SurfaceSpawnOpts,
} from "../../../../src/runtime/surface/surface-provider.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

/** Counting fake exec seam — records every probe attempt. */
function countingExec(stdout: string): { fn: ExecPiVersionFn; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		fn: async () => {
			calls++;
			return { stdout, stderr: "" };
		},
	};
}

/** Minimal fake surface provider — capture the command booted into the pane (mirrors pi-args-trust-pin.test.ts). */
function captureProvider(): { provider: SurfaceProvider; sent: string[] } {
	const sent: string[] = [];
	const handle: SurfaceHandle = {
		id: "%u9",
		kind: "tmux",
		onExit: (cb: (reason: SurfaceExitReason) => void) => {
			setTimeout(() => cb("pane-closed"), 10);
		},
		dispose: () => {
			/* fake pane needs no teardown */
		},
	};
	const provider: SurfaceProvider = {
		kind: "tmux",
		detect: () => ({ ok: true, kind: "tmux" }),
		async createSurface(_id: string, _opts: SurfaceSpawnOpts) {
			return handle;
		},
		async sendCommand(_h: SurfaceHandle, text: string) {
			sent.push(text);
		},
		async closeSurface() {
			/* fake pane closes itself */
		},
		attach: () => null,
		readScreen: async () => "",
	};
	return { provider, sent };
}

function seedCompletedEvent(workRoot: string): string {
	const eventsPath = join(workRoot, "state", "runs", "run_u9", "events.jsonl");
	mkdirSync(join(eventsPath, ".."), { recursive: true });
	appendFileSync(
		eventsPath,
		`${JSON.stringify({ type: "worker.completed", runId: "run_u9", taskId: "01_u9", data: { result: "done", stopReason: "stop" } })}\n`,
		"utf8",
	);
	return eventsPath;
}

function readPaneScript(sent: string[]): string {
	const sentMatch = /^bash '(.+)'; exit$/.exec(sent[0] ?? "");
	assert.ok(sentMatch, `pane command shape: ${sent[0]}`);
	return readFileSync(sentMatch[1] as string, "utf8");
}

/**
 * Scrub the crew depth vars for the duration of a wiring case: the surface
 * branch's hard gate rejects pre-resolved providers when the HOST depth > 0,
 * and running this file inside a pi-crew worker exports PI_CREW_DEPTH=1
 * (known in-worker test hazard — same class as scratchpad-env-wiring). The
 * test simulates an ORCHESTRATOR (host depth 0); CI/user shells have no depth
 * var, so this is a no-op outside a worker.
 */
function withHostDepthZero<T>(fn: () => Promise<T>): Promise<T> {
	const savedCrew = process.env.PI_CREW_DEPTH;
	const savedTeams = process.env.PI_TEAMS_DEPTH;
	process.env.PI_CREW_DEPTH = "0";
	delete process.env.PI_TEAMS_DEPTH;
	return fn().finally(() => {
		if (savedCrew === undefined) delete process.env.PI_CREW_DEPTH;
		else process.env.PI_CREW_DEPTH = savedCrew;
		if (savedTeams === undefined) delete process.env.PI_TEAMS_DEPTH;
		else process.env.PI_TEAMS_DEPTH = savedTeams;
	});
}

test("U9 wiring: parity spawn probes pi --version once and threads --no-mcp onto the argv", async () => {
	__test_resetPiVersionMemo();
	const exec = countingExec("1.0.4");
	// Prime the single-flight memo with the fake seam BEFORE runChildPi's
	// bare probePiVersion() call — the memo wins, no real child spawns.
	void probePiVersion(exec.fn);
	const workRoot = mkdtempSync(join(tmpdir(), "u9-parity-"));
	const launchDir = mkdtempSync(join(tmpdir(), "u9-launch-"));
	const eventsPath = seedCompletedEvent(workRoot);
	try {
		const { provider, sent } = captureProvider();
		const result = await withHostDepthZero(() =>
			runChildPi({
				cwd: workRoot,
				task: "Say hello then stop.",
				agent: agent({ source: "builtin" }),
				runId: "run_u9",
				agentId: "01_u9",
				eventsPath,
				hermeticWorkers: false, // parity (non-hermetic) spawn → probe + floor gate active
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);
		assert.ok(result.surface, "fixture must take the surface branch");
		const script = readPaneScript(sent);
		assert.ok(script.includes("--no-mcp"), "parity spawn on pi 1.0.4 must carry --no-mcp");
		assert.ok(script.includes("--exclude-tools"), "parity mcp__* cut rides along (cross-version baseline)");
		assert.equal(exec.calls(), 1, "probe exec'd exactly once (the priming call — single-flight)");
		assert.ok(__test_peekPiVersionMemo(), "parity spawn consumed the memoized probe");
	} finally {
		__test_resetPiVersionMemo();
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(launchDir, { recursive: true, force: true });
	}
});

test("U9 wiring: hermetic (default) spawn never probes — argv stays MCP-clean via --no-extensions", async () => {
	__test_resetPiVersionMemo();
	// Memo deliberately LEFT EMPTY: if runChildPi wrongly probed on the
	// hermetic path it would create the memo (and, worse, fall through to the
	// DEFAULT real exec) — the peek assert below catches that without spawning.
	const workRoot = mkdtempSync(join(tmpdir(), "u9-hermetic-"));
	const launchDir = mkdtempSync(join(tmpdir(), "u9-launch-"));
	const eventsPath = seedCompletedEvent(workRoot);
	try {
		const { provider, sent } = captureProvider();
		const result = await withHostDepthZero(() =>
			runChildPi({
				cwd: workRoot,
				task: "Say hello then stop.",
				agent: agent({ source: "builtin" }),
				runId: "run_u9",
				agentId: "01_u9",
				eventsPath,
				// hermeticWorkers unset → default TRUE → probe skipped, no floor flag
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);
		assert.ok(result.surface, "fixture must take the surface branch");
		const script = readPaneScript(sent);
		assert.ok(!script.includes("--no-mcp"), "hermetic spawn must NOT carry --no-mcp");
		assert.ok(!script.includes("--exclude-tools"), "no parity fold on hermetic spawns");
		assert.equal(__test_peekPiVersionMemo(), null, "hermetic spawn must never TOUCH the probe (memo still empty)");
	} finally {
		__test_resetPiVersionMemo();
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(launchDir, { recursive: true, force: true });
	}
});
