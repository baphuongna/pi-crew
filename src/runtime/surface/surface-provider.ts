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

/**
 * Options for spawning a new surface
 */
export interface SurfaceSpawnOpts {
  cwd: string;
  command: string;
  title?: string;
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

  /** Attach to an existing surface session (returns null if not found/implemented) */
  attach(id: string): SurfaceHandle | null;

  /** Read current screen content from surface */
  readScreen(handle: SurfaceHandle, lines?: number): Promise<string>;

  /** Close/terminate a surface session */
  closeSurface(handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void>;

  /** rebalance(): void — A2 defer (not implemented in A1) */
}
