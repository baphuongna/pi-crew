/**
 * SurfaceProvider interface and types (spec §4)
 *
 * Defines the abstraction layer for multiplexer-based interactive surfaces (tmux, herdr).
 * Used by runtime layer to create, attach, read, and close interactive sessions.
 */

/**
 * Detection result for a surface provider
 */
export interface SurfaceDetection {
	ok: boolean;
	kind?: "tmux" | "herdr";
	reason?: string;
}

/** Max worker panes per tab trước khi provider mở tab mới (spec tab-layout §5). */
export const MAX_PANES_PER_TAB = 8;

/**
 * Hướng split luân phiên theo pane index trong tab (spec tab-layout §4):
 * chẵn → down (dọc), lẻ → right (ngang) — không dồn một phía.
 */
export function splitDirectionFor(index: number): "down" | "right" {
	return index % 2 === 0 ? "down" : "right";
}

/**
 * Options for spawning a new surface.
 *
 * `command` is OPTIONAL on purpose: the MuxSurface spawn flow (spec §13.1)
 * creates the pane FIRST to learn its id, builds the launch script with
 * PI_CREW_SURFACE_PANE=<real id>, and only then boots the worker through
 * {@link SurfaceProvider.sendCommand}. Omitting it leaves the pane sitting at
 * its shell prompt without any keys being sent.
 */
export interface SurfaceSpawnOpts {
	cwd: string;
	command?: string;
	title?: string;
	/** runId — mọi worker của cùng TEAM RUN chia tab (spec tab-layout §3.1). */
	tabKey?: string;
	/** Pane thứ mấy trong tab hiện tại — quyết định hướng down/right. */
	splitIndex?: number;
}

/**
 * Reason why a surface session ended
 */
export type SurfaceExitReason = "pane-closed" | "mux-dead" | "detached";

/**
 * Handle to an active surface session
 */
export interface SurfaceHandle {
	id: string;
	kind: "tmux" | "herdr";
	/**
	 * Tab/window chứa pane này (tab-layout, spec 2026-08-27 §5) — provider set
	 * khi spawn trong tab-flow (tabKey có mặt); caller ghi manifest
	 * `surface.tabs[tabKey]` để run end biết đóng tab nào. Vắng mặt = spawn
	 * ngoài run (đường legacy) hoặc provider cũ.
	 */
	tabId?: string;
	onExit(cb: (reason: SurfaceExitReason) => void): void;
	dispose(): void;
}

/**
 * Provider interface for multiplexer-based interactive surfaces
 *
 * Implementations:
 * - tmux: Terminal multiplexer (via libtmux)
 * - herdr: Custom herd-based multiplexer (future)
 */
export interface SurfaceProvider {
	/** Provider kind identifier */
	kind: "tmux" | "herdr";

	/** Detect if the multiplexer is available and functional */
	detect(): SurfaceDetection;

	/** Create a new surface session */
	createSurface(name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle>;

	/**
	 * Send literal text into an existing surface session (as if typed by the
	 * user, followed by Enter). Both shipped providers implement it — the only
	 * way the host boots a worker in a pane that was created without a command
	 * (spec §13.1). Optional on the interface so pre-existing fake providers in
	 * tests keep compiling; callers treat "absent" as spawn failure and degrade.
	 */
	sendCommand?(handle: SurfaceHandle, text: string): Promise<void>;

	/** Attach to an existing surface session (returns null if not found/implemented) */
	attach(id: string): SurfaceHandle | null;

	/** Read current screen content from surface */
	readScreen(handle: SurfaceHandle, lines?: number): Promise<string>;

	/** Close/terminate a surface session */
	closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void>;

	/**
	 * Đóng TOÀN bộ tab của một run theo tab-key (spec tab-layout §5: tab chỉ
	 * đóng khi run end/cancel/kill — không đóng theo từng worker). Provider tự
	 * tra map nội bộ tabKey → windows/tabs của run nên caller gọi ĐÚNG MỘT LẦN
	 * cho mỗi tabKey, không loop từng tabId. Optional để fake provider cũ
	 * trong test vẫn compile; idempotent (map trống / tab đã mất → no-op).
	 */
	closeTab?(tabKey: string): Promise<void>;

	/** rebalance(): void — A2 defer (not implemented in A1) */
}
