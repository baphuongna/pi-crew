/**
 * tmux SurfaceProvider (spec §4)
 *
 * Port surface logic nhánh tmux từ pi-interactive-subagents, viết lại theo
 * interface pi-crew. Trong team run (tabKey): một run = một window (tab),
 * worker split dọc/ngang xen kẽ tối đa MAX_PANES_PER_TAB pane. Ngoài run:
 * một worker = một pane split ngang từ pane cha ($TMUX_PANE) để pane đi theo
 * agent thay vì theo focus của user.
 * Launch command đã build sẵn ("bash <script-path>") — gửi vào pane qua
 * send-keys; script tự lo cwd (spec §5.2, Task 5).
 *
 * onExit: MỘT interval 2s cho cả provider — mỗi tick gọi list-panes đúng
 * một lần rồi đối chiếu mọi pane đang được theo dõi (không spawn N subprocess
 * cho N pane). Pane biến khỏi list hoặc pane_dead=1 → "pane-closed" bắn đúng
 * một lần. tmux call throw (binary mất đột ngột, server chết) → "mux-dead"
 * cho mọi handle còn sống.
 */

import { execFileSync } from "node:child_process";

import type { SurfaceDetection, SurfaceExitReason, SurfaceHandle, SurfaceProvider, SurfaceSpawnOpts } from "./surface-provider.ts";
import { MAX_PANES_PER_TAB, splitDirectionFor } from "./surface-provider.ts";

/** Chờ process trong pane chết sau SIGTERM trước khi force kill-pane (spec §4). */
const GRACEFUL_TERM_WAIT_MS = 3000;

/** Chu kỳ poll list-panes cho onExit (spec §4). */
const EXIT_POLL_INTERVAL_MS = 2000;

/** Timer handle trả về từ deps.schedule. */
export interface SurfaceTimer {
	clear(): void;
}

/** Dependencies injectable — mọi I/O đều thay được để unit test không chạm tmux thật. */
export interface TmuxProviderDeps {
	/** Chạy `tmux <args>`, trả stdout. Throw khi exit != 0 hoặc binary mất. */
	tmux?: (args: string[]) => string;
	/** Env nguồn TMUX / TMUX_PANE (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Ngủ chờ graceful close (default setTimeout). */
	sleep?: (ms: number) => Promise<void>;
	/** SIGTERM process trong pane theo pid (default process.kill SIGTERM). */
	killTree?: (pid: number) => void;
	/** Lập lịch poll onExit (default setInterval + unref). Test gọi tick thủ công. */
	schedule?: (fn: () => void, ms: number) => SurfaceTimer;
	/** Probe binary cho detect (default `command -v tmux`, có cache). */
	hasCommand?: (bin: string) => boolean;
}

/** Binary availability cache — `command -v` là subprocess, memoize như resolve-surface. */
const binaryAvailability = new Map<string, boolean>();

function defaultHasCommand(bin: string): boolean {
	const cached = binaryAvailability.get(bin);
	if (cached !== undefined) return cached;
	let available = false;
	try {
		execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
		available = true;
	} catch {
		available = false;
	}
	binaryAvailability.set(bin, available);
	return available;
}

function defaultSchedule(fn: () => void, ms: number): SurfaceTimer {
	const timer = setInterval(fn, ms);
	timer.unref();
	return { clear: () => clearInterval(timer) };
}

/** Một pane đang được theo dõi onExit. */
interface PaneWatcher {
	callbacks: Array<(reason: SurfaceExitReason) => void>;
	exited: boolean;
	reason?: SurfaceExitReason;
}

/** Parse `list-panes -F '#{pane_dead} #{pane_id}'` → Map id → dead. */
function parsePaneStatus(stdout: string): Map<string, boolean> {
	const status = new Map<string, boolean>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)$/);
		if (match) status.set(match[2], match[1] === "1");
	}
	return status;
}

/** Tìm pid của pane trong `list-panes -F '#{pane_pid} #{pane_id}'`. */
function findPanePid(stdout: string, paneId: string): number | null {
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)$/);
		if (match && match[2] === paneId) {
			const pid = Number(match[1]);
			return Number.isFinite(pid) ? pid : null;
		}
	}
	return null;
}

export function createTmuxProvider(deps: TmuxProviderDeps = {}): SurfaceProvider {
	const tmux = deps.tmux ?? ((args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }));
	const env = deps.env ?? process.env;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const killTree = deps.killTree ?? ((pid: number) => process.kill(pid, "SIGTERM"));
	const hasCommand = deps.hasCommand ?? defaultHasCommand;
	const schedule = deps.schedule ?? defaultSchedule;

	// Watcher theo pane id — MỘT timer chung cho mọi pane đang theo dõi.
	const watchers = new Map<string, PaneWatcher>();
	let timer: SurfaceTimer | null = null;

	// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey(run) → MỌI window
	// của run + số pane đã spawn trong window đang nhận. Tab mở khi run spawn
	// worker đầu, KHÔNG đóng khi từng worker xong — chỉ đóng khi run end
	// (closeTab, Task 5). Giữ array vì run dài có thể vượt MAX_PANES_PER_TAB
	// và mở window kế — closeTab phải dọn cả window cũ, không chỉ window cuối.
	const tabWindows = new Map<string, { windows: string[]; paneCount: number }>();

	function activeWatchers(): number {
		let active = 0;
		for (const watcher of watchers.values()) if (!watcher.exited) active += 1;
		return active;
	}

	function ensureTimer(): void {
		if (timer || activeWatchers() === 0) return;
		timer = schedule(pollExits, EXIT_POLL_INTERVAL_MS);
	}

	function maybeStopTimer(): void {
		if (!timer || activeWatchers() > 0) return;
		timer.clear();
		timer = null;
	}

	/** Bắn reason MỘT lần cho mọi callback của pane (copy list — cb có thể dispose). */
	function fire(paneId: string, reason: SurfaceExitReason): void {
		const watcher = watchers.get(paneId);
		if (!watcher || watcher.exited) return;
		watcher.exited = true;
		watcher.reason = reason;
		for (const cb of [...watcher.callbacks]) cb(reason);
		maybeStopTimer();
	}

	function pollExits(): void {
		let stdout: string;
		try {
			// -a: liệt kê panes toàn server — pane id là duy nhất toàn server,
			// còn không -a thì chỉ thấy current window (pane-closed giả khi user
			// switch window giữa chừng).
			stdout = tmux(["list-panes", "-a", "-F", "#{pane_dead} #{pane_id}"]);
		} catch {
			// tmux binary mất đột ngột / server chết — mọi handle còn sống thành mux-dead.
			for (const paneId of [...watchers.keys()]) fire(paneId, "mux-dead");
			return;
		}
		const status = parsePaneStatus(stdout);
		for (const [paneId, watcher] of [...watchers]) {
			// Không có trong list (đã dọn) hoặc pane_dead=1 → đóng.
			if (!watcher.exited && status.get(paneId) !== false) fire(paneId, "pane-closed");
		}
	}

	function makeHandle(paneId: string, tabId?: string): SurfaceHandle {
		return {
			id: paneId,
			kind: "tmux",
			...(tabId ? { tabId } : {}),
			onExit(cb) {
				let watcher = watchers.get(paneId);
				if (!watcher) {
					watcher = { callbacks: [], exited: false };
					watchers.set(paneId, watcher);
				}
				watcher.callbacks.push(cb);
				// Đăng ký sau exit → replay reason ngay để không mất event.
				if (watcher.exited) {
					cb(watcher.reason as SurfaceExitReason);
					return;
				}
				ensureTimer();
			},
			dispose() {
				const watcher = watchers.get(paneId);
				if (!watcher) return;
				// Host chủ động dispose khi pane còn sống → "detached" cho listener.
				if (!watcher.exited) fire(paneId, "detached");
				watchers.delete(paneId);
				maybeStopTimer();
			},
		};
	}

	function assertTmuxHandle(handle: SurfaceHandle): void {
		if (handle.kind !== "tmux") {
			throw new Error(`Expected a tmux handle, got kind "${handle.kind}" (id ${handle.id})`);
		}
	}

	/** Pane còn trong list (toàn server) và chưa dead. tmux throw (mux chết) → false. */
	function isPaneAlive(paneId: string): boolean {
		try {
			return parsePaneStatus(tmux(["list-panes", "-a", "-F", "#{pane_dead} #{pane_id}"])).get(paneId) === false;
		} catch {
			return false;
		}
	}

	/** kill-pane best-effort — pane có thể tự chết trong lúc chờ SIGTERM. */
	function killPaneBestEffort(paneId: string): void {
		try {
			tmux(["kill-pane", "-t", paneId]);
		} catch {
			// Pane đã mất — coi như đã đóng.
		}
	}

	return {
		kind: "tmux",

		detect(): SurfaceDetection {
			if (!env.TMUX) {
				return { ok: false, reason: "TMUX env not set — pi is not running inside a tmux session" };
			}
			if (!hasCommand("tmux")) {
				return { ok: false, reason: "tmux binary not found on PATH" };
			}
			return { ok: true, kind: "tmux" };
		},

		async createSurface(_name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle> {
			let targetWindow: string;
			let directionFlag: string;
			// Task 5: window (tab) chứa pane này — None khi đường legacy.
			let tabId: string | undefined;
			// Tab-map chỉ ghi sau khi split-window THÀNH CÔNG — nếu split fail,
			// paneCount không đếm pane không tồn tại (luân phiên không lệch bước
			// ở lần retry kế tiếp).
			let commitTabPane: (() => void) | null = null;
			if (opts.tabKey) {
				// Tab-layout: mọi worker của cùng run chia 1 window (tab), split
				// dọc/ngang xen kẽ theo pane index trong tab (spec tab-layout §4).
				const tabKey = opts.tabKey;
				const existing = tabWindows.get(tabKey);
				if (existing && existing.paneCount < MAX_PANES_PER_TAB) {
					const paneIndexInTab = existing.paneCount;
					const currentWindowId = existing.windows[existing.windows.length - 1] as string;
					targetWindow = currentWindowId;
					tabId = currentWindowId;
					directionFlag = splitDirectionFor(paneIndexInTab) === "down" ? "-v" : "-h";
					commitTabPane = () => {
						existing.paneCount = paneIndexInTab + 1;
					};
				} else {
					// Tab mới cho run (hoặc tab cũ đã đầy MAX_PANES_PER_TAB) — window riêng.
					// -d: window mới không thành current window — không steal focus client.
					const windowId = tmux(["new-window", "-d", "-P", "-F", "#{window_id}"]).trim();
					if (!/^@\d+$/.test(windowId)) {
						throw new Error(`Unexpected tmux new-window output: ${JSON.stringify(windowId)}`);
					}
					const label = opts.title ?? tabKey;
					try {
						tmux(["rename-window", "-t", windowId, label]);
					} catch {
						// rename là cosmetic — pane vẫn dùng được.
					}
					targetWindow = windowId;
					tabId = windowId;
					directionFlag = splitDirectionFor(0) === "down" ? "-v" : "-h";
					const priorWindows = existing?.windows ?? [];
					commitTabPane = () => {
						tabWindows.set(tabKey, { windows: [...priorWindows, windowId], paneCount: 1 });
					};
				}
			} else {
				// Đường legacy (spawn ngoài run): split từ pane cha để pane đi theo
				// agent, không theo focus của user — giữ nguyên "-h" như trước.
				const parentPane = env.TMUX_PANE;
				if (!parentPane) {
					throw new Error("TMUX_PANE not set — tmux provider chỉ chạy bên trong tmux session");
				}
				targetWindow = parentPane;
				directionFlag = "-h";
			}
			const raw = tmux(["split-window", "-d", directionFlag, "-P", "-F", "#{pane_id}", "-t", targetWindow]);
			const paneId = raw.trim();
			if (!/^%\d+$/.test(paneId)) {
				throw new Error(`Unexpected tmux split-window output: ${JSON.stringify(raw)}`);
			}
			commitTabPane?.();
			if (opts.title) {
				try {
					tmux(["select-pane", "-t", paneId, "-T", opts.title]);
				} catch {
					// Title là cosmetic — pane vẫn dùng được.
				}
			}
			// Command đã build sẵn ("bash <script-path>") — gửi literal rồi Enter.
			// Commandless tạo pane là hợp lệ (spec §13.1: host cần pane id trước,
			// build script xong mới boot worker qua sendCommand) — không gửi gì cả.
			if (opts.command !== undefined) {
				tmux(["send-keys", "-t", paneId, "-l", opts.command]);
				tmux(["send-keys", "-t", paneId, "Enter"]);
			}
			return makeHandle(paneId, tabId);
		},

		async sendCommand(handle, text) {
			assertTmuxHandle(handle);
			// Gửi literal text (không tmux-interpreted) rồi Enter — giống cách
			// createSurface gửi command người dùng gõ được.
			tmux(["send-keys", "-t", handle.id, "-l", text]);
			tmux(["send-keys", "-t", handle.id, "Enter"]);
		},

		attach(id: string): SurfaceHandle | null {
			let status: Map<string, boolean>;
			try {
				status = parsePaneStatus(tmux(["list-panes", "-a", "-F", "#{pane_dead} #{pane_id}"]));
			} catch {
				return null;
			}
			if (status.get(id) !== false) return null;
			return makeHandle(id);
		},

		async readScreen(handle: SurfaceHandle, lines = 50): Promise<string> {
			assertTmuxHandle(handle);
			// Pane mất → tmux exit != 0 → throw (spec: throw khi handle không hợp lệ).
			return tmux(["capture-pane", "-p", "-t", handle.id, "-S", `-${Math.max(1, lines)}`]);
		},

		async closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void> {
			assertTmuxHandle(handle);
			if (opts?.force) {
				killPaneBestEffort(handle.id);
				return;
			}
			// Graceful (spec §4): SIGTERM pid trong pane → đợi 3s → force kill-pane.
			if (!isPaneAlive(handle.id)) return; // đã đóng — idempotent
			const pid = findPanePid(tmux(["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]), handle.id);
			// pid > 1: pid 0/1 không bao giờ là process của pane — không signal.
			// Không tìm được pid thì SIGTERM không thể → force luôn, không đợi vô ích.
			if (pid !== null && pid > 1) {
				killTree(pid);
				await sleep(GRACEFUL_TERM_WAIT_MS);
			}
			if (isPaneAlive(handle.id)) killPaneBestEffort(handle.id);
		},

		/**
		 * Task 5 (spec tab-layout §5): run end → kill MỌI window của run theo
		 * map nội bộ (run dài >8 pane mở window kế — cả hai đều phải chết).
		 * Window đã tự đóng từ trước (pane cuối tự exit làm window biến mất)
		 * → kill-window throw → nuốt: idempotent.
		 */
		async closeTab(tabKey: string): Promise<void> {
			const entry = tabWindows.get(tabKey);
			if (!entry) return;
			tabWindows.delete(tabKey);
			for (const windowId of entry.windows) {
				try {
					tmux(["kill-window", "-t", windowId]);
				} catch {
					// window đã mất — coi như đã đóng.
				}
			}
		},
	};
}
