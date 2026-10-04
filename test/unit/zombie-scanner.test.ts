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
import {
	__test,
	type ForeignPiProcess,
	formatZombieReport,
	scanZombieSubagents,
	type ZombieSubagent,
} from "../../src/runtime/process/zombie-scanner.ts";

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
	const text = formatZombieReport({ zombies: [], live: [], foreign: [], errors: [] });
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
	const text = formatZombieReport({ zombies: [zombie], live: [], foreign: [], errors: [] });
	assert.match(text, /tmux:%12/, "report must show provider + pane id for surface zombies");
});

// ── R3-16: foreign pi processes (AI_AGENT=pi / PI_CODING_AGENT=true) ─────────
// The CLI sets both markers POST-exec, so they appear in a process's own frozen
// /proc/<pid>/environ ONLY when that process was spawned BY another pi process.
// Discriminators (see zombie-scanner.ts header): PI_CREW_KIND gate first, then
// exact-value marker match, pi-looking argv (inheritors like bash/uv/MCP
// servers must NOT match), self/ancestor exclusion, orphaned + headless flags.

/** Bounded poll until /proc/<pid>/environ reflects the post-exec env. */
async function waitForMarker(pid: number | undefined, pred: (env: Record<string, string>) => boolean, timeoutMs = 5000): Promise<void> {
	if (pid === undefined) return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred(__test.readProcEnviron(pid))) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** The R3-16 foreign tests must NOT inherit the crew-worker env this test
 *  process may itself run under (PI_CREW_KIND=subagent from a pi-crew worker
 *  shell would route the spawned child into the CREW branch, not foreign —
 *  see knowledge.md 2026-08-15 test-env gotcha). */
function envWithoutCrewKind(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PI_CREW_KIND;
	delete env.PI_CREW_PARENT_PID;
	return env;
}

test("scanZombieSubagents: marker+pi-argv foreign process lands in foreign (REPORT ONLY), not zombies/live", {
	skip: process.platform !== "linux",
}, async () => {
	// argv0 "pi" fakes the CLI binary's argv[0]; markers make it pi-descended.
	// No PI_CREW_KIND → not a crew child → the R3-16 foreign branch owns it.
	const child = spawn("sleep", ["30"], {
		argv0: "pi",
		env: { ...envWithoutCrewKind(), AI_AGENT: "pi", PI_CODING_AGENT: "true" },
		stdio: "ignore",
	});
	try {
		await waitForMarker(child.pid, (env) => env.AI_AGENT === "pi");
		const scan = scanZombieSubagents();
		const foreign = scan.foreign.find((f) => f.pid === child.pid);
		assert.ok(foreign, "marker+pi-argv process must appear in scan.foreign");
		assert.equal(
			scan.zombies.some((z) => z.pid === child.pid),
			false,
			"foreign entries never leak into zombies",
		);
		assert.equal(
			scan.live.some((z) => z.pid === child.pid),
			false,
			"foreign entries never leak into live",
		);
		// Spawned by this test process → parent alive → not orphaned.
		assert.equal(foreign.orphaned, false, "live parent → orphaned=false");
		// argv has no --mode json/-p → headless=false.
		assert.equal(foreign.headless, false, "no headless flags in argv → headless=false");
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents: marker INHERITOR without pi argv (bash) is never foreign-listed", {
	skip: process.platform !== "linux",
}, async () => {
	// Every process pi spawns (shells, MCP servers, xclip…) inherits the markers.
	// The argv gate must keep them out — otherwise the user's own tool processes
	// flood the report.
	const child = spawn("sleep", ["30"], {
		env: { ...envWithoutCrewKind(), AI_AGENT: "pi", PI_CODING_AGENT: "true" },
		stdio: "ignore",
	});
	try {
		await waitForMarker(child.pid, (env) => env.AI_AGENT === "pi");
		const scan = scanZombieSubagents();
		assert.equal(
			scan.foreign.some((f) => f.pid === child.pid),
			false,
			"argv[0]=sleep must NOT be listed as foreign pi",
		);
	} finally {
		child.kill();
	}
});

test("scanZombieSubagents: crew workers are never duplicated into foreign", {
	skip: process.platform !== "linux",
}, async () => {
	// A real crew worker carries PI_CREW_KIND AND (after the env scrub) no
	// markers; even a LEGACY worker that somehow kept markers must classify via
	// the authoritative PI_CREW_KIND gate — never in both buckets.
	const deadParentPid = spawnSync("true").pid ?? 1;
	const child = spawn("sleep", ["30"], {
		argv0: "pi",
		env: {
			...process.env,
			PI_CREW_KIND: "subagent",
			PI_CREW_PARENT_PID: String(deadParentPid),
			AI_AGENT: "pi",
			PI_CODING_AGENT: "true",
		},
		stdio: "ignore",
	});
	try {
		await waitForMarker(child.pid, (env) => env.PI_CREW_KIND === "subagent");
		const scan = scanZombieSubagents();
		const inCrew = [...scan.zombies, ...scan.live].some((z) => z.pid === child.pid);
		assert.ok(inCrew, "PI_CREW_KIND carrier must classify via the crew path");
		assert.equal(
			scan.foreign.some((f) => f.pid === child.pid),
			false,
			"crew worker must never also appear in foreign",
		);
	} finally {
		child.kill();
	}
});

test("collectAncestorPids: covers the scanner's parent chain, never self", {
	skip: process.platform !== "linux",
}, () => {
	const ancestors = __test.collectAncestorPids();
	assert.equal(ancestors.has(process.pid), false, "self is never an ancestor");
	assert.ok(ancestors.size > 0, "a test process always has a living parent chain");
});

test("looksLikePiBinary + isHeadlessArgv: classification unit checks", () => {
	assert.equal(__test.looksLikePiBinary(["pi"]), true);
	assert.equal(__test.looksLikePiBinary(["/home/bom/.nvm/versions/node/v22.23.1/bin/pi"]), true);
	assert.equal(__test.looksLikePiBinary(["node", "/x/y/pi-coding-agent/dist/index.js"]), true);
	assert.equal(__test.looksLikePiBinary(["/bin/bash", "-c", "pi"]), false, "bash running pi text is not a pi binary");
	assert.equal(__test.looksLikePiBinary(["/home/bom/.local/bin/uv", "tool", "uvx"]), false);
	assert.equal(__test.looksLikePiBinary(["sleep", "30"]), false);
	assert.equal(__test.isHeadlessArgv(["--mode", "json", "-p"]), true);
	assert.equal(__test.isHeadlessArgv(["--mode=json"]), true);
	assert.equal(__test.isHeadlessArgv(["pi"]), false, "bare interactive argv is not headless");
});

test("formatZombieReport: foreign section is WARN + REPORT ONLY with the no-discriminator caveat", () => {
	const foreign: ForeignPiProcess = {
		pid: 2829041,
		ppid: 1,
		orphaned: true,
		headless: true,
		rssKb: 3 * 1024 * 1024,
		elapsedSec: 90000,
		cmd: "pi --mode json -p",
	};
	const text = formatZombieReport({ zombies: [], live: [], foreign: [foreign], errors: [] });
	assert.match(text, /WARN/, "foreign section must be marked WARN");
	assert.match(text, /REPORT ONLY/, "foreign section must state REPORT ONLY");
	assert.match(text, /No reliable discriminator/i, "caveat must state no reliable discriminator exists");
	assert.match(text, /orphaned headless/, "triage flags (orphaned + headless) must render");
	assert.match(text, /never kills/i, "read-only guarantee must stay");
});
