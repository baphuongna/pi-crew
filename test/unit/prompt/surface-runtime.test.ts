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
	WORKER_ERROR_EVENT_CAP,
} from "../../../src/prompt/surface-worker.ts";
import { readCrewAgentEventsCursor } from "../../../src/runtime/crew-agent-records.ts";
import { fieldsAfterComm, procStartTimeTicks } from "../../../src/runtime/process/proc-stat.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";

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
	/** Runs the production deferred callback (e.g. the settle confirm). */
	invokeTimeout(id: number): void;
	pendingIntervals(): number;
	intervals(): Array<{ id: number; ms: number }>;
	pendingTimeouts(): number[];
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
			invokeTimeout(id) {
				const fn = timeouts.get(id);
				if (!fn) return;
				timeouts.delete(id);
				fn();
			},
			pendingIntervals() {
				return intervals.size;
			},
			intervals: () => [...intervals.entries()].map(([id, meta]) => ({ id, ms: meta.ms })),
			pendingTimeouts: () => [...timeouts.keys()],
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

interface SessionStateSpec {
	pending?: boolean;
	idle?: boolean;
}

interface Harness extends Record<string, unknown> {
	lines: string[];
	runEvents: Array<{ type: string; data: Record<string, unknown> }>;
	/** Ordered observable effects: `emit:<type>` / `ctx.abort` / `ctx.shutdown`. */
	calls: string[];
	shutdownCalls(): number;
	exitCodes(): number[];
	timers: TimerRegistry;
	handle: NonNullable<ReturnType<typeof registerSurfaceWorkerLifecycle>>;
	fire(event: string, payload?: unknown, spec?: boolean | SessionStateSpec): void;
	setSession(spec: SessionStateSpec): void;
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
	const calls: string[] = [];
	let shutdownCalls = 0;
	const exitCodes: number[] = [];
	// Mutable per-test session view — the fake ctx closures read it LIVE, so a
	// steer toggled mid-confirm-window is visible when the timer finally runs.
	const sessionState = { pending: false, idle: true };
	const bundle = fakeTimers();

	const handle = registerSurfaceWorkerLifecycle(pi as never, {
		env: workerEnv(),
		appendLine: (_target, line) => lines.push(line),
		emitRunEvent: (type, data) => {
			runEvents.push({ type, data });
			calls.push(`emit:${type}`);
		},
		readStat: () => undefined,
		exit: ((code: number) => {
			exitCodes.push(code);
			calls.push(`exit:${code}`);
			return undefined as never;
		}) as never,
		...bundle.deps,
		...opts,
	});
	assert.ok(handle);

	function setSession(spec: SessionStateSpec): void {
		if (spec.pending !== undefined) sessionState.pending = spec.pending;
		if (spec.idle !== undefined) sessionState.idle = spec.idle;
	}

	function fire(event: string, payload: unknown = {}, spec: boolean | SessionStateSpec = {}): void {
		setSession(typeof spec === "boolean" ? { pending: spec } : spec);
		for (const reg of registrations.filter((r) => r.event === event)) {
			reg.handler(payload, {
				hasPendingMessages: () => sessionState.pending,
				isIdle: () => sessionState.idle,
				abort: () => calls.push("ctx.abort"),
				shutdown: () => {
					shutdownCalls += 1;
					calls.push("ctx.shutdown");
				},
			});
		}
	}

	return {
		lines,
		runEvents,
		calls,
		shutdownCalls: () => shutdownCalls,
		exitCodes: () => exitCodes,
		timers: bundle.timers,
		handle,
		fire,
		setSession,
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

/** A failed turn (pi keeps the provider error on message.errorMessage). */
const ASSISTANT_ERROR = {
	type: "message_end",
	message: {
		role: "assistant",
		stopReason: "error",
		errorMessage: "provider overload",
		content: [{ type: "text", text: "attempt failed" }],
		usage: { input: 10, output: 2, cost: { total: 0.02 } },
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

		// T11: registration itself emits `worker.started` (self-report + run event),
		// so the recorder's FIRST line is that self-report at seq 1 and the
		// compacted session events follow.
		assert.equal(h.lines.length, 3);
		const started = JSON.parse(h.lines[0]!) as { seq: number; event: Record<string, unknown> };
		assert.equal(started.event.type, "worker.started");
		const first = JSON.parse(h.lines[1]!) as { seq: number; event: Record<string, unknown> };
		assert.deepEqual(Object.keys(first.event).sort(), ["args", "toolName", "type"], "record mirrors the host compaction shape");
		assert.equal(first.seq, 2);
	});

	it("auto-exits after a settled turn: worker.completed THEN abort+shutdown (D7 order)", () => {
		const h = buildHarness();
		h.fire("session_start"); // pi hands every handler a ctx
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled");
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
			"nothing but the registration report while the confirm window is open",
		);

		const [confirmId] = h.timers.pendingTimeouts();
		h.timers.invokeTimeout(confirmId!); // the deferred confirm (600ms in production)

		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started", "worker.completed"],
		);
		const completed = h.runEvents.at(-1)!;
		assert.equal(completed.data.result, "done");
		assert.equal(completed.data.stopReason, "stop");
		assert.equal((completed.data.usage as { input: number }).input, 10);
		// Ordering: report (sync append + flush) → cut any running turn → shutdown.
		assert.deepEqual(h.calls.slice(-3), ["emit:worker.completed", "ctx.abort", "ctx.shutdown"]);
		assert.deepEqual(h.exitCodes(), [], "pi shutdown API preferred over process.exit");

		// A second settled turn after termination must not double-report.
		h.fire("agent_settled");
		h.timers.invokeTimeout(1); // no new timer is armed once terminated
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started", "worker.completed"],
		);
		assert.deepEqual(h.timers.pendingTimeouts(), [], "confirm timer cleared after firing");
	});

	it("holds the exit while a steer arrives during the settle-confirm window", () => {
		const h = buildHarness();
		h.fire("message_end", ASSISTANT_STOP);
		const confirmIdsAfterFirstSettle = (): number[] => {
			h.fire("agent_settled");
			return h.timers.pendingTimeouts();
		};

		let [confirmId] = confirmIdsAfterFirstSettle();
		assert.ok(confirmId !== undefined, "a confirm timer is armed for an idle-looking settle");

		// The steer lands mid-window: pi reports a queued message at confirm time.
		h.setSession({ pending: true });
		h.timers.invokeTimeout(confirmId!);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
			"exit aborted when a steer became pending",
		);

		// Same race, other direction: the queued steer already STARTED its own
		// run before our window closed — no longer idle → still no exit.
		h.setSession({ pending: false, idle: false });
		[confirmId] = confirmIdsAfterFirstSettle();
		h.timers.invokeTimeout(confirmId!);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
		);

		// Drained queue on a later settle → exits normally.
		h.setSession({ idle: true });
		[confirmId] = confirmIdsAfterFirstSettle();
		h.timers.invokeTimeout(confirmId!);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started", "worker.completed"],
		);
		assert.deepEqual(h.calls.at(-1), "ctx.shutdown");
	});

	it("aborts immediately when an ask/delegate is still running (no timer churn)", () => {
		const h = buildHarness();
		h.handle.activity.begin("delegate");
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {}, { pending: false });
		assert.deepEqual(h.timers.pendingTimeouts(), [], "no confirm armed while a delegate runs");
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
		);
		assert.equal(h.shutdownCalls(), 0, "running delegate keeps the session alive");

		// Once the delegate finishes, the NEXT settle exits normally.
		h.handle.activity.end("delegate");
		h.fire("message_end", ASSISTANT_STOP);
		const [confirmId] = (() => {
			h.fire("agent_settled");
			return h.timers.pendingTimeouts();
		})();
		h.timers.invokeTimeout(confirmId!);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started", "worker.completed"],
		);
	});

	it("aborts immediately when an ask is still running", () => {
		const h = buildHarness();
		h.handle.activity.begin("ask");
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
		);
		assert.equal(h.shutdownCalls(), 0, "pending ask keeps the session alive");
	});

	it("recording-only config (no AUTO_EXIT, no PARENT_PID) records without ever exiting", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_AUTO_EXIT: "" }),
		});
		h.fire("message_end", ASSISTANT_STOP);
		h.fire("agent_settled", {});
		// lines[0] = worker.started self-report, lines[1] = the compacted event.
		assert.equal(h.lines.length, 2);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
			"only the started report — no terminal event without PI_CREW_AUTO_EXIT=1",
		);
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
			["worker.started", "worker.parent-lost"],
		);
		// Parent died (possibly mid-turn): report → abort the running turn →
		// shutdown, so pi's deferred shutdown completes instead of freezing.
		assert.deepEqual(h.calls.slice(-3), ["emit:worker.parent-lost", "ctx.abort", "ctx.shutdown"]);
		assert.equal(h.timers.pendingIntervals(), 0, "guard timer cleared after firing");

		// Idempotent: further ticks stay silent.
		h.timers.invokeInterval(armed[0]!.id);
		assert.equal(h.runEvents.length, 2);
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
			["worker.started", "worker.parent-lost"],
		);
	});

	it("healthy parent produces no events", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_PARENT_PID: "4242", PI_CREW_PARENT_START_TIME: "777" }),
			readStat: () => STAT_TICKS_777,
		});
		const [timer] = h.timers.intervals();
		h.timers.invokeInterval(timer!.id);
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
		);
		assert.equal(h.shutdownCalls(), 0);
	});

	it("clears its timers on session_shutdown (no leak after quit/reload)", () => {
		const h = buildHarness({ env: workerEnv({ PI_CREW_PARENT_PID: "4242" }) });
		h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, false);
		assert.equal(h.timers.pendingIntervals(), 0);
	});

	it("reports worker.error on a failed settled turn WITHOUT exiting (pane stays for inspection)", () => {
		const h = buildHarness();
		h.fire("message_end", ASSISTANT_ERROR);
		h.fire("agent_settled");
		const [confirmId] = h.timers.pendingTimeouts();
		h.timers.invokeTimeout(confirmId!);

		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started", "worker.error"],
		);
		const failure = h.runEvents.at(-1)!;
		assert.equal(failure.data.errorMessage, "provider overload");
		assert.equal(failure.data.stopReason, "error");
		assert.equal((failure.data.usage as { input: number }).input, 10, "usage still reported");
		assert.deepEqual(h.calls.slice(1), ["emit:worker.error"], "no abort/shutdown — the pane stays open");
		assert.equal(h.shutdownCalls(), 0);

		// Repeated failed settles keep reporting (bounded), never exit.
		for (let i = 0; i < WORKER_ERROR_EVENT_CAP + 2; i++) {
			h.fire("message_end", ASSISTANT_ERROR);
			h.fire("agent_settled");
			const [id] = h.timers.pendingTimeouts();
			if (id !== undefined) h.timers.invokeTimeout(id);
		}
		const errorCount = h.runEvents.filter((e) => e.type === "worker.error").length;
		assert.ok(errorCount <= WORKER_ERROR_EVENT_CAP, `terminal bypass needs a cap: got ${errorCount}`);
	});
});

// ── seq seeding across attempts (host cursor stays monotonic) ─────────────

describe("worker.started self-report (S2-T11, §12.2)", () => {
	it("emits once at registration into BOTH the per-agent log (seq 1) and the run event log", () => {
		const h = buildHarness({
			env: workerEnv({ PI_CREW_SURFACE_PANE: "%12" }),
		});
		assert.deepEqual(
			h.runEvents.map((e) => e.type),
			["worker.started"],
			"registration report is the FIRST terminal-path run event",
		);
		const started = h.runEvents[0]!;
		assert.equal(started.data.pid, process.pid);
		assert.equal(started.data.surface, "tmux");
		assert.equal(started.data.surfacePaneId, "%12");

		const first = JSON.parse(h.lines[0]!) as { seq: number; event: Record<string, unknown> };
		assert.deepEqual([first.seq, first.event.type], [1, "worker.started"]);
	});

	it("keeps seq monotonic: a record() after recordSelfReport continues +1", () => {
		const out: string[] = [];
		const now = (): number => Date.UTC(2026, 7, 26);
		const recorder = createAgentEventRecorder({
			eventsPath: "",
			appendLine: (_t, line) => out.push(line),
			now,
		});
		recorder.recordSelfReport({ type: "worker.started", pid: 1 });
		recorder.record(ASSISTANT_STOP);
		const parsed = out.map((line) => JSON.parse(line) as { seq: number; event: Record<string, unknown> });
		assert.deepEqual(
			parsed.map((entry) => [entry.seq, entry.event.type]),
			[
				[1, "worker.started"],
				[2, "message_end"],
			],
		);
	});
});

describe("recorder seq seeding", () => {
	/** Host-format log with seq 1..5 (what an earlier attempt left behind). */
	function writeHostLog(dir: string, taskId: string, maxSeq: number): string {
		const eventsPath = path.join(dir, "agents", taskId, "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		const lines = Array.from(
			{ length: maxSeq },
			(_, i) =>
				`${JSON.stringify({ seq: i + 1, time: new Date(Date.UTC(2026, 7, 1)).toISOString(), event: { type: "message_end" } })}\n`,
		);
		fs.writeFileSync(eventsPath, lines.join(""), "utf-8");
		return eventsPath;
	}

	it("continues after an earlier attempt so readCrewAgentEventsCursor(sinceSeq) still sees new events", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-seed-"));
		try {
			const stateRoot = dir;
			writeHostLog(stateRoot, "task-9", 5);
			const manifest = { stateRoot } as unknown as TeamRunManifest;

			const recorder = createAgentEventRecorder({
				eventsPath: path.join(stateRoot, "agents", "task-9", "events.jsonl"),
				now: () => Date.UTC(2026, 7, 26),
			});
			recorder.record(ASSISTANT_STOP);

			const cursor = readCrewAgentEventsCursor(manifest, "task-9", { sinceSeq: 5 });
			assert.equal(cursor.events.length, 1, "a fresh event MUST be visible past the old cursor");
			assert.equal((cursor.events[0] as { seq: number }).seq, 6);
			assert.equal(cursor.nextSeq, 6);
			// And the recorder itself keeps counting from there.
			recorder.record({ type: "tool_execution_start", toolName: "read", args: {} });
			const last = JSON.parse(fs.readFileSync(cursor.path, "utf-8").trim().split("\n").at(-1)!) as { seq: number };
			assert.equal(last.seq, 7);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("seeds from an injected tail reader and tolerates a trailing partial line", () => {
		const out: string[] = [];
		const recorder = createAgentEventRecorder({
			eventsPath: "/tmp/agents/task-x/events.jsonl",
			appendLine: (_t, line) => out.push(line),
			readTail: () => '{"seq":41,"time":"t","event":{}}\n{"seq":4', // partial trailing write
		});
		recorder.record(ASSISTANT_STOP);
		assert.equal(JSON.parse(out[0]!).seq, 42, "next seq = max(existing)+1, partial line ignored");

		// No readable log (absent file / non-writer sink) → starts at 1.
		const fresh = createAgentEventRecorder({
			eventsPath: "/tmp/agents/task-y/events.jsonl",
			appendLine: (_t, line) => out.push(line),
			readTail: () => undefined,
		});
		fresh.record(ASSISTANT_STOP);
		assert.equal(JSON.parse(out.at(-1)!).seq, 1);
	});

	it("explicit seedSeq overrides the automatic tail scan", () => {
		const out: string[] = [];
		const recorder = createAgentEventRecorder({
			eventsPath: "/tmp/agents/task-z/events.jsonl",
			appendLine: (_t, line) => out.push(line),
			readTail: () => '{"seq":9}',
			seedSeq: 100,
		});
		recorder.record(ASSISTANT_STOP);
		assert.equal(JSON.parse(out[0]!).seq, 101);
	});
});

// ── shared /proc stat parser (worker + spawn + zombie-scanner drift guard) ─

describe("proc-stat field parsing (shared)", () => {
	it("reads starttime AND ppid from the same paren-aware split", () => {
		// Same comm-with-parens hazard as the guard/spawn fixtures.
		const stat = "991 42 (bad ) name) S 1 991 991 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 1 0 777 0 0";
		const fields = fieldsAfterComm(stat);
		assert.ok(fields);
		assert.equal(fields[0], "S", "rest[0] is state (zombie-scanner)");
		assert.equal(fields[1], "1", "rest[1] is ppid (zombie-scanner)");
		assert.equal(procStartTimeTicks(stat), "777", "rest[19] is starttime (spawn + worker guard)");
	});

	it("rejects unparseable buffers", () => {
		assert.equal(fieldsAfterComm("no parens here"), undefined);
		assert.equal(procStartTimeTicks("991 42 ) x"), undefined);
	});
});
