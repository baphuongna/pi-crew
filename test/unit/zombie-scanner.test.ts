/**
 * Tests for the pi-crew sub-agent process-identity marker + zombie scanner.
 *
 * Lesson context: an earlier heuristic-based zombie "cleanup" killed a live
 * main `pi` session by accident. The fix is an AUTHORITATIVE marker —
 * `--crew-subagent` (argv) + `PI_CREW_KIND=subagent` (env) — set on every
 * child-pi spawn. The user's main session never carries the marker, so it
 * can never be matched by zombie detection.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../src/runtime/model/pi-args.ts";
import { __test, formatZombieReport, scanZombieSubagents, type ZombieSubagent } from "../../src/runtime/process/zombie-scanner.ts";

function fakeAgent(): AgentConfig {
	return {
		name: "executor",
		description: "test",
		source: "builtin",
		filePath: "<test>",
		systemPrompt: "You are a test agent.",
		tools: [],
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

test("buildPiWorkerArgs: does NOT add an unknown argv flag (pi rejects unknown options)", () => {
	const { args } = buildPiWorkerArgs({
		task: "do thing",
		agent: fakeAgent(),
	});
	// Regression guard: an earlier fix tried to prepend `--crew-subagent`, but pi's
	// strict option parser exits non-zero on unknown flags, breaking every agent call.
	assert.ok(!args.includes("--crew-subagent"), "must not add argv flags pi does not recognize");
	assert.equal(args[0], "--mode", "argv starts with the standard --mode flag");
});

test("buildPiWorkerArgs: sets PI_CREW_KIND=subagent in the child env (authoritative marker)", () => {
	// NOTE: we deliberately do NOT add an argv flag. Pi rejects unknown flags
	// (Error: Unknown option) and exits non-zero, which would break every
	// ctx.agent() call. The ENV var is the sole authoritative signal; the
	// zombie scanner reads it from /proc/<pid>/environ.
	const { env } = buildPiWorkerArgs({ task: "do thing", agent: fakeAgent() });
	assert.equal(env.PI_CREW_KIND, "subagent", "PI_CREW_KIND=subagent is the authoritative machine marker");
});

test("buildPiWorkerArgs: a MAIN session env never has PI_CREW_KIND (sanity check)", () => {
	// This is the inverse guarantee: the marker is ONLY added by buildPiWorkerArgs.
	// The parent process (this test) is a main-session equivalent — it must NOT
	// carry the marker, otherwise doctor --zombies could match it.
	assert.notEqual(process.env.PI_CREW_KIND, "subagent", "main session must not self-identify as subagent");
});

test("scanZombieSubagents: returns a well-formed result object", () => {
	const scan = scanZombieSubagents();
	// Shape contract — never throws, always returns {zombies, live, errors}.
	assert.ok(Array.isArray(scan.zombies));
	assert.ok(Array.isArray(scan.live));
	assert.ok(Array.isArray(scan.errors));
});

test("scanZombieSubagents: never lists a main session (no PI_CREW_KIND marker)", () => {
	// The current process is NOT a pi-crew sub-agent (no PI_CREW_KIND=subagent),
	// so it must NEVER appear in zombies OR live — even though it IS a node/pi
	// process. This is the regression test for the accidental-kill incident.
	const scan = scanZombieSubagents();
	const myPid = process.pid;
	const matched = [...scan.zombies, ...scan.live].filter((z) => z.pid === myPid);
	assert.equal(matched.length, 0, "main session must never be matched as a sub-agent");
});

test("scanZombieSubagents: every matched entry carries PI_CREW_KIND=subagent by construction", () => {
	// Defense in depth: even if some other process slips in, the scanner only
	// emits entries that originated from a process with PI_CREW_KIND=subagent.
	// (We can't easily forge a /proc entry in a unit test, but we can assert
	// the scanner's contract: zombies/live arrays only contain ZombieSubagent
	// objects with numeric pid + crewParentPid fields.)
	const scan = scanZombieSubagents();
	for (const z of [...scan.zombies, ...scan.live]) {
		assert.equal(typeof z.pid, "number");
		assert.equal(typeof z.crewParentPid, "number");
		assert.equal(typeof z.parentAlive, "boolean");
	}
});

test("formatZombieReport: render is human-readable and states read-only safety", () => {
	const scan = scanZombieSubagents();
	const text = formatZombieReport(scan);
	assert.match(text, /read-only/i, "report must clearly state it does not kill");
	assert.match(text, /PI_CREW_KIND=subagent/i, "report must explain the authoritative marker");
	// No zombie or live entry should leak a raw suggestion to kill live parents.
	if (scan.live.length > 0) {
		assert.match(text, /NOT zombies/i, "live entries must be marked do-not-kill");
	}
});

test("formatZombieReport: empty scan renders a clean 'nothing found' message", () => {
	const text = formatZombieReport({ zombies: [], live: [], errors: [] });
	assert.match(text, /No pi-crew sub-agent processes found/i);
});

// ── T12: surface worker fields (PI_CREW_SURFACE / PI_CREW_SURFACE_PANE) ──────
// Surface workers carry their mux identity in env; doctor (T12) reads the pane
// id off the scan result to close orphan panes. The scan MUST NOT rely on a
// heartbeat — surface mode has none (T9 handoff): env markers are the only signal.

/** Bounded poll until /proc/<pid>/environ reflects the post-exec env. */
async function waitForSubagentMarker(pid: number | undefined, timeoutMs = 5000): Promise<void> {
	if (pid === undefined) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (__test.readProcEnviron(pid).PI_CREW_KIND === "subagent") return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

test("scanZombieSubagents: surface worker exposes surface + surfacePaneId from /proc environ", {
	skip: process.platform !== "linux",
}, async () => {
	// A pid that has already exited + been reaped — process.kill(pid, 0) sees ESRCH.
	// PID reuse within the test window is astronomically unlikely.
	const deadParentPid = spawnSync("true").pid ?? 1;
	const child = spawn("sleep", ["30"], {
		env: {
			...process.env,
			PI_CREW_KIND: "subagent",
			PI_CREW_PARENT_PID: String(deadParentPid),
			PI_CREW_SURFACE: "tmux",
			PI_CREW_SURFACE_PANE: "%12",
		},
		stdio: "ignore",
	});
	try {
		await waitForSubagentMarker(child.pid);
		const scan = scanZombieSubagents();
		const entry = [...scan.zombies, ...scan.live].find((z) => z.pid === child.pid);
		assert.ok(entry, "spawned marker process must appear in the scan");
		assert.equal(entry.surface, "tmux", "PI_CREW_SURFACE=tmux must surface as entry.surface");
		assert.equal(entry.surfacePaneId, "%12", "PI_CREW_SURFACE_PANE must surface as entry.surfacePaneId");
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents: headless worker leaves surface fields undefined", { skip: process.platform !== "linux" }, async () => {
	const deadParentPid = spawnSync("true").pid ?? 1;
	const child = spawn("sleep", ["30"], {
		env: {
			...process.env,
			PI_CREW_KIND: "subagent",
			PI_CREW_PARENT_PID: String(deadParentPid),
		},
		stdio: "ignore",
	});
	try {
		await waitForSubagentMarker(child.pid);
		const scan = scanZombieSubagents();
		const entry = [...scan.zombies, ...scan.live].find((z) => z.pid === child.pid);
		assert.ok(entry, "spawned marker process must appear in the scan");
		assert.equal(entry.surface, undefined, "no PI_CREW_SURFACE → surface stays undefined");
		assert.equal(entry.surfacePaneId, undefined, "no PI_CREW_SURFACE_PANE → surfacePaneId stays undefined");
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents: unknown PI_CREW_SURFACE value is ignored (not half-parsed)", {
	skip: process.platform !== "linux",
}, async () => {
	const deadParentPid = spawnSync("true").pid ?? 1;
	const child = spawn("sleep", ["30"], {
		env: {
			...process.env,
			PI_CREW_KIND: "subagent",
			PI_CREW_PARENT_PID: String(deadParentPid),
			PI_CREW_SURFACE: "screen", // not a pi-crew surface kind
			PI_CREW_SURFACE_PANE: "%99",
		},
		stdio: "ignore",
	});
	try {
		await waitForSubagentMarker(child.pid);
		const scan = scanZombieSubagents();
		const entry = [...scan.zombies, ...scan.live].find((z) => z.pid === child.pid);
		assert.ok(entry, "spawned marker process must appear in the scan");
		assert.equal(entry.surface, undefined, "unsupported surface kind must not be reported");
	} finally {
		child.kill();
	}
});

test("formatZombieReport: surface entries render pane id + provider", () => {
	const zombie: ZombieSubagent = {
		pid: 4242,
		ppid: 1,
		crewParentPid: 4242 - 100,
		parentAlive: false,
		role: "executor",
		surface: "tmux",
		surfacePaneId: "%12",
		rssKb: 2048,
		elapsedSec: 600,
		cmd: "pi --mode json -p task",
	};
	const text = formatZombieReport({ zombies: [zombie], live: [], errors: [] });
	assert.match(text, /tmux:%12/, "report must show provider + pane id for surface zombies");
});
