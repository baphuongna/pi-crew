/**
 * surface-runtime.test.ts — worker-side recorder + auto-exit + parent-guard
 * (spec §5.2 D7 + §5.3, task S2-T8).
 *
 * Pure-function table tests (shouldAutoExit / parentAlive), the JSONL recorder
 * contract (`{seq,time,event}` — same line shape the host writes via
 * appendCrewAgentEvent, crew-agent-records.ts:607) and the prompt-runtime
 * wiring through a fake ExtensionAPI object (no real timers, no real fs).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
	AUTO_EXIT_SETTLE_CONFIRM_MS,
	createAgentEventRecorder,
	createWorkerActivityTracker,
	PARENT_GUARD_INTERVAL_MS,
	parentAlive,
	registerSurfaceWorkerLifecycle,
	type SurfaceWorkerDeps,
	shouldAutoExit,
	trackToolActivity,
} from "../../../src/prompt/surface-worker.ts";

// ── helpers ───────────────────────────────────────────────────────────────

/** `/proc/<pid>/stat` fixture: starttime (field 22) = 777. */
const STAT_TICKS_777 = "991 42 (bash) S 1 991 991 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 777 0 0";

/** Build a worker env carrying every gate the lifecycle listens to. */
function workerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PI_CREW_EVENTS_PATH: "/tmp/run-events.jsonl",
		PI_CREW_BROKER_RUN_ID: "run-1",
		PI_CREW_TASK_ID: "task-9",
		PI_CREW_AGENT_EVENTS_PATH: "/tmp/agents/task-9/events.jsonl",
		PI_CREW_SURFACE: "tmux",
		PI_CREW_AUTO_EXIT: "1",
		PI_CREW_PARENT_PID: "",
		...overrides,
	};
}

/** Instantaneous timers — nothing runs on its own; tests tick by hand. */
interface TimerRegistry {
	invokeInterval(id: number): void;
	pendingIntervals(): number;
	intervals(): Array<{ id: number; ms: number }>;
}

function fakeTimers(): {
	timers: TimerRegistry;
	deps: Pick<SurfaceWorkerDeps, "setIntervalFn" | "clearIntervalFn" | "setTimeoutFn" | "clearTimeoutFn">;
} {
	let nextId = 1;
	const intervals = new Map<number, { ms: number; fn: () => void }>();
	const timeouts = new Map<number, () => void>();
	return {
		timers: {
			invokeInterval(id) {
				intervals.get(id)?.fn();
			},
			pendingIntervals() {
				return intervals.size;
			},
			intervals: () => [...intervals.entries()].map(([id, meta]) => ({ id, ms: meta.ms })),
		},
		deps: {
			setIntervalFn(fn, ms) {
				const id = nextId++;
				intervals.set(id, { ms, fn });
				return id;
			},
			clearIntervalFn(id) {
				intervals.delete(Number(id));
			},
			setTimeoutFn(fn) {
				const id = nextId++;
				timeouts.set(id, fn);
				return id;
			},
			clearTimeoutFn(id) {
				timeouts.delete(Number(id));
			},
		},
	};
}

interface Harness extends Record<string, unknown> {
	lines: string[];
	runEvents: Array<{ type: string; data: Record<string, unknown> }>;
	shutdownCalls(): number;
	exitCodes(): number[];
	timers: TimerRegistry;
	handle: NonNullable<ReturnType<typeof registerSurfaceWorkerLifecycle>>;
	fire(event: string, payload?: unknown, hasPending?: boolean): void;
}

/** Fake ExtensionAPI + collected output for one wired worker session. */
function buildHarness(opts: SurfaceWorkerDeps = {}): Harness {
	const registrations: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			registrations.push({ event, handler });
		},
	};
	const lines: string[] = [];
	const runEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
	let shutdownCalls = 0;
	const exitCodes: number[] = [];
	const bundle = fakeTimers();

	const handle = registerSurfaceWorkerLifecycle(pi as never, {
		env: workerEnv(),
		appendLine: (_target, line) => lines.push(line),
		emitRunEvent: (type, data) => runEvents.push({ type, data }),
		readStat: () => undefined,
		exit: ((code: number) => {
			exitCodes.push(code);
			return undefined as never;
		}) as never,
		...bundle.deps,
		...opts,
	});
	assert.ok(handle);

	function fire(event: string, payload: unknown = {}, hasPending = false): void {
		for (const reg of registrations.filter((r) => r.event === event)) {
			reg.handler(payload, { hasPendingMessages: () => hasPending, shutdown: () => void (shutdownCalls += 1) });
		}
	}

	return {
		lines,
		runEvents,
		shutdownCalls: () => shutdownCalls,
		exitCodes: () => exitCodes,
		timers: bundle.timers,
		handle,
		fire,
	};
}

const ASSISTANT_STOP = {
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
		usage: { input: 10, output: 4, cost: { total: 0.01 } },
	},
};

// ── shouldAutoExit ────────────────────────────────────────────────────────

describe("shouldAutoExit", () => {
	it("exits on a naturally finished turn with nothing pending", () => {
		assert.equal(shouldAutoExit({ stopReason: "stop", askPending: false, delegatesRunning: false, steersPending: false }), true);
	});

	it("does NOT exit while an ask is pending", () => {
		assert.equal(shouldAutoExit({ stopReason: "stop", askPending: true, delegatesRunning: false, steersPending: false }), false);
	});

	it("does NOT exit while a delegate is running", () => {
		assert.equal(shouldAutoExit({ stopReason: "stop", askPending: false, delegatesRunning: true, steersPending: false }), false);
	});

	it("does NOT exit while a steer is pending", () => {
		assert.equal(shouldAutoExit({ stopReason: "stop", askPending: false, delegatesRunning: false, steersPending: true }), false);
	});

	it("never exits on non-terminal stop reasons", () => {
		for (const stopReason of ["toolUse", "length", "aborted", "error", "pending", "deferred", undefined]) {
			assert.equal(
				shouldAutoExit({ stopReason, askPending: false, delegatesRunning: false, steersPending: false }),
				false,
				`stopReason=${String(stopReason)} must not auto-exit`,
			);
		}
	});

	it("accepts the spec's literal end-of-task aliases", () => {
		for (const stopReason of ["end_turn", "done"]) {
			assert.equal(shouldAutoExit({ stopReason, askPending: false, delegatesRunning: false, steersPending: false }), true);
		}
	});

	it("the confirm window covers one steering poll tick (500ms)", () => {
		assert.ok(AUTO_EXIT_SETTLE_CONFIRM_MS >= 500);
	});
});

// ── parentAlive ───────────────────────────────────────────────────────────

describe("parentAlive", () => {
	it("alive when the stat starttime matches", () => {
		assert.equal(
			parentAlive(991, "777", () => STAT_TICKS_777),
			true,
		);
	});

	it("dead when /proc/<pid>/stat cannot be read", () => {
		assert.equal(
			parentAlive(991, "777", () => undefined),
			false,
		);
	});

	it("dead on pid reuse (same pid, different starttime)", () => {
		assert.equal(
			parentAlive(991, "111", () => STAT_TICKS_777),
			false,
		);
	});

	it("SIGSTOP-safe: unchanged pid with matching ticks stays alive even with parens in comm", () => {
		// comm holds spaces + ')' → parsing must be paren-aware
		// (lastIndexOf(')'), never a naive whitespace split).
		const tricky = "991 42 (bad ) name) S 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0 0";
		assert.equal(
			parentAlive(991, "777", () => tricky),
			true,
		);
	});

	it("cannot compare without a start-time source → alive (macOS / non-Linux)", () => {
		assert.equal(
			parentAlive(991, "", () => "anything"),
			true,
		);
		assert.equal(
			parentAlive(991, undefined, () => ""),
			true,
		);
	});
});

// ── per-agent event recorder ──────────────────────────────────────────────

describe("createAgentEventRecorder — real fs path", () => {
	it("creates the missing agents dir on first write and appends {seq,time,event}", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-recorder-"));
		try {
			const eventsPath = path.join(root, "agents", "task-9", "events.jsonl");
			const recorder = createAgentEventRecorder({ eventsPath, now: () => Date.UTC(2026, 7, 26) });
			recorder.record(ASSISTANT_STOP);
			recorder.record({ type: "tool_execution_start", toolName: "read", args: {} });

			const lines = fs.readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean);
			assert.equal(lines.length, 2);
			const parsed = JSON.parse(lines[0]!) as { seq: number; time: string; event: { type: string } };
			assert.deepEqual([parsed.seq, parsed.event.type], [1, "message_end"]);
			assert.ok(parsed.time.startsWith("2026-08-26"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("createAgentEventRecorder", () => {
	it("appends {seq,time,event} lines in order starting at seq 1", () => {
		const out: string[] = [];
		const recorder = createAgentEventRecorder({
			eventsPath: "/tmp/agents/task-9/events.jsonl",
			appendLine: (target, line) => {
				assert.equal(target, "/tmp/agents/task-9/events.jsonl");
				out.push(line);
			},
			now: () => Date.UTC(2026, 7, 26),
		});
		recorder.record({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		recorder.record(ASSISTANT_STOP);

		assert.equal(out.length, 2);
		const first = JSON.parse(out[0]!) as { seq: number; time: string; event: Record<string, unknown> };
		const second = JSON.parse(out[1]!) as { seq: number; time: string; event: Record<string, unknown> };
		assert.deepEqual([first.seq, second.seq], [1, 2]);
		assert.ok(first.time.endsWith("Z"));
		assert.equal(first.event.type, "tool_execution_start");
		assert.equal(second.event.type, "message_end");
		// Assistant turns are remembered for the worker.completed payload.
		assert.equal(recorder.turnSnapshot().resultText, "done");
		assert.equal(recorder.turnSnapshot().usage.input, 10);
	});

	it("drops user/system messages and caps oversized thinking payloads", () => {
		const out: string[] = [];
		const recorder = createAgentEventRecorder({
			eventsPath: "/x/events.jsonl",
			appendLine: (_t, line) => out.push(line),
			now: () => 0,
		});
		recorder.record({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "secret-prompt" }] } });
		recorder.record({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "chain".repeat(5000) }] },
		});

		assert.equal(out.length, 1, "user/system messages are not recorded");
		const parsed = JSON.parse(out[0]!) as { event: { message: { content: Array<{ type: string; thinking: string }> } } };
		const thinking = parsed.event.message.content[0]?.thinking ?? "";
		assert.ok(thinking.length < 40_000, "thinking is capped like the host-side compaction does");
	});

	it("secrets never reach disk through recorded tool output", () => {
		const out: string[] = [];
		const recorder = createAgentEventRecorder({
			eventsPath: "/x/events.jsonl",
			appendLine: (_t, line) => out.push(line),
			now: () => 0,
		});
		recorder.record({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "token=super-secret-value-123" }] },
		});
		const raw = out.join("\n");
		assert.ok(!raw.includes("super-secret-value-123"), `secret leaked: ${raw.slice(0, 200)}`);
	});

	it("survives a throwing writer and counts the failure", () => {
		let calls = 0;
		const recorder = createAgentEventRecorder({
			eventsPath: "/x/events.jsonl",
			appendLine: () => {
				calls += 1;
				throw new Error("EBUSY");
			},
			now: () => 0,
		});
		recorder.record({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
		recorder.record({ type: "tool_execution_start", toolName: "bash", args: {} });

		assert.equal(calls, 2, "every record still attempts its append");
		assert.deepEqual(recorder.stats(), { written: 0, failed: 2 });
		assert.equal(recorder.turnSnapshot().resultText, "hi");
	});
});

// ── activity tracker + tool wrapper ──────────────────────────────────────

describe("worker activity tracking", () => {
	it("tracks nested ask/delegate begin/end pairs", () => {
		const tracker = createWorkerActivityTracker();
		tracker.begin("ask");
		assert.deepEqual(tracker.busy(), { askPending: true, delegatesRunning: false });
		tracker.begin("delegate");
		tracker.end("ask");
		assert.deepEqual(tracker.busy(), { askPending: false, delegatesRunning: true });
		tracker.end("delegate");
		assert.deepEqual(tracker.busy(), { askPending: false, delegatesRunning: false });
	});

	it("wraps execute so a throwing tool call still clears its flag", async () => {
		const tracker = createWorkerActivityTracker();
		const tool = trackToolActivity(
			{
				name: "ask",
				execute: async () => {
					assert.deepEqual(tracker.busy(), { askPending: true, delegatesRunning: false });
					throw new Error("boom");
				},
			},
			tracker,
			"ask",
		);
		await assert.rejects(() => tool.execute());
		assert.deepEqual(tracker.busy(), { askPending: false, delegatesRunning: false });
	});
});

// ── wiring through a fake ExtensionAPI ───────────────────────────────────

describe("registerSurfaceWorkerLifecycle", () => {
	it("registers nothing outside surface context", () => {
		const noop = (): void => undefined;
		assert.equal(registerSurfaceWorkerLifecycle({ on: noop } as never, { env: {} }), undefined);
	});

	it("records compacted session events to the per-agent events.jsonl", () => {
		const h = buildHarness();
		h.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } });
		h.fire("message_end", ASSISTANT_STOP);

		assert.equal(h.lines.length, 2);
		const first = JSON.parse(h.lines[0]!) as { seq: number; event: Record<string, unknown> };
		assert.deepEqual(Object.keys(first.event).sort(), ["args", "toolName", "type"], "record mirrors the host compaction shape");
		assert.equal(first.seq, 1);
	});

	it("auto-exits after a settled turn: worker.completed THEN shutdown (D7 order)", () => {
		const h = buildHarness();
		h.fire("session_start", {}, false); // pi hands every handler a ctx
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			[] as string[],
			"nothing emitted while the confirm window is open",
		);

		h.handle.confirmSettle(); // the deferred confirm (600ms in production)

		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.completed"],
		);
		const completed = h.runEvents[0]!;
		assert.equal(completed.data.result, "done");
		assert.equal(completed.data.stopReason, "stop");
		assert.equal((completed.data.usage as { input: number }).input, 10);
		assert.ok(h.shutdownCalls() >= 1, "session shutdown requested after the terminal event was flushed");
		assert.deepEqual(h.exitCodes(), [], "pi shutdown API preferred over process.exit");

		// A second settled turn after termination must not double-report.
		h.fire("agent_settled", {});
		h.handle.confirmSettle();
		assert.equal(h.runEvents.length, 1);
	});

	it("holds the exit while a steer arrives during the settle-confirm window", () => {
		const h = buildHarness();
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});

		assert.equal(h.runEvents.length, 0, "nothing emitted while the confirm window is open");
		assert.ok(h.timers.intervals().length >= 0);

		// Deliver the deferred confirm, with pi reporting pending messages.
		h.handle.confirmSettle(true);
		assert.deepEqual(h.runEvents, [], "exit aborted when a steer became pending");

		// Drained queue on a later settle → exits normally.
		h.fire("agent_settled", {});
		h.handle.confirmSettle(false);
		assert.equal(h.runEvents.length, 1);
	});

	it("aborts immediately when an ask/delegate is still running", () => {
		const h = buildHarness();
		h.handle.activity.begin("ask");
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});
		assert.deepEqual(h.runEvents, []);
		assert.equal(h.shutdownCalls(), 0, "pending ask keeps the session alive");
		h.handle.activity.end("ask");
	});

	it("recording-only config (no AUTO_EXIT, no PARENT_PID) records without ever exiting", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_AUTO_EXIT: "" }),
		});
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});
		assert.equal(h.lines.length, 1);
		assert.deepEqual(h.runEvents, [], "no terminal event without PI_CREW_AUTO_EXIT=1");
	});

	it("parent-guard emits worker.parent-lost then shuts down", () => {
		const h = buildHarness({
			// /proc/<pid>/stat gone = the parent process itself is dead.
			env: workerEnv({ PI_CREW_PARENT_PID: "4242", PI_CREW_PARENT_START_TIME: "777" }),
			readStat: () => undefined,
		});
		h.fire("session_start", {}, false); // ctx.shutdown must be reachable
		const armed = h.timers.intervals();
		assert.equal(armed.length, 1);
		assert.equal(armed[0]?.ms, PARENT_GUARD_INTERVAL_MS);

		h.timers.invokeInterval(armed[0]!.id);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.parent-lost"],
		);
		assert.ok(h.shutdownCalls() >= 1);
		assert.equal(h.timers.pendingIntervals(), 0, "guard timer cleared after firing");

		// Idempotent: further ticks stay silent.
		h.timers.invokeInterval(armed[0]!.id);
		assert.equal(h.runEvents.length, 1);
	});

	it("parent-guard treats pid reuse (live pid, different starttime) as lost", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_PARENT_PID: "4242", PI_CREW_PARENT_START_TIME: "111" }),
			readStat: () => STAT_TICKS_777,
		});
		const [timer] = h.timers.intervals();
		h.timers.invokeInterval(timer!.id);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.parent-lost"],
		);
	});

	it("healthy parent produces no events", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_PARENT_PID: "4242", PI_CREW_PARENT_START_TIME: "777" }),
			readStat: () => STAT_TICKS_777,
		});
		const [timer] = h.timers.intervals();
		h.timers.invokeInterval(timer!.id);
		assert.deepEqual(h.runEvents, []);
		assert.equal(h.shutdownCalls(), 0);
	});

	it("clears its timers on session_shutdown (no leak after quit/reload)", () => {
		const h = buildHarness({ env: workerEnv({ PI_CREW_PARENT_PID: "4242" }) });
		h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, false);
		assert.equal(h.timers.pendingIntervals(), 0);
	});
});
