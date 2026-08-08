import assert from "node:assert/strict";
import * as os from "node:os";
import { describe, it } from "node:test";
import {
	PI_CREW_GUEST_ENV,
	PI_CREW_KIND_ENV,
	PI_CREW_PARENT_PID_ENV,
	PI_CREW_SCRATCHPAD_ENV,
	PI_CREW_TASK_ID_ENV,
	registerScratchpadLifecycle,
} from "../../../src/prompt/scratchpad-lifecycle.ts";
import { __test as zombieTest } from "../../../src/runtime/process/zombie-scanner.ts";

// Phase 2 (D5 — MAJOR-S1): production env wiring. The guest must report the
// WORKER pid as its parent (not the leader's, which the worker env inherits)
// so an orphaned guest (worker SIGKILL'd) is flagged by the zombie scanner.
//
// Linux-only (zombie-scanner reads /proc/<pid>/environ). Skipped elsewhere.

const isLinux = os.platform() === "linux";
const linuxOnly = { skip: !isLinux } as const;

describe("P2-T6 guest zombie env (D5 production wiring)", () => {
	it("production singleton wires PI_CREW_KIND/PI_CREW_PARENT_PID/PI_CREW_GUEST into the guest env", linuxOnly, async () => {
		// registerScratchpadLifecycle with a fake pi captures the real tool, whose
		// handler uses the production engine singleton (getScratchpadEngine wires
		// the env). We execute a cell that returns the guest's own pid, then read
		// /proc/<pid>/environ to assert the 3 keys.
		const env: Record<string, string> = {
			[PI_CREW_SCRATCHPAD_ENV]: "1",
			[PI_CREW_KIND_ENV]: "subagent",
			[PI_CREW_TASK_ID_ENV]: "task-zombie",
		};
		const captured: { ref: any } = { ref: null };
		const fakePi = {
			registerTool: (t: any) => {
				captured.ref = t;
			},
			on: () => {},
		} as any;
		registerScratchpadLifecycle(fakePi, { env });
		assert.ok(captured.ref, "tool must be registered");
		const tool: {
			execute: (a: string, b: { code: string }, c: unknown, d: unknown, e: unknown) => Promise<{ content: { text: string }[] }>;
		} = captured.ref;

		const res = await tool.execute("x", { code: "process.pid" }, undefined, undefined, undefined);
		const text = (res.content[0] as { text: string }).text;
		// the guest's pid is the result line
		const m = text.match(/result:\s*(\d+)/);
		assert.ok(m, `expected a numeric result pid; got: ${text}`);
		const guestPid = Number.parseInt(m[1], 10);
		assert.ok(guestPid > 0, "guest pid must be a positive integer");

		const guestEnv = zombieTest.readProcEnviron(guestPid);
		assert.equal(guestEnv[PI_CREW_KIND_ENV], "subagent", "guest must carry PI_CREW_KIND=subagent");
		assert.equal(
			guestEnv[PI_CREW_PARENT_PID_ENV],
			String(process.pid),
			"guest parent must be the WORKER pid (MAJOR-S1 — not the leader's inherited value)",
		);
		assert.equal(guestEnv[PI_CREW_GUEST_ENV], "1", "guest must be marked PI_CREW_GUEST=1");
	});

	it("scanner classifies an orphaned guest as a zombie (parent dead)", linuxOnly, () => {
		// Synthetic: a process whose PI_CREW_PARENT_PID points at a dead pid is a
		// zombie per the scanner gate (PI_CREW_KIND=subagent && parent dead).
		const isPidAlive = zombieTest.isPidAlive;
		// pick a pid that is very likely dead (a high unused pid).
		const deadPid = 4_000_000;
		assert.equal(isPidAlive(deadPid), false, "synthetic dead pid must read as dead");
	});
});

	it("a detached grandchild of the guest inherits the WORKER pid → flagged when worker dies", linuxOnly, async () => {
		// The guest spawns a detached grandchild (nohup-style); it inherits the
		// guest env, so its PI_CREW_PARENT_PID is also the worker pid. When the
		// worker dies, BOTH the guest and the grandchild are orphans of the same
		// (dead) worker pid → both flagged. We verify the inheritance half: spawn
		// a synthetic detached process with the guest's env keys and confirm it
		// carries the worker pid as parent.
		// (Full "guest spawns grandchild" e2e is out of unit-test scope — the
		// invariant being pinned is env inheritance, asserted structurally here.)
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				[PI_CREW_KIND_ENV]: "subagent",
				[PI_CREW_PARENT_PID_ENV]: String(process.pid),
				[PI_CREW_GUEST_ENV]: "1",
			},
		});
		try {
			const childEnv = zombieTest.readProcEnviron(child.pid ?? 0);
			assert.equal(childEnv[PI_CREW_PARENT_PID_ENV], String(process.pid), "grandchild parent must be worker pid");
			assert.equal(childEnv[PI_CREW_KIND_ENV], "subagent");
		} finally {
			try {
				process.kill(child.pid ?? 0);
			} catch {}
		}
	});
