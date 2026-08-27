/**
 * surface-spawn.ts — nhánh spawn pane (spec §13.1) của child-pi pipeline.
 *
 * `prepareSurfaceSpawn` là hàm thuần-KIỂM-ĐƯỢC nối T2/T5 vào flow spawn thật:
 *
 *   sweep TTL → resolveSurface (T2, fail-closed §3)
 *     → provider.createSurface({cwd})       [KHÔNG command — trả pane id]
 *     → stripHeadlessModeArgs(piArgs)        [bỏ `--mode json -p`, KHÔNG đổi gì khác]
 *     → buildLaunchScript(env có PI_CREW_SURFACE_PANE = id THẬT, callerEnv=host)
 *     → sendCommand(`bash <script>; exit`)
 *
 * Thứ tự đó là bắt buộc: env map của script phải mang pane id thật nên
 * createSurface phải chạy TRƯỚC build script; sendCommand chỉ có thể gọi sau
 * khi script nằm trên đĩa. Không placeholder mechanism.
 *
 * Fail-closed (spec §3): MỌI lỗi sau khi đã resolve được provider (split fail,
 * builder throw, provider không có sendCommand) → đóng pane mồ côi + trả
 * `{mode:"headless"}` với lý do nội bộ. Hàm KHÔNG BAO GIỜ throw ra ngoài —
 * caller luôn rơi về đường spawn headless hiện có.
 *
 * `; exit` cuối command: script chạy trong shell tương tác của pane, nên khi
 * worker kết thúc pane phải tự đóng (spec §13.2 — onExit là tín hiệu hoàn
 * thành/degrade của host). Shell exit sau script → pane chết → onExit bắn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { PiTeamsConfig } from "../../config/types.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { agentEventsPathForStateRoot } from "../crew-agent-records.ts";
import { currentCrewDepth, getPiTempBase } from "../model/pi-args.ts";
import { getPiSpawnCommand } from "../pi-spawn.ts";
import { procStartTimeTicks } from "../process/proc-stat.ts";
import { buildLaunchScript, launchScriptRegistry, shellEscape, sweepLaunchScripts } from "./launch-script.ts";
import type { ResolveSurfaceOpts, SurfaceGateRejection, SurfaceResolution } from "./resolve-surface.ts";
import { resolveSurfaceDetailed, surfaceGateEnvSnapshot } from "./resolve-surface.ts";
import type { SurfaceExitReason, SurfaceHandle, SurfaceProvider } from "./surface-provider.ts";

/** Dependencies injectable — test/thăm dò không cần mux thật. */
export interface SurfaceSpawnDeps {
	/**
	 * Provider ĐÃ resolve sẵn (T11 dispatch sở hữu quyền quyết định, hoặc test).
	 * Khi có mặt: bỏ qua resolveSurface hoàn toàn. `null` = ép headless.
	 */
	provider?: SurfaceProvider | null;
	/** Forward thẳng cho resolveSurface (tmuxBin/herdrBin/pingSocket/providers). */
	resolve?: ResolveSurfaceOpts;
	/** Đồng hồ (ms epoch) cho TTL sweep — default Date.now. */
	now?: () => number;
	/**
	 * Resolve dòng lệnh pi từ argv TUI (default getPiSpawnCommand). Test inject
	 * để chạy script thật mà không cần binary pi trên máy.
	 */
	resolveCommand?: typeof getPiSpawnCommand;
	/** Đọc /proc/<pid>/stat (default readFileSync) — parent starttime. */
	readParentStat?: (pid: number) => string | undefined;
}

export interface PrepareSurfaceSpawnInput {
	/**
	 * Env DETECTION của host (depth 0/tier-1, TMUX/HERDR_*, PI_CREW_ASYNC_RUN).
	 * PHẢI là base env của host — KHÔNG phải built.env của worker (built.env
	 * mang depth con = cha+1 và sẽ làm guard lớp 1 chặn nhầm).
	 */
	env: NodeJS.ProcessEnv;
	/** Env đầy đủ worker phải nhận (đã qua allowlist filter + control spread). */
	workerEnv: Record<string, string>;
	config: PiTeamsConfig;
	role: string;
	livePaneCount: number;
	taskId: string;
	cwd: string;
	/** argv CHƯA strip từ buildPiWorkerArgs (`--mode json -p` đứng đầu). */
	piArgs: string[];
	/** State root của run — nguồn PI_CREW_AGENT_EVENTS_PATH. */
	stateRoot: string;
	/** Thư mục chứa launch script (default getPiTempBase()). */
	baseDir?: string;
	deps?: SurfaceSpawnDeps;
}

/** Kết quả prepareSurfaceSpawn — hoặc boot được trong pane, hoặc headless. */
export type SurfaceSpawnOutcome =
	| {
			mode: "surface";
			kind: SurfaceProvider["kind"];
			paneId: string;
			handle: SurfaceHandle;
			/** Provider đằng sau handle — degrade/close (T11) cần gọi nó. */
			provider: SurfaceProvider;
			scriptPath: string;
			/**
			 * Per-agent event log của worker này (`agents/{taskId}/events.jsonl`) —
			 * host tail đúng file đó (T9 EventLogTailSource). Null khi spawn ngoài
			 * run (không stateRoot → không set PI_CREW_AGENT_EVENTS_PATH cho worker).
			 */
			eventsPath: string | null;
			/**
			 * Task 5 (tab-layout §5): tab của pane này — tabKey = runId, tabId từ
			 * handle.tabId của provider. Caller (child-pi → controller) ghi manifest
			 * `surface.tabs[tabKey]` để run end biết đóng tab nào. Vắng mặt = spawn
			 * ngoài run hoặc provider chưa hỗ trợ tab.
			 */
			tabKey?: string;
			tabId?: string;
	  }
	| {
			mode: "headless";
			reason?: string;
			/**
			 * True khi một surface spawn ĐÃ THỰC SỰ được thử (createSurface /
			 * sendCommand) và fail — phân biệt với các lối headless không hề đụng
			 * mux (gate/resolve null). T11 dùng flag này cho counter spawn-fail
			 * riêng của spec §7 ("Spawn-fail ≠ flap, nhưng có lockout riêng").
			 */
			attempted?: boolean;
			/**
			 * Gate nào đã chặn TRƯỚC khi đụng mux (FINDING-3, report 10tier
			 * 2026-08-27): mode-off/depth/pane-cap/role-not-visible/
			 * no-mux. KHÔNG đặt khi `attempted` (mux probe fail thật là chuyện
			 * của counter spawn-fail, không phải gate). Child-pi đọc field này
			 * để phát lifecycle `surface_gate_blocked` vào run events.
			 */
			gateRejected?: SurfaceGateRejection;
	  };

/**
 * Per-agent event log của worker surface — DELEGATE sang công thức canonical
 * `agentEventsPathForStateRoot` (crew-agent-records.ts): cùng safeAgentTaskId
 * sanitize (strip phần trước ":" + assertSafePathId) như mọi consumer host
 * (agent-view, status/output writers). Fix round 1/T9: tự path.join với taskId
 * NGUYÊN làm taskId chứa ":" ghi file khác file agent-view đọc. Null khi không
 * có stateRoot (spawn ngoài run) — bỏ key thay vì đường dẫn sai layout. Throw
 * khi taskId không sanitize được → prepareSurfaceSpawn fail-closed headless.
 */
export function surfaceAgentEventsPath(stateRoot: string, taskId: string): string | null {
	return stateRoot ? agentEventsPathForStateRoot(stateRoot, taskId) : null;
}

/**
 * Gỡ đúng cụm `--mode json -p` khỏi argv worker. Idempotent-safe: không thấy
 * cụm thì trả nguyên vẹn (giúp gọi hai lần vô hại). Spec §5.2 — surface variant
 * khác headless DUY NHẤT ở chế độ chạy.
 */
export function stripHeadlessModeArgs(args: string[]): string[] {
	const idx = args.indexOf("--mode");
	if (idx === -1 || args[idx + 1] !== "json") return [...args];
	if (args[idx + 2] !== "-p") return [...args];
	return [...args.slice(0, idx), ...args.slice(idx + 3)];
}

/**
 * Đọc field 22 (/proc/<pid>/stat) — clock ticks kể từ boot, bất biến qua pid
 * reuse. Parse DELEGATE cho runtime/process/proc-stat (dùng chung với
 * worker-side parent-guard T8 và zombie-scanner — hai bên PHẢI index giống
 * nhau, nếu không guard sẽ giết nhầm worker khoẻ). Return RAW ticks dạng chuỗi
 * để worker so khớp từng byte với cùng nguồn dữ liệu. Non-Linux / đọc lỗi → "" .
 */
export function readParentStartTime(pid: number, readStat?: (pid: number) => string | undefined): string {
	const reader =
		readStat ??
		((p: number) => {
			try {
				return fs.readFileSync(`/proc/${p}/stat`, "utf8");
			} catch {
				return undefined;
			}
		});
	const stat = reader(pid);
	if (!stat) return "";
	return procStartTimeTicks(stat) ?? "";
}

/** Nối command + args thành một dòng bash an toàn (mỗi token escaped riêng). */
function joinCommandLine(spec: { command: string; args: string[] }): string {
	return [spec.command, ...spec.args].map(shellEscape).join(" ");
}

/**
 * Chuẩn bị nhánh spawn surface. Trả outcome — KHÔNG throw (fail-closed §3).
 */
export async function prepareSurfaceSpawn(input: PrepareSurfaceSpawnInput): Promise<SurfaceSpawnOutcome> {
	const now = input.deps?.now ?? Date.now;

	// TTL sweep trước mỗi spawn (spec §5.2): dọn script mồ côi trước khi tạo mới.
	try {
		sweepLaunchScripts(launchScriptRegistry, now());
	} catch (error) {
		logInternalError("surface-spawn.sweep", error instanceof Error ? error : new Error(String(error)));
	}

	// Lớp guard 1: provider hay null? deps.provider (pre-resolved) thắng —
	// dispatch T11 sở hữu quyết định surface; không có thì đi qua matrix T2.
	// Gate CỨNG duy nhất áp cho cả đường pre-resolved là DEPTH (không pane-in-
	// pane) — spec §3 không thể bị bỏ qua. Async KHÔNG còn là gate: kể từ
	// 2026-08-27, surface không hard-code "async → headless" nữa; pane có hay
	// không do môi trường quét được + `runtime.surface.*` config quyết.
	const hardGated = currentCrewDepth(input.env) > 0 ? `host depth ${currentCrewDepth(input.env)} > 0` : null;
	let resolution: SurfaceResolution;
	try {
		if (hardGated && input.deps?.provider !== undefined) {
			logInternalError(
				"surface-spawn.hard-gate",
				new Error(`pre-resolved surface provider ignored: ${hardGated}`),
				"fail-closed §3",
				"warn",
			);
			return {
				mode: "headless",
				reason: `surface gated by ${hardGated}`,
				gateRejected: {
					gate: "depth",
					reason: `surface gated by ${hardGated}`,
					env: surfaceGateEnvSnapshot(input.env),
				},
			};
		}
		resolution =
			input.deps?.provider !== undefined
				? { provider: input.deps.provider }
				: resolveSurfaceDetailed(input.env, input.config, input.role, input.livePaneCount, input.deps?.resolve);
	} catch (error) {
		logInternalError("surface-spawn.resolve", error instanceof Error ? error : new Error(String(error)), "resolveSurface threw");
		return { mode: "headless", reason: `surface resolution threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!resolution.provider) {
		// Lý do cụ thể (depth/cap/async/mode/mux thiếu) đến từ matrix T2 —
		// rejection đi theo outcome để child-pi phát surface_gate_blocked.
		const rejection = resolution.rejection;
		return {
			mode: "headless",
			reason: rejection
				? `surface gate "${rejection.gate}": ${rejection.reason}`
				: "surface resolution returned null (mode/depth/async/cap/role gate or no mux)",
			gateRejected: rejection,
		};
	}
	const provider = resolution.provider;

	// Pane TRƯỚC — cần id thật cho env map của script. Title = taskId (F4, review
	// T7): pane rename là cosmetic nên KHÔNG được quyết định fail-closed.
	// Tab-layout (spec 2026-08-27-surface-tab-layout): tabKey = runId (basename
	// của stateRoot) — mọi worker của run chia tab; splitIndex = số pane worker
	// run đã có (provider tự luân phiên down/right + mở tab mới khi đầy 8).
	const runId = input.stateRoot ? path.basename(input.stateRoot) : undefined;
	let handle: SurfaceHandle;
	try {
		handle = await provider.createSurface(input.taskId, {
			cwd: input.cwd,
			title: input.taskId,
			...(runId ? { tabKey: runId, splitIndex: input.livePaneCount } : {}),
		});
	} catch (error) {
		logInternalError(
			"surface-spawn.create-surface",
			error instanceof Error ? error : new Error(String(error)),
			`taskId=${input.taskId}`,
		);
		return {
			mode: "headless",
			reason: `createSurface failed: ${error instanceof Error ? error.message : String(error)}`,
			attempted: true,
		};
	}

	// Từ đây trở đi mọi lỗi phải đóng pane mồ côi rồi fallback headless.
	try {
		if (typeof provider.sendCommand !== "function") {
			throw new Error("provider does not implement sendCommand — cannot boot a commandless pane");
		}
		const tuiArgs = stripHeadlessModeArgs(input.piArgs);
		const spawnSpec = (input.deps?.resolveCommand ?? getPiSpawnCommand)(tuiArgs);
		// Env export = worker env đầy đủ (parity headless) + các biến surface.
		// Không stateRoot (spawn ngoài run) → không có event log để ghi — bỏ key
		// thay vì đường dẫn tương đối sai layout agents/{taskId}/events.jsonl.
		const eventsPath = surfaceAgentEventsPath(input.stateRoot, input.taskId);
		const scriptEnv: Record<string, string> = {
			...input.workerEnv,
			PI_CREW_SURFACE: provider.kind,
			PI_CREW_SURFACE_PANE: handle.id,
			PI_CREW_AUTO_EXIT: "1",
			...(eventsPath ? { PI_CREW_AGENT_EVENTS_PATH: eventsPath } : {}),
			// Host đã set PI_CREW_PARENT_PID trong worker env (child-pi-spawn) —
			// chỉ tự điền khi worker env chưa có để tránh ghi đè ý của caller.
			...(input.workerEnv.PI_CREW_PARENT_PID ? {} : { PI_CREW_PARENT_PID: String(process.pid) }),
		};
		if (!scriptEnv.PI_CREW_PARENT_START_TIME) {
			scriptEnv.PI_CREW_PARENT_START_TIME = readParentStartTime(process.pid, input.deps?.readParentStat);
		}
		// callerEnv = env host → guard lớp 2 đọc độ sâu NGƯỜI GỌI (env export được
		// phép mang PI_CREW_DEPTH=<caller+1> vì đó là depth hợp lệ của worker).
		const scriptPath = buildLaunchScript({
			taskId: input.taskId,
			env: scriptEnv,
			command: joinCommandLine(spawnSpec),
			cwd: input.cwd,
			baseDir: input.baseDir ?? getPiTempBase(),
			callerEnv: input.env,
		});
		// Boot worker + thoát shell khi worker kết thúc (pane đóng → onExit, §13.2).
		await provider.sendCommand(handle, `bash ${shellEscape(scriptPath)}; exit`);
		return {
			mode: "surface",
			kind: provider.kind,
			paneId: handle.id,
			handle,
			provider,
			scriptPath,
			eventsPath,
			// Task 5 (tab-layout): đưa tab identity lên cho caller ghi manifest —
			// provider set handle.tabId trong tab-flow (tabKey có mặt).
			...(runId && handle.tabId ? { tabKey: runId, tabId: handle.tabId } : {}),
		};
	} catch (error) {
		logInternalError(
			"surface-spawn.boot",
			error instanceof Error ? error : new Error(String(error)),
			`taskId=${input.taskId} pane=${handle.id} — falling back to headless`,
		);
		try {
			await provider.closeSurface(handle, { force: true });
		} catch (closeError) {
			logInternalError(
				"surface-spawn.orphan-close",
				closeError instanceof Error ? closeError : new Error(String(closeError)),
				`pane=${handle.id}`,
			);
		}
		return {
			mode: "headless",
			reason: `surface boot failed: ${error instanceof Error ? error.message : String(error)}`,
			attempted: true,
		};
	}
}

/** Nhánh outcome đã boot thành công (dùng ở chữ ký waitForSurfaceExit). */
export type SurfaceSpawned = Extract<SurfaceSpawnOutcome, { mode: "surface" }>;

/**
 * TTL sweep cho điểm KẾT THÚC run (spec §5.2) — finalizeRun gọi hàm này để dọn
 * script mồ côi (worker chưa kịp chạy đã chết) cùng lúc với state còn lại của
 * run. Trả số entry đã dọn (best-effort — không throw).
 */
export function sweepLaunchScriptsAtRunEnd(now: () => number = Date.now): number {
	try {
		return sweepLaunchScripts(launchScriptRegistry, now());
	} catch (error) {
		logInternalError("surface-spawn.run-end-sweep", error instanceof Error ? error : new Error(String(error)));
		return 0;
	}
}

/**
 * Grace window sau khi host đã INITIATE force-close mà handle.onExit vẫn chưa
 * bắn (final fix I-1): herdr subscribe là edge-event nên pane chết giữa khoảng
 * split → lần đăng ký onExit ĐẦU sẽ bỏ lỡ event; `pane.close` trả
 * `pane_not_found` và closeSurface nuốt thành "thành công" — nếu chỉ dựa vào
 * onExit, promise treo tới host Ctrl-C. tmux miễn nhiễm vì poll TRẠNG THÁI.
 * Hết grace → resolve exit TỔNG HỢP (`synthetic: true`, reason "detached").
 * Timeout test inject được qua {@link WaitForSurfaceExitHooks.graceAfterForceCloseMs}.
 */
export const FORCE_CLOSE_EXIT_GRACE_MS = 2_000;

export interface SurfaceExitInfo {
	reason: SurfaceExitReason;
	/** True khi parent AbortSignal đã force-close pane (cancel/host-shutdown). */
	cancelledByAbort: boolean;
	/**
	 * True khi response deadline đạt TRƯỚC khi pane tự chết — worker bị coi là
	 * treo, pane bị force-close (fix round 1/F2: parity timeout tối thiểu với
	 * đường headless để slot worker không bị giữ vô hạn).
	 */
	timedOut: boolean;
	/**
	 * True khi đây là exit TỔNG HỢP do grace window hết sau force-close mà
	 * onExit vẫn im lặng (final fix I-1) — không có event thật nào từ mux;
	 * caller phải coi như worker đã chết (exitCode null), không phải hoàn thành.
	 */
	synthetic?: boolean;
}

export interface WaitForSurfaceExitHooks {
	signal?: AbortSignal;
	/** Hard deadline (ms) tính từ lúc bắt đầu chờ — undefined = không deadline. */
	deadlineMs?: number;
	/** Ghi đè grace window (mặc định FORCE_CLOSE_EXIT_GRACE_MS) — test ngắn. */
	graceAfterForceCloseMs?: number;
}

/**
 * Chờ worker trong pane kết thúc — nguồn chờ chính là handle.onExit (pane chết
 * / mux chết / host chủ động detach). Ba cơ chế giải thoát promise để slot
 * worker KHÔNG BAO GIỜ bị giữ vô hạn:
 *   1. Parent AbortSignal → closeSurface({force:true}) → onExit bắn "detached".
 *   2. Response deadline (fix round 1/F2) → cùng force-close; A1 không có tín
 *      hiệu activity từ stream nên deadline là một mốc hard duy nhất kể từ lúc
 *      boot (nghiêm hơn nghĩa "no new output" của headless — T11 refine).
 *   3. Synthetic-exit grace (final fix I-1) → force-close xong mà onExit vẫn
 *      câm (herdr edge-event gap / socket request treo — T4 A2 note) thì tự
 *      kết thúc bằng exit tổng hợp.
 * Spec §13.2.
 */
export async function waitForSurfaceExit(outcome: SurfaceSpawned, hooks: WaitForSurfaceExitHooks = {}): Promise<SurfaceExitInfo> {
	const forceClose = async (): Promise<void> => {
		try {
			await outcome.provider.closeSurface(outcome.handle, { force: true });
		} catch (error) {
			logInternalError(
				"surface-spawn.force-close",
				error instanceof Error ? error : new Error(String(error)),
				`pane=${outcome.paneId}`,
			);
		}
	};
	return await new Promise<SurfaceExitInfo>((resolve) => {
		let cancelledByAbort = hooks.signal?.aborted === true;
		let timedOut = false;
		let settled = false;
		let synthTimer: ReturnType<typeof setTimeout> | null = null;
		const finish = (info: SurfaceExitInfo): void => {
			if (settled) return;
			settled = true;
			if (synthTimer) clearTimeout(synthTimer);
			resolve(info);
		};
		const armSyntheticFallback = (): void => {
			if (settled || synthTimer) return;
			const graceMs = Math.max(1, hooks.graceAfterForceCloseMs ?? FORCE_CLOSE_EXIT_GRACE_MS);
			synthTimer = setTimeout(() => {
				logInternalError(
					"surface-spawn.synthetic-exit",
					new Error(`no onExit within ${graceMs}ms of force-close`),
					`pane=${outcome.paneId} — resolving synthetic exit (pane may have died before its first onExit subscription)`,
				);
				finish({ reason: "detached", cancelledByAbort, timedOut, synthetic: true });
			}, graceMs);
			synthTimer.unref();
		};
		if (cancelledByAbort) {
			// Cancel thắng mọi thứ — initiate ngay cả khi signal đã aborted trước.
			cancelledByAbort = true;
			void forceClose();
			armSyntheticFallback();
		}
		const onAbort = (): void => {
			if (cancelledByAbort || timedOut || settled) return;
			cancelledByAbort = true;
			void forceClose();
			armSyntheticFallback();
		};
		hooks.signal?.addEventListener("abort", onAbort, { once: true });
		const timer =
			hooks.deadlineMs !== undefined
				? setTimeout(
						() => {
							if (cancelledByAbort || timedOut || settled) return; // cancel thắng — đã force-close
							timedOut = true;
							void forceClose();
							armSyntheticFallback();
						},
						Math.max(1, hooks.deadlineMs),
					)
				: null;
		timer?.unref(); // deadline không được giữ event loop sống vô ích
		outcome.handle.onExit((reason) => finish({ reason, cancelledByAbort, timedOut }));
		if (!hooks.signal && !timer && !synthTimer && !settled) {
			// Không đường giải thoát nào được cấu hình (không signal, không
			// deadline): vẫn phải có hồi kết — dùng grace từ lúc bắt đầu chờ thay
			// vì treo khi pane chết trước lần đăng ký onExit đầu.
			armSyntheticFallback();
		}
	});
}
