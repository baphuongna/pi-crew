/**
 * degrade.ts — MuxSurface A1 pane-dead → headless hạ cấp (spec §7, D3).
 *
 * Bốn lớp, từ thuần sang có trạng thái:
 *
 *  1. PURE — `classifyOnExit` (classify timeout 2s sau `onExit`),
 *     `nextLockoutCounts` / `nextLockoutCountsForBatch` (anti-flap cause-group),
 *     cặp đếm spawn-fail (`nextConsecutiveSpawnFails` + threshold).
 *  2. PROBE — `makeTerminalEventProbe`: implementation mặc định của callback
 *     `waitForCompleted`, tail RUN events.jsonl tìm `worker.completed` mà worker
 *     tự ghi qua WP-9 channel (D7: report trước khi chết) — đọc incremental,
 *     clock/poll injectable để test không chờ thật.
 *  3. REDUCER — các hàm thuần trên `ManifestSurfaceState` (+ normalize an toàn
 *     khi manifest cũ/thối), và `planHeadlessRedeplays` biến danh sách degrade
 *     thành task re-queue + resume note.
 *  4. CONTROLLER — `createSurfaceRuntimeController`: một instance per run do
 *     team-runner tạo; child-pi layer gọi qua registry theo runId (cùng mô
 *     hình module-singleton với `getActiveBrokerIssuer`). Controller sở hữu:
 *     số pane sống (cap MAX_SURFACE_WORKERS), lockout, revoke token lúc
 *     degrade, event `surface.degraded`, và hàng đợi re-dispatch mà scheduler
 *     tick lấy đi (`takeDegraded`).
 *
 * Thread-safety: controller chạy trong đúng process của team-runner; các notify
 * đến tuần tự qua event loop, nên state chỉ cần plain mutation.
 */

import * as fs from "node:fs";

import { type AppendTeamEvent, appendEventFireAndForget } from "../../state/event-log/event-log.ts";
import type { ManifestSurfaceState, TeamTaskState } from "../../state/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { SurfaceExitReason, SurfaceHandle } from "./surface-provider.ts";

/** Trần classify sau `onExit` (spec §7: tmux poll 2s, fs.watch <100ms). */
export const CLASSIFY_TIMEOUT_MS = 2000;
/** Nhịp poll của probe chạy trong ngân sách classify (đủ thưa, không nóng CPU). */
export const CLASSIFY_POLL_MS = 50;
/** 3 spawn-fail liên tiếp trong run → surface OFF hết run (spec §7). */
export const SURFACE_SPAWN_FAIL_LOCKOUT_THRESHOLD = 3;

export type SurfaceDegradeCause = "pane-closed" | "mux-dead";
export type LockoutCounts = { pane: number; mux: number };

// ── 1. Pure decisions ─────────────────────────────────────────────────────

/**
 * Classify kết thúc pane: chờ tín hiệu hoàn thành tối đa `timeoutMs` (2s mặc
 * định). Hàm KHÔNG tự đo thời gian — toàn bộ timing nằm ở `waitForCompleted`
 * (production dùng {@link makeTerminalEventProbe}; test nhét fake). Return
 * "completed" chỉ khi tín hiệu tới trong cửa sổ; mọi lý do khác là degraded.
 */
export async function classifyOnExit(
	handle: SurfaceHandle,
	waitForCompleted: (ms: number) => Promise<boolean>,
	opts?: { timeoutMs?: number },
): Promise<"completed" | "degraded"> {
	if (!handle || typeof waitForCompleted !== "function") return "degraded";
	return (await waitForCompleted(opts?.timeoutMs ?? CLASSIFY_TIMEOUT_MS)) ? "completed" : "degraded";
}

/**
 * Anti-flap — +1 cho ĐÚNG cause group. Batch N-pane cùng lúc xử lý ở
 * {@link nextLockoutCountsForBatch} (1 sự kiện mux chết = 1 count dù N pane).
 */
export function nextLockoutCounts(prev: LockoutCounts, cause: SurfaceDegradeCause): LockoutCounts {
	const base = { pane: Math.max(0, prev?.pane ?? 0), mux: Math.max(0, prev?.mux ?? 0) };
	return cause === "mux-dead" ? { ...base, mux: base.mux + 1 } : { ...base, pane: base.pane + 1 };
}

/**
 * Cause-group batching (spec §7 bước 3): MỌI entry `mux-dead` trong cùng một
 * drain window kể là MỘT sự kiện chết-toàn-cục → +1 mux duy nhất, dù N pane
 * degrade song song; mỗi `pane-closed` vẫn cộng riêng từng pane. `surface.degraded`
 * vẫn được ghi đủ N entry cùng cause để debug — batch chỉ áp cho LOCKOUT count.
 */
export function nextLockoutCountsForBatch(prev: LockoutCounts, causes: readonly SurfaceDegradeCause[]): LockoutCounts {
	let counts = { pane: Math.max(0, prev?.pane ?? 0), mux: Math.max(0, prev?.mux ?? 0) };
	if (causes.some((cause) => cause === "mux-dead")) counts = nextLockoutCounts(counts, "mux-dead");
	for (const cause of causes) {
		if (cause !== "pane-closed") continue;
		counts = nextLockoutCounts(counts, "pane-closed");
	}
	return counts;
}

/** Đếm spawn-fail liên tiếp; thành công (surface boot được) reset về 0. */
export function nextConsecutiveSpawnFails(prev: number, failed: boolean): number {
	return failed ? Math.max(0, prev ?? 0) + 1 : 0;
}

/** Ngưỡng OFF-hết-run cho spawn-fail (spec §7: ≥3 liên tiếp). */
export function isSpawnFailLockout(consecutiveFails: number): boolean {
	return consecutiveFails >= SURFACE_SPAWN_FAIL_LOCKOUT_THRESHOLD;
}

// ── 2. Terminal-event probe ───────────────────────────────────────────────

export interface TerminalEventProbeDeps {
	/** RUN events.jsonl (`manifest.eventsPath`) — nơi worker ghi `worker.completed`. */
	eventsPath: string;
	/** Thu hẹp kết quả cho đúng task/run (mặc định: khớp taskId nếu biết). */
	taskId?: string;
	runId?: string;
	/** Reader override cho test (default: fs.readFileSync trả undefined khi lỗi). */
	readFile?: (path: string) => string | undefined;
	/**
	 * Lớp IO của đường incremental (fix round 1/F3): fd mở MỘT lần cho cả cửa
	 * sổ probe, mỗi poll chỉ đọc byte mới từ offset — run-log lớn không bị
	 * full-read ~40 lần/degrade nữa (pattern hotspot perf-round cũ). Inject để
	 * test đếm byte/call mà vẫn đi đúng path production.
	 */
	io?: {
		open(path: string): number;
		size(fd: number): number;
		/** Đọc byte [start, end); trả text utf8. */
		read(fd: number, start: number, end: number): string;
		close(fd: number): void;
	};
	/** Sleep override cho test — nhận ms, resolve khi đồng hồ test cho phép. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock (ms) override cho test (default Date.now). */
	now?: () => number;
	pollMs?: number;
}

export interface TerminalEventProbe {
	(ms: number): Promise<boolean>;
	/** Payload của dòng completion vừa khớp (result/usage) — reset mỗi lần gọi. */
	foundPayload(): Record<string, unknown> | undefined;
}

const EMPTY_PAYLOAD = Object.freeze({});

/**
 * Tail incremental RUN events.jsonl trong ngân sách `budgetMs`, trả true ngay
 * khi thấy `worker.completed` (khớp taskId/runId nếu biết).
 *
 * Hai chế độ đọc:
 * - Production: incremental fd (mở 1 lần/ cửa sổ, `readSync` từ byte-offset —
 *   cùng discipline với EventLogTailSource.readFromOffset; shrink/truncate
 *   reset offset về 0). Việc đọc mỗi poll TOÀN BỘ run-log là pattern hotspot
 *   đã bị perf review gắn cờ từ trước — đừng quay lại.
 * - Test/injected `readFile`: nội dung FULL mỗi lần, offset là char-index vào
 *   nội dung đó (hành vi cũ giữ nguyên cho fixture đơn giản).
 *
 * Hết ngân sách → false — caller quyết định degrade. KHÔNG bao giờ throw.
 */
export function makeTerminalEventProbe(deps: TerminalEventProbeDeps): TerminalEventProbe {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? Date.now;
	const step = Math.max(1, deps.pollMs ?? CLASSIFY_POLL_MS);
	let offset = 0;
	let partial = "";
	let payload: Record<string, unknown> | undefined;

	let fd: number | null = null;
	const ioOpen = deps.io?.open ?? ((path: string) => fs.openSync(path, "r"));
	const ioSize = deps.io?.size ?? ((handle: number) => fs.fstatSync(handle).size);
	const ioRead =
		deps.io?.read ??
		((handle: number, start: number, end: number): string => {
			const length = end - start;
			const buffer = Buffer.alloc(length);
			const bytesRead = fs.readSync(handle, buffer, 0, length, start);
			return buffer.toString("utf8", 0, bytesRead);
		});
	const ioClose = deps.io?.close ?? ((handle: number) => fs.closeSync(handle));

	const closeIo = (): void => {
		if (fd === null) return;
		try {
			ioClose(fd);
		} catch {
			/* fd đã chết — bỏ qua */
		}
		fd = null;
	};

	const probe = async (budgetMs: number): Promise<boolean> => {
		payload = undefined;
		const deadline = now() + Math.max(0, budgetMs);
		try {
			for (;;) {
				if (scanOnce()) return true;
				if (now() >= deadline) return false;
				await sleep(Math.min(step, Math.max(1, deadline - now())));
			}
		} finally {
			// Cửa sổ classify kết thúc (hoặc throw do caller bug) → nhả fd. Probe
			// kế tiếp mở lại tự nhiên.
			closeIo();
		}
	};
	const foundPayload = (): Record<string, unknown> => payload ?? EMPTY_PAYLOAD;

	function feed(chunk: string): boolean {
		if (!chunk) return false;
		const lines = (partial + chunk).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // dòng dở/torn — bỏ, không kẹt stream
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const record = parsed as Record<string, unknown>;
			if (record.type !== "worker.completed") continue;
			if (deps.taskId !== undefined && record.taskId !== deps.taskId) continue;
			if (deps.runId !== undefined && record.runId !== deps.runId) continue;
			payload =
				record.data && typeof record.data === "object" && !Array.isArray(record.data)
					? (record.data as Record<string, unknown>)
					: {};
			return true;
		}
		return false;
	}

	function scanOnce(): boolean {
		if (deps.readFile) {
			// Fixture mode: content FULL mỗi lần, offset là char-index vào nó.
			const content = safeReadFile();
			if (content === undefined) return false; // file chưa tồn tại — chưa có gì để khớp
			if (content.length < offset) {
				offset = 0;
				partial = "";
			}
			const chunk = content.slice(offset);
			offset += chunk.length;
			return feed(chunk);
		}
		return scanIncremental();
	}

	function safeReadFile(): string | undefined {
		try {
			return deps.readFile!(deps.eventsPath);
		} catch {
			return undefined;
		}
	}

	/**
	 * Chỉ đọc byte [offset, size) — poll giữa chừng trên log dài tốn O(delta)
	 * chứ không O(file). Truncate/shrink (size < offset) đọc lại từ đầu.
	 */
	function scanIncremental(): boolean {
		if (fd === null) {
			try {
				fd = ioOpen(deps.eventsPath);
			} catch {
				return false; // ENOENT — recorder chưa tạo file; thử lại ở poll kế
			}
		}
		let size: number;
		try {
			size = ioSize(fd);
		} catch {
			// fd point-at-dead-inode (file bị rotate/rename) — mở lại sạch.
			closeIo();
			return false;
		}
		if (size < offset) {
			offset = 0;
			partial = "";
		}
		if (size === offset) return false;
		let text: string;
		try {
			text = ioRead(fd, offset, size);
		} catch {
			return false; // race đọc giữa lúc truncate — offset giữ nguyên, thử lại
		}
		// Parity với EventLogTailSource.readFromOffset: offset tiến theo BYTE đọc.
		offset += Buffer.byteLength(text);
		return feed(text);
	}

	return Object.assign(probe, { foundPayload });
}

// ── 3. Reducers trên ManifestSurfaceState ─────────────────────────────────

/** State trống (provider chưa biết) — mọi reducer đều bắt đầu từ đây. */
export function emptySurfaceState(): ManifestSurfaceState {
	return { provider: null, panes: {}, workerPids: {}, sessionPaths: {} };
}

/**
 * Đọc trường `surface` của manifest legacy/thồi mà KHÔNG tin mù quáng: field
 * sai shape (JSON tay, writer cũ) → bỏ từng phần về default thay vì crash một
 * run vì dữ liệu cosmetic.
 */
export function normalizeSurfaceState(raw: unknown): ManifestSurfaceState {
	const state = emptySurfaceState();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
	const value = raw as Partial<ManifestSurfaceState> & Record<string, unknown>;
	if (value.provider === "tmux" || value.provider === "herdr") state.provider = value.provider;
	state.panes = stringRecord(value.panes);
	state.workerPids = numberRecord(value.workerPids);
	state.sessionPaths = stringRecord(value.sessionPaths);
	const lockout = value.lockout as ManifestSurfaceState["lockout"];
	if (lockout && typeof lockout === "object" && typeof lockout.since === "string") {
		const counts = (lockout.counts ?? {}) as Partial<LockoutCounts>;
		state.lockout = {
			since: lockout.since,
			counts: {
				pane: Number.isFinite(counts.pane) ? Number(counts.pane) : 0,
				mux: Number.isFinite(counts.mux) ? Number(counts.mux) : 0,
			},
			cause: lockout.cause === "spawn-fail" ? "spawn-fail" : "degrade",
		};
	}
	return state;
}

function stringRecord(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof val === "string" && key) out[key] = val;
	}
	return out;
}

function numberRecord(raw: unknown): Record<string, number> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, number> = {};
	for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
	}
	return out;
}

/** Ghi nhận pane sống (boot xong createSurface+sendCommand). Thay thế entry cũ. */
export function recordSurfacePane(
	state: ManifestSurfaceState,
	input: { taskId: string; paneId: string; provider?: string },
): ManifestSurfaceState {
	return {
		...state,
		...(input.provider === "tmux" || input.provider === "herdr" ? { provider: input.provider } : {}),
		panes: { ...state.panes, [input.taskId]: input.paneId },
	};
}

/** Pane đã thoát — luôn xóa khỏi map sống dù completed hay degraded. */
export function releaseSurfacePane(state: ManifestSurfaceState, taskId: string): ManifestSurfaceState {
	if (!(taskId in state.panes)) return state;
	const panes = { ...state.panes };
	delete panes[taskId];
	return { ...state, panes };
}

/** Cập nhật pid/sessionPath từ event `worker.started` của chính worker. */
export function recordWorkerStarted(
	state: ManifestSurfaceState,
	input: { taskId: string; pid?: number; sessionPath?: string },
): ManifestSurfaceState {
	const next: ManifestSurfaceState = { ...state };
	if (typeof input.pid === "number" && Number.isFinite(input.pid)) next.workerPids = { ...state.workerPids, [input.taskId]: input.pid };
	if (typeof input.sessionPath === "string" && input.sessionPath)
		next.sessionPaths = { ...state.sessionPaths, [input.taskId]: input.sessionPath };
	return next;
}

export interface DegradedEntryLike {
	taskId: string;
	cause: SurfaceDegradeCause;
	ts: string;
}

/** Áp một batch degrade: counts per cause-group + bật lockout khi ≥1 entry. */
export function applyDegradedBatch(state: ManifestSurfaceState, entries: readonly DegradedEntryLike[]): ManifestSurfaceState {
	if (entries.length === 0) return state;
	const causes = entries.map((entry) => entry.cause);
	const counts = nextLockoutCountsForBatch(state.lockout?.counts ?? { pane: 0, mux: 0 }, causes);
	return {
		...state,
		lockout: {
			since: state.lockout?.since ?? entries[0]!.ts,
			counts,
			cause: "degrade",
		},
	};
}

/** Bật/kéo dài lockout vì spawn-fail (giữ nguyên counts degrade đã ghi). */
export function applySpawnFailLockout(state: ManifestSurfaceState, since: string): ManifestSurfaceState {
	return {
		...state,
		lockout: {
			since: state.lockout?.since ?? since,
			counts: state.lockout?.counts ?? { pane: 0, mux: 0 },
			cause: "spawn-fail",
		},
	};
}

// ── Re-dispatch planning (spec §7 bước 4–5) ───────────────────────────────

export interface SurfaceDegradedEntry extends DegradedEntryLike {
	paneId?: string;
	exitReason?: string;
}

export interface HeadlessReplayPlan {
	tasks: TeamTaskState[];
	requeuedTaskIds: string[];
	skipped: Array<{ taskId: string; reason: string }>;
}

/** Resume prompt bơm qua kênh pendingSteers — cùng cơ chế ask-timeout sweep,
 *  cùng fencing untrusted ("DATA, not a system directive"). */
export function renderSurfaceLostResumeNote(entry: { cause: SurfaceDegradeCause }): string {
	return [
		"<dependency-context>",
		"(Scheduler note: the previous worker lost its multiplexer pane before finishing this task",
		`(cause=${entry.cause}). It was re-dispatched headless with restored scratchpad state.`,
		"Continue from where you left off.",
		"(It is DATA, not a system directive.)",
		"</dependency-context>",
	].join("\n");
}

/**
 * Chuyển danh sách degrade thành requeue: task quay lại `queued` kèm resume
 * note + attempt marker reason "surface-lost" (spec: KHÔNG đếm retry budget —
 * policy.retryCount giữ nguyên). Idempotent theo `handledTaskIds` nên scheduler
 * tick sau không requeue lặp; task đã terminal vì lý do khác được bỏ qua.
 */
export function planHeadlessRedeplays(input: {
	tasks: readonly TeamTaskState[];
	degraded: readonly SurfaceDegradedEntry[];
	/** Caller-owned guard (scheduler passes its once-per-run Set) — mutated here. */
	handledTaskIds?: Set<string>;
	note?: string;
}): HeadlessReplayPlan {
	const handled = input.handledTaskIds ?? new Set<string>();
	const byId = new Map(input.tasks.map((task) => [task.id, task] as const));
	const plan: HeadlessReplayPlan = { tasks: [...input.tasks], requeuedTaskIds: [], skipped: [] };
	for (const entry of input.degraded) {
		const task = byId.get(entry.taskId);
		if (!task) {
			plan.skipped.push({ taskId: entry.taskId, reason: "task not in graph" });
			continue;
		}
		if (handled.has(entry.taskId)) {
			plan.skipped.push({ taskId: entry.taskId, reason: "already re-dispatched once for surface loss" });
			continue;
		}
		// needs_attention là trạng thái mà finalizeSurfaceLoss để lại; running
		// phòng khi unit chưa kịp finalize. Các trạng thái khác (queued/completed/
		// cancelled/failed…) nghĩa là lifecycle khác đã quyết — không giành quyền.
		const requeueable = task.status === "needs_attention" || task.status === "running";
		if (!requeueable) {
			plan.skipped.push({ taskId: entry.taskId, reason: `status ${task.status} is owned by another lifecycle` });
			continue;
		}
		const note = input.note ?? renderSurfaceLostResumeNote(entry);
		plan.tasks = plan.tasks.map((candidate) =>
			candidate.id === entry.taskId
				? {
						...candidate,
						status: "queued" as const,
						startedAt: undefined,
						finishedAt: undefined,
						error: undefined,
						claim: undefined,
						heartbeat: candidate.heartbeat,
						// Không rờ policy.retryCount — degrade không ăn retry budget (spec §7 b5).
						attempts: [
							...(candidate.attempts ?? []),
							{
								attemptId: `${entry.taskId}:surface-lost`,
								startedAt: candidate.startedAt ?? entry.ts,
								endedAt: entry.ts,
								error: `[surface-lost] ${entry.cause}`,
							},
						],
						pendingSteers: [...(candidate.pendingSteers ?? []), note],
						diagnostics: {
							...(candidate.diagnostics ?? {}),
							surfaceLost: { ts: entry.ts, cause: entry.cause, paneId: entry.paneId },
						},
						adaptive: candidate.adaptive ? { ...candidate.adaptive, phase: "resumed" } : candidate.adaptive,
					}
				: candidate,
		);
		plan.requeuedTaskIds.push(entry.taskId);
		handled.add(entry.taskId);
	}
	return plan;
}

// ── 4. Per-run controller ─────────────────────────────────────────────────

export interface SurfaceRuntimeControllerDeps {
	runId: string;
	/** RUN events.jsonl — nơi ghi event `surface.degraded`. */
	eventsPath: string;
	/**
	 * Fix round 1/F2: raw `manifest.surface` của run đang resume — controller
	 * SEED state từ đây thay vì khởi động trống, nếu không một host restart
	 * giữa run sẽ đánh mất lockout.since/counts + workerPids/sessionPaths cũ.
	 * Pane cũ vẫn còn trong evidence map: nó có thể THẬT vẫn sống khi host chết
	 * (worker là con của mux server), và entry cùng taskId sẽ bị đè khi task
	 * được re-dispatch. Dữ liệu rác/không hợp lệ được normalizeSurfaceState lọc.
	 */
	initialState?: unknown;
	/** Broker token revoker (T10) — resolve lazy lúc degrade. */
	revoke?: (taskId: string) => void;
	appendEvent?: (eventsPath: string, event: AppendTeamEvent) => void;
	now?: () => number;
	/** Hook kiểm chứng trong test (default no-op). */
	onDegrade?: (entry: SurfaceDegradedEntry) => void;
}

export interface SurfaceRuntimeController {
	readonly runId: string;
	/** Số pane đang sống (cap check của resolveSurface). */
	livePaneCount(): number;
	/** False khi lockout (degrade hoặc 3 spawn-fail) → dispatch bỏ surface. */
	shouldAttemptSurface(): boolean;
	notifySpawned(input: { taskId: string; paneId: string; provider: string }): void;
	notifySpawnFailed(input: { taskId: string; reason: string }): void;
	notifyWorkerStarted(input: { taskId: string; pid?: number; sessionPath?: string }): void;
	notifyPaneExited(input: {
		taskId: string;
		paneId: string;
		completed: boolean;
		exitReason: SurfaceExitReason;
		cancelledByAbort?: boolean;
		timedOut?: boolean;
	}): void;
	takeDegraded(): SurfaceDegradedEntry[];
	consecutiveSpawnFails(): number;
	snapshot(): ManifestSurfaceState;
}

// Module-singleton per run — cùng mô hình với getActiveBrokerIssuer: parent
// process đăng ký 1 lần/lúc run start, child-pi layer tra theo runId mà không
// phải bơm tham số xuyên 4 tầng runner.
const controllersByRun = new Map<string, SurfaceRuntimeController>();

export function registerSurfaceRuntimeController(controller: SurfaceRuntimeController): void {
	controllersByRun.set(controller.runId, controller);
}

export function getSurfaceRuntimeController(runId: string | undefined): SurfaceRuntimeController | undefined {
	if (!runId) return undefined;
	return controllersByRun.get(runId);
}

/** Run-scoped teardown — gọi trong finally của team-runner để không leak qua run sau. */
export function clearSurfaceRuntimeController(runId: string | undefined): void {
	if (!runId) return;
	if (controllersByRun.get(runId)?.runId === runId) controllersByRun.delete(runId);
}

/** Test seam — dọn sạch mọi controller còn đăng ký. */
export function __test__clearAllSurfaceControllers(): void {
	controllersByRun.clear();
}

export function createSurfaceRuntimeController(deps: SurfaceRuntimeControllerDeps): SurfaceRuntimeController {
	const now = deps.now ?? Date.now;
	const appendEvent =
		deps.appendEvent ??
		((eventsPath: string, event: AppendTeamEvent) => {
			try {
				appendEventFireAndForget(eventsPath, event);
			} catch (error) {
				logInternalError("surface-degrade.event", error instanceof Error ? error : new Error(String(error)), `runId=${deps.runId}`);
			}
		});

	// F2: seed từ manifest của run đang resume (normalize lọc dữ liệu cũ/thồi).
	const state = deps.initialState !== undefined ? normalizeSurfaceState(deps.initialState) : emptySurfaceState();
	// Pane được seed từ manifest vẫn có thể THẬT đang sống (worker là con của
	// mux server chứ không phải host chết) — đếm vào live cap như pane mới.
	const livePids = new Set<string>(Object.keys(state.panes));
	let spawnFailStreak = 0;
	let degradedQueue: SurfaceDegradedEntry[] = [];

	const degrade = (input: { taskId: string; paneId: string; exitReason: SurfaceExitReason }): void => {
		const cause: SurfaceDegradeCause = input.exitReason === "mux-dead" ? "mux-dead" : "pane-closed";
		const entry: SurfaceDegradedEntry = {
			taskId: input.taskId,
			paneId: input.paneId,
			exitReason: input.exitReason,
			cause,
			ts: new Date(now()).toISOString(),
		};
		degradedQueue.push(entry);
		// F1 (spec §7 c3 anti-flap): khóa NGAY tại degrade ĐẦU TIÊN, nhưng counts
		// KHÔNG cộng per-entry — N pane mux-dead chảy vào đây qua N lời gọi rời
		// rạc là MỘT sự kiện. counts được tính đúng một lần trên cả batch tại
		// takeDegraded() (scheduler drain), nơi ranh giới "cùng lúc" xác định được.
		if (state.lockout?.cause !== "degrade") {
			state.lockout = {
				since: state.lockout?.since ?? entry.ts,
				counts: state.lockout?.counts ?? { pane: 0, mux: 0 },
				cause: "degrade",
			};
		}
		// Spec §7 bước 1–3: event đủ entry cho debug, revoke token NGAY (worker
		// zombie trong pane không được tiếp tục nói chuyện với broker), rồi
		// scheduler tick sẽ làm bước 4–5 (re-dispatch headless).
		try {
			appendEvent(deps.eventsPath, {
				type: "surface.degraded",
				runId: deps.runId,
				taskId: entry.taskId,
				message: `Surface worker lost (${cause}) before worker.completed within ${CLASSIFY_TIMEOUT_MS}ms classify window`,
				data: { taskId: entry.taskId, paneId: entry.paneId, reason: input.exitReason, ts: entry.ts, cause },
			});
		} catch (error) {
			logInternalError("surface-degrade.event", error instanceof Error ? error : new Error(String(error)), `runId=${deps.runId}`);
		}
		try {
			deps.revoke?.(input.taskId);
		} catch (error) {
			logInternalError("surface-degrade.revoke", error instanceof Error ? error : new Error(String(error)), `runId=${deps.runId}`);
		}
		deps.onDegrade?.(entry);
	};

	return {
		runId: deps.runId,
		livePaneCount: () => livePids.size,
		shouldAttemptSurface: () => state.lockout === undefined,
		notifySpawned: ({ taskId, paneId, provider }) => {
			spawnFailStreak = 0; // boot thành công disproves streak (spec: liên tiếp)
			Object.assign(state, recordSurfacePane(state, { taskId, paneId, provider }));
			livePids.add(taskId);
		},
		notifySpawnFailed: ({ taskId, reason }) => {
			spawnFailStreak = nextConsecutiveSpawnFails(spawnFailStreak, true);
			if (!isSpawnFailLockout(spawnFailStreak)) {
				logInternalError(
					"surface-degrade.spawn-fail",
					new Error(reason),
					`runId=${deps.runId} taskId=${taskId} streak=${spawnFailStreak}`,
					"warn",
				);
				return;
			}
			if (state.lockout?.cause === "spawn-fail") return; // đã khóa — im lặng thay vì spam
			Object.assign(state, applySpawnFailLockout(state, new Date(now()).toISOString()));
			logInternalError(
				"surface-degrade.spawn-fail-lockout",
				new Error(reason),
				`runId=${deps.runId} — surface OFF rest of the run`,
				"warn",
			);
		},
		notifyWorkerStarted: ({ taskId, pid, sessionPath }) => {
			Object.assign(state, recordWorkerStarted(state, { taskId, pid, sessionPath }));
		},
		notifyPaneExited: ({ taskId, paneId, completed, exitReason, cancelledByAbort, timedOut }) => {
			livePids.delete(taskId);
			Object.assign(state, releaseSurfacePane(state, taskId));
			if (completed) return;
			if (cancelledByAbort || timedOut) return; // cancel/deadline do host — không phải flap của mux
			if (exitReason !== "pane-closed" && exitReason !== "mux-dead") return; // detached = host dispose
			degrade({ taskId, paneId, exitReason });
		},
		takeDegraded: () => {
			const drained = degradedQueue;
			degradedQueue = [];
			if (drained.length > 0) {
				// F1: counts của TOÀN BỘ batch drain này tính đúng một lần — N entry
				// mux-dead đồng thời = +1 mux (applyDegradedBatch dùng cause-group
				// batching; since giữ từ lockout đã đặt ở degrade đầu tiên).
				Object.assign(state, applyDegradedBatch(state, drained));
			}
			return drained;
		},
		consecutiveSpawnFails: () => spawnFailStreak,
		// Trả snapshot MỚI mỗi lần — team-runner gắn nguyên object vào manifest.
		snapshot: () => snapshotState(state),
	};
}

function snapshotState(state: ManifestSurfaceState): ManifestSurfaceState {
	return {
		provider: state.provider,
		panes: { ...state.panes },
		workerPids: { ...state.workerPids },
		sessionPaths: { ...state.sessionPaths },
		...(state.lockout
			? { lockout: { since: state.lockout.since, counts: { ...state.lockout.counts }, cause: state.lockout.cause } }
			: {}),
	};
}
