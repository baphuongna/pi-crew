/**
 * degrade.test.ts — Task 11 (spec §7 D3 + §8.3 manifest surface state).
 *
 * Bốn lớp được kiểm chứng:
 *  1. classifyOnExit (2s classify timeout — timing nằm ở probe injectable),
 *  2. makeTerminalEventProbe (tail RUN events.jsonl tìm worker.completed),
 *  3. lockout counters theo cause-group (mux-dead batch = +1 dù N pane),
 *  4. spawn-fail counter (3 liên tiếp → OFF hết run; 1–2 fail thì không),
 * cùng các reducer manifest + planHeadlessRedeplays + per-run controller.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__clearAllSurfaceControllers,
	CLASSIFY_TIMEOUT_MS,
	classifyOnExit,
	clearSurfaceRuntimeController,
	createSurfaceRuntimeController,
	getSurfaceRuntimeController,
	isSpawnFailLockout,
	makeTerminalEventProbe,
	nextConsecutiveSpawnFails,
	nextLockoutCounts,
	nextLockoutCountsForBatch,
	normalizeSurfaceState,
	planHeadlessRedeplays,
	recordSurfacePane,
	registerSurfaceRuntimeController,
	releaseSurfacePane,
	SURFACE_SPAWN_FAIL_LOCKOUT_THRESHOLD,
	type SurfaceDegradedEntry,
} from "../../../../src/runtime/surface/degrade.ts";
import type { SurfaceHandle } from "../../../../src/runtime/surface/surface-provider.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

function fakeHandle(id = "%1"): SurfaceHandle {
	return {
		id,
		kind: "tmux",
		onExit() {
			/* fixture — pane không bao giờ tự thoát trong test này */
		},
		dispose() {
			/* fixture không cần dọn gì */
		},
	};
}

// ── 1. classifyOnExit ─────────────────────────────────────────────────────

test("classifyOnExit: worker.completed đến trong cửa sổ classify → completed", async () => {
	// Hoàn thành "tại" 1500ms của ngân sách 2000ms — mốc của brief.
	const completedAtMs = 1500;
	const wait = async (budgetMs: number): Promise<boolean> => budgetMs >= completedAtMs;
	assert.equal(await wait(1500), true);
	const verdict = await classifyOnExit(fakeHandle(), wait, { timeoutMs: CLASSIFY_TIMEOUT_MS });
	assert.equal(verdict, "completed");
});

test("classifyOnExit: không có tín hiệu sau 2s → degraded", async () => {
	let elapsed = 0;
	const neverCompleted = async (budgetMs: number): Promise<boolean> => {
		while (elapsed < budgetMs) elapsed += 250; // fake clock do test điều khiển
		return false;
	};
	const verdict = await classifyOnExit(fakeHandle("%3"), neverCompleted, { timeoutMs: 2000 });
	assert.equal(verdict, "degraded");
	assert.ok(elapsed >= 2000, "phải đốt đúng (tối thiểu) ngân sách classify trước khi trả degraded");
});

// ── makeTerminalEventProbe ────────────────────────────────────────────────

/** Clock đồng bộ cho probe: sleep resolve ngay VÀ tự tăng clock → không treo thật. */
function makeFakeClock(startMs = 0, advancePerSleep = 100) {
	let nowMs = startMs;
	return {
		now: (): number => nowMs,
		tick: (ms: number): void => {
			nowMs += ms;
		},
		sleep: async (): Promise<void> => {
			nowMs += advancePerSleep;
			await Promise.resolve();
		},
	};
}

test("makeTerminalEventProbe: worker.completed ghi sẵn trước pane exit → true ngay", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-degrade-probe-"));
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(
		eventsPath,
		`${JSON.stringify({ seq: 1, time: "t", event: { type: "message_end" } })}\n` +
			`${JSON.stringify({ type: "worker.completed", runId: "run-1", taskId: "01_a", data: { result: "DONE", stopReason: "stop" } })}\n`,
		"utf8",
	);
	const clock = makeFakeClock(10_000);
	const probe = makeTerminalEventProbe({
		eventsPath,
		taskId: "01_a",
		runId: "run-1",
		readFile: () => fs.readFileSync(eventsPath, "utf8"),
		sleep: clock.sleep,
		now: clock.now,
	});
	assert.equal(await probe(2000), true);
	assert.deepEqual(probe.foundPayload(), { result: "DONE", stopReason: "stop" });
	fs.rmSync(dir, { recursive: true, force: true });
});

test("makeTerminalEventProbe: completion đến SAU exit nhưng trong 2s → true", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-degrade-probe-late-"));
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, "", "utf8");
	const clock = makeFakeClock(0, 100);
	const probe = makeTerminalEventProbe({
		eventsPath,
		taskId: "02_b",
		readFile: () => fs.readFileSync(eventsPath, "utf8"),
		sleep: clock.sleep,
		now: clock.now,
		pollMs: 100,
	});
	const pending = probe(2000);
	await Promise.resolve(); // cho vòng poll đầu chạy xong (file còn rỗng)
	fs.appendFileSync(eventsPath, `${JSON.stringify({ type: "worker.completed", taskId: "02_b", data: {} })}\n`, "utf8");
	assert.equal(await pending, true);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("makeTerminalEventProbe: hết 2s không thấy completion → false (offset incremental)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-degrade-probe-timeout-"));
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, "", "utf8");
	const clock = makeFakeClock(0, 50);
	let reads = 0;
	const probe = makeTerminalEventProbe({
		eventsPath,
		taskId: "03_c",
		readFile: (): string => {
			reads += 1;
			return fs.readFileSync(eventsPath, "utf8");
		},
		sleep: clock.sleep,
		now: clock.now,
		pollMs: 50,
	});
	assert.equal(await probe(2000), false, "không có worker.completed trong ngân sách → degraded");
	assert.deepEqual(probe.foundPayload(), {});
	assert.ok(clock.now() >= 2000, "probe phải tiêu hết ngân sách");
	assert.ok(reads <= 42, `poll thưa đủ để không nóng CPU (reads=${reads})`);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("makeTerminalEventProbe: bỏ qua completion của task khác và dòng JSON hỏng", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-degrade-probe-other-"));
	const eventsPath = path.join(dir, "events.jsonl");
	fs.writeFileSync(eventsPath, "{torn line\n{also broken\n", "utf8");
	fs.appendFileSync(eventsPath, `${JSON.stringify({ type: "worker.completed", taskId: "OTHER", data: { result: "nope" } })}\n`, "utf8");
	const clock = makeFakeClock(0, 10);
	const probe = makeTerminalEventProbe({
		eventsPath,
		taskId: "04_d",
		readFile: () => fs.readFileSync(eventsPath, "utf8"),
		sleep: clock.sleep,
		now: clock.now,
		pollMs: 10,
	});
	assert.equal(await probe(100), false);
	fs.rmSync(dir, { recursive: true, force: true });
});

// ── Lockout counters ──────────────────────────────────────────────────────

test("nextLockoutCounts: mỗi cause cộng vào nhóm của nó", () => {
	assert.deepEqual(nextLockoutCounts({ pane: 1, mux: 0 }, "pane-closed"), { pane: 2, mux: 0 });
	assert.deepEqual(nextLockoutCounts({ pane: 1, mux: 0 }, "mux-dead"), { pane: 1, mux: 1 });
	assert.deepEqual(nextLockoutCounts(undefined as unknown as { pane: number; mux: number }, "mux-dead"), { pane: 0, mux: 1 });
});

test("anti-flap: N pane degrade cùng lúc vì mux chết → mux chỉ +1, không +N", () => {
	const causes: SurfaceDegradedEntry["cause"][] = ["mux-dead", "mux-dead", "mux-dead"];
	assert.deepEqual(nextLockoutCountsForBatch({ pane: 0, mux: 0 }, causes), { pane: 0, mux: 1 });
	const mixed = ["mux-dead", "pane-closed", "mux-dead", "pane-closed"] as const;
	assert.deepEqual(nextLockoutCountsForBatch({ pane: 0, mux: 0 }, mixed), { pane: 2, mux: 1 });
	assert.equal(SURFACE_SPAWN_FAIL_LOCKOUT_THRESHOLD, 3);
});

// ── Spawn-fail counter ────────────────────────────────────────────────────

test("spawn-fail: 1–2 fail liên tiếp chưa khóa, fail thứ 3 khóa, boot thành công reset", () => {
	let streak = 0;
	streak = nextConsecutiveSpawnFails(streak, true);
	assert.equal(isSpawnFailLockout(streak), false);
	streak = nextConsecutiveSpawnFails(streak, true);
	assert.equal(isSpawnFailLockout(streak), false);
	streak = nextConsecutiveSpawnFails(streak, true);
	assert.equal(isSpawnFailLockout(streak), true);
	streak = nextConsecutiveSpawnFails(streak, false); // boot thành công
	assert.equal(isSpawnFailLockout(streak), false);
	assert.equal(nextConsecutiveSpawnFails(streak, true), 1);
});

// ── Manifest reducers ─────────────────────────────────────────────────────

test("reducers: spawn → release → panes map sống đúng", () => {
	const state = recordSurfacePane(normalizeSurfaceState(undefined), { taskId: "01", paneId: "%7", provider: "tmux" });
	assert.equal(state.provider, "tmux");
	assert.equal(state.panes["01"], "%7");
	const released = releaseSurfacePane(state, "01");
	assert.deepEqual(released.panes, {});
	// release task không có pane là no-op (cùng reference — tránh ghi đĩa thừa)
	assert.equal(releaseSurfacePane(state, "ghost"), state);
});

test("normalizeSurfaceState: manifest legacy/thồi không làm crash reducer", () => {
	const state = normalizeSurfaceState({
		provider: "herdr",
		panes: { a: "%1", broken: 42 },
		workerPids: { a: 7, bad: "x" },
		sessionPaths: [],
		lockout: { since: "2026-08-26T00:00:00Z", counts: { pane: -3 } },
	});
	assert.equal(state.provider, "herdr");
	assert.deepEqual(state.panes, { a: "%1" });
	assert.deepEqual(state.workerPids, { a: 7 });
	assert.deepEqual(state.sessionPaths, {});
	assert.equal(state.lockout?.counts.pane, -3, "counts âm giữ nguyên giá trị raw (đếm evidence)");
	assert.equal(normalizeSurfaceState(null).provider, null);
	assert.equal(normalizeSurfaceState("garbage").provider, null);
	assert.equal(normalizeSurfaceState({ lockout: null }).lockout, undefined);
});

// ── planHeadlessRedeplays ─────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		runId: "run-1",
		role: "worker",
		agent: "worker",
		title: id,
		status: "needs_attention",
		dependsOn: [],
		cwd: "/tmp/x",
		...overrides,
	};
}

const DEGRADED: SurfaceDegradedEntry[] = [{ taskId: "01", paneId: "%9", cause: "pane-closed", ts: "2026-08-26T10:00:00Z" }];

test("planHeadlessRedeplays: needs_attention → queued kèm resume note + marker surface-lost", () => {
	const plan = planHeadlessRedeplays({ tasks: [makeTask("01")], degraded: DEGRADED });
	assert.deepEqual(plan.requeuedTaskIds, ["01"]);
	const task = plan.tasks[0]!;
	assert.equal(task.status, "queued");
	assert.match(task.pendingSteers![0]!, /Continue from where you left off/);
	assert.match(task.pendingSteers![0]!, /cause=pane-closed/);
	assert.equal(task.attempts!.at(-1)!.error, "[surface-lost] pane-closed");
	assert.notEqual(task.attempts!.at(-1)!.attemptId!.indexOf("surface-lost"), -1);
	assert.notEqual((task.diagnostics as Record<string, unknown>).surfaceLost, undefined);
	// Degrade KHÔNG ăn retry budget (spec §7 bước 5)
	assert.equal(task.policy?.retryCount ?? 0, 0);
	assert.equal(task.error, undefined);
	assert.equal(task.finishedAt, undefined);
});

test("planHeadlessRedeplays: idempotent theo handled set + bỏ qua task lạ/trạng thái khác", () => {
	const handled = new Set<string>();
	const first = planHeadlessRedeplays({ tasks: [makeTask("01")], degraded: DEGRADED, handledTaskIds: handled });
	assert.deepEqual(first.requeuedTaskIds, ["01"]);
	const second = planHeadlessRedeplays({ tasks: first.tasks, degraded: DEGRADED, handledTaskIds: handled });
	assert.deepEqual(second.requeuedTaskIds, []);
	assert.equal(second.skipped[0]!.reason, "already re-dispatched once for surface loss");

	const foreign = planHeadlessRedeplays({
		tasks: [makeTask("09", { status: "completed" })],
		degraded: [{ ...DEGRADED[0]!, taskId: "09" }],
	});
	assert.deepEqual(foreign.requeuedTaskIds, []);
	assert.match(foreign.skipped[0]!.reason, /owned by another lifecycle/);

	const missing = planHeadlessRedeplays({ tasks: [], degraded: DEGRADED });
	assert.equal(missing.skipped[0]!.reason, "task not in graph");
});

// ── Per-run controller ────────────────────────────────────────────────────

type RecordedEvent = { type: string; runId?: string; taskId?: string; message?: string; data?: Record<string, unknown> };

interface ControllerHarness {
	controller: ReturnType<typeof createSurfaceRuntimeController>;
	events: RecordedEvent[];
	revoked: string[];
	setNow: (ms: number) => void;
}

function makeController(runId: string, startNowMs = Date.parse("2026-08-26T10:00:00Z")): ControllerHarness {
	const events: RecordedEvent[] = [];
	const revoked: string[] = [];
	let nowMs = startNowMs;
	const controller = createSurfaceRuntimeController({
		runId,
		eventsPath: "/tmp/events.jsonl",
		appendEvent: (_path, event) => events.push(event as RecordedEvent),
		revoke: (taskId) => revoked.push(taskId),
		now: () => nowMs,
	});
	return { controller, events, revoked, setNow: (ms) => (nowMs = ms) };
}

test("controller: panes/pids sống; spawn-fail 3 liên tiếp khóa (boot thành công reset streak)", () => {
	const harness = makeController("run-ctl");
	const { controller } = harness;
	assert.equal(controller.shouldAttemptSurface(), true);
	controller.notifySpawned({ taskId: "01", paneId: "%4", provider: "tmux" });
	assert.equal(controller.livePaneCount(), 1);
	assert.equal(controller.snapshot().panes["01"], "%4");

	controller.notifyWorkerStarted({ taskId: "01", pid: 1234, sessionPath: "/tmp/s.jsonl" });
	assert.deepEqual(controller.snapshot().workerPids, { "01": 1234 });
	assert.deepEqual(controller.snapshot().sessionPaths, { "01": "/tmp/s.jsonl" });

	controller.notifySpawnFailed({ taskId: "02", reason: "createSurface failed: boom" });
	assert.equal(controller.shouldAttemptSurface(), true);
	controller.notifySpawnFailed({ taskId: "03", reason: "surface boot failed: boom" });
	assert.equal(controller.shouldAttemptSurface(), true);
	// boot thành công disproves streak — fail phải LIÊN TIẾP mới khóa
	controller.notifySpawned({ taskId: "04", paneId: "%5", provider: "tmux" });
	assert.equal(controller.consecutiveSpawnFails(), 0);
	controller.notifySpawnFailed({ taskId: "05", reason: "boom" });
	controller.notifySpawnFailed({ taskId: "06", reason: "boom" });
	controller.notifySpawnFailed({ taskId: "07", reason: "boom" });
	assert.equal(controller.shouldAttemptSurface(), false, "3 spawn-fail liên tiếp → OFF hết run");
	assert.equal(controller.snapshot().lockout?.cause, "spawn-fail");
	// khóa thêm lần nữa là no-op (không ghi đè since, không spam)
	harness.setNow(Date.parse("2026-08-26T11:00:00Z"));
	controller.notifySpawnFailed({ taskId: "08", reason: "boom" });
	assert.equal(controller.snapshot().lockout?.since, new Date(Date.parse("2026-08-26T10:00:00Z")).toISOString());
	assert.deepEqual(harness.events, [], "spawn-fail không ghi surface.degraded");
});

test("controller: degrade ⇒ release pane + lockout + event surface.degraded + revoke + hàng đợi requeue", () => {
	const harness = makeController("run-degrade");
	const baseMs = Date.parse("2026-08-26T10:00:00Z");
	harness.setNow(baseMs + 1000);
	harness.controller.notifySpawned({ taskId: "01", paneId: "%9", provider: "herdr" });
	harness.controller.notifyPaneExited({ taskId: "01", paneId: "%9", completed: false, exitReason: "mux-dead" });

	assert.equal(harness.controller.livePaneCount(), 0, "pane thoát bị trừ khỏi count sống");
	assert.equal(harness.controller.shouldAttemptSurface(), false, "≥1 degrade → surface OFF phần còn lại của run");
	assert.deepEqual(harness.revoked, ["01"]);
	assert.equal(harness.events.length, 1);
	assert.equal(harness.events[0]!.type, "surface.degraded");
	assert.equal(harness.events[0]!.runId, "run-degrade");
	assert.equal(harness.events[0]!.taskId, "01");
	assert.deepEqual(harness.events[0]!.data, {
		taskId: "01",
		paneId: "%9",
		reason: "mux-dead",
		ts: new Date(baseMs + 1000).toISOString(),
		cause: "mux-dead",
	});
	assert.equal(harness.controller.snapshot().lockout?.since, new Date(baseMs + 1000).toISOString());

	const drained = harness.controller.takeDegraded();
	assert.deepEqual(
		drained.map((entry) => ({ cause: entry.cause, taskId: entry.taskId, paneId: entry.paneId })),
		[{ cause: "mux-dead", taskId: "01", paneId: "%9" }],
	);
	assert.deepEqual(harness.controller.takeDegraded(), [], "drain lần hai rỗng");
});

test("controller: cancel/timedOut/detached/completed KHÔNG thành degrade", () => {
	const cases = [
		{ label: "cancel force-close", exitReason: "detached" as const, extra: { cancelledByAbort: true } },
		{ label: "response deadline", exitReason: "detached" as const, extra: { timedOut: true } },
		{ label: "host dispose", exitReason: "detached" as const, extra: {} },
	];
	for (const scenario of cases) {
		const harness = makeController(`run-no-flap-${scenario.exitReason}-${scenario.label.replace(/\W+/g, "-")}`);
		harness.controller.notifySpawned({ taskId: "t", paneId: "%1", provider: "tmux" });
		harness.controller.notifyPaneExited({
			taskId: "t",
			paneId: "%1",
			completed: false,
			exitReason: scenario.exitReason,
			...scenario.extra,
		});
		assert.equal(harness.controller.shouldAttemptSurface(), true, `${scenario.label} không được tính là degrade`);
		assert.deepEqual(harness.events, []);
		assert.deepEqual(harness.revoked, []);
	}
	// completed bình thường: pane-closed + completed=true → sạch
	const harness = makeController("run-normal-complete");
	harness.controller.notifySpawned({ taskId: "t", paneId: "%2", provider: "tmux" });
	harness.controller.notifyPaneExited({ taskId: "t", paneId: "%2", completed: true, exitReason: "pane-closed" });
	assert.equal(harness.controller.shouldAttemptSurface(), true);
	assert.deepEqual(harness.events, []);
	assert.deepEqual(harness.revoked, []);
});

test("controller: 2 pane degrade khác tick cũng chỉ batch tại thời điểm áp reducer — snapshot tách bạch theo run", () => {
	const first = makeController("run-a");
	const second = makeController("run-b");
	first.controller.notifySpawned({ taskId: "1", paneId: "%a", provider: "tmux" });
	first.controller.notifyPaneExited({ taskId: "1", paneId: "%a", completed: false, exitReason: "pane-closed" });
	assert.equal(second.controller.livePaneCount(), 0);
	assert.equal(second.controller.shouldAttemptSurface(), true);
	assert.deepEqual(first.revoked, ["1"]);
});

test("registry: register/get/clear theo runId — không leak giữa các run", () => {
	__test__clearAllSurfaceControllers();
	const harness = makeController("run-reg");
	registerSurfaceRuntimeController(harness.controller);
	assert.equal(getSurfaceRuntimeController("run-reg")?.runId, "run-reg");
	assert.equal(getSurfaceRuntimeController(undefined), undefined);
	assert.equal(getSurfaceRuntimeController("other-run"), undefined);
	clearSurfaceRuntimeController("run-reg");
	assert.equal(getSurfaceRuntimeController("run-reg"), undefined);
	clearSurfaceRuntimeController("run-not-registered"); // no-op an toàn
});
