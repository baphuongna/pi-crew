/**
 * resolveSurface — fail-closed multiplexer detection matrix (spec §3)
 *
 * Decides WHERE a tier-1 worker lives: a pane in tmux/herdr, or headless.
 * Every failed check (missing binary, dead socket, depth, async run, pane
 * cap, mode) degrades to headless (null). This NEVER throws because a
 * multiplexer is missing — the current headless code path stays untouched.
 *
 * Check order per cell: binary first, env after. tmux beats herdr when both
 * are present (innermost wins). Forced mode ("tmux"/"herdr") that fails
 * detect → null, never falls through to the other backend.
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import type { PiTeamsConfig } from "../../config/types.ts";
import { currentCrewDepth } from "../model/pi-args.ts";
import type { SurfaceProvider } from "./surface-provider.ts";

/** Hard cap on live surface panes per run (D6). Reaching it → headless. */
export const MAX_SURFACE_WORKERS = 6;

/** Socket connect timeout for the herdr liveness probe. */
const HERDR_PING_TIMEOUT_MS = 500;

/** Provider instances keyed by kind — injected so tests stay independent of T3/T4. */
export interface SurfaceProviders {
	tmux?: SurfaceProvider;
	herdr?: SurfaceProvider;
}

export interface ResolveSurfaceOpts {
	/** tmux binary to probe (default: PATH lookup of "tmux"). */
	tmuxBin?: string;
	/** herdr binary to probe (default: PATH lookup of "herdr"). */
	herdrBin?: string;
	/** Synchronous socket liveness probe (default: net.connect with timeout). */
	pingSocket?: (socketPath: string) => boolean;
	/** Provider instances to return on successful detection. */
	providers?: SurfaceProviders;
}

// Binary availability cache — same shape as hasCommand in amos tmux helpers:
// `command -v` is a subprocess, so memoize per binary path for the hot path.
const binaryAvailability = new Map<string, boolean>();

function hasBinary(bin: string): boolean {
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

/**
 * herdr socket path: HERDR_SOCKET_PATH override, else the default herdr
 * config location. TODO(T4): align with the real herdr env contract
 * (HERDR_SESSION may influence the path).
 */
function herdrSocketPath(env: NodeJS.ProcessEnv): string {
	return env.HERDR_SOCKET_PATH ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

// The liveness probe runs in a Worker so the main thread can block on
// Atomics.wait while the worker's event loop drives net.connect to
// completion. Plain CJS string — no bundler path rewriting needed.
const PING_WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const net = require("node:net");
const flag = new Int32Array(workerData.sab);
const done = (ok) => {
  if (Atomics.load(flag, 0) !== 0) return;
  Atomics.store(flag, 0, ok ? 1 : 2);
  Atomics.notify(flag, 0);
};
try {
  const socket = net.connect({ path: workerData.socketPath });
  const timer = setTimeout(() => { socket.destroy(); done(false); }, workerData.timeoutMs);
  socket.on("connect", () => { clearTimeout(timer); socket.destroy(); done(true); });
  socket.on("error", () => { clearTimeout(timer); done(false); });
} catch {
  done(false);
}
parentPort.unref();
`;

/**
 * Synchronous unix-socket connect probe. True = something is listening and
 * accepted the connection. Any failure (missing socket, refusal, timeout,
 * Worker/Atomics unavailable on this runtime) → false → fail-closed headless.
 */
function pingSocketSync(socketPath: string, timeoutMs = HERDR_PING_TIMEOUT_MS): boolean {
	const sab = new SharedArrayBuffer(4);
	const flag = new Int32Array(sab);
	let worker: Worker;
	try {
		worker = new Worker(PING_WORKER_SRC, {
			eval: true,
			workerData: { socketPath, timeoutMs, sab },
		});
		worker.unref();
	} catch {
		return false;
	}
	try {
		// +150ms grace for worker startup beyond the connect timeout itself.
		Atomics.wait(flag, 0, 0, timeoutMs + 150);
	} catch {
		return false;
	} finally {
		// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional fire-and-forget — a dying worker has nothing left to fail on.
		void worker.terminate().catch(() => {});
	}
	return Atomics.load(flag, 0) === 1;
}

/**
 * Resolve the surface provider for a tier-1 worker, or null for headless.
 *
 * Matrix (spec §3), checked in order — first hit wins:
 *  1. surface.mode "off" → null
 *  2. PI_CREW_ASYNC_RUN=1 (async run, A1) → null
 *  3. PI_CREW_DEPTH > 0 (we are a worker/grandchild) → null — no pane-in-pane
 *  4. livePaneCount >= MAX_SURFACE_WORKERS → null
 *  5. role not in visibleAgents (exact match; ["*"] = all) → null
 *  6. auto: TMUX + binary → tmux, else HERDR_ENV + binary + live socket →
 *     herdr; forced mode only tries its own cell, fail → null
 *
 * TODO(T3/T4): wire production providers here — dynamic-import the tmux and
 * herdr provider factories and pass them as the default `providers`. Until
 * then a caller without injected providers gets null (headless) even when
 * detection succeeds.
 */
export function resolveSurface(
	env: NodeJS.ProcessEnv,
	config: PiTeamsConfig,
	role: string,
	livePaneCount: number,
	opts: ResolveSurfaceOpts = {},
): SurfaceProvider | null {
	const surface = config.runtime?.surface;
	const mode = surface?.mode ?? "auto";
	if (mode === "off") return null;
	// Async runs force headless in A1 — no re-attach yet (spec §14).
	if (env.PI_CREW_ASYNC_RUN === "1") return null;
	// Surface panes are tier-1 only — never inside a worker.
	if (currentCrewDepth(env) > 0) return null;
	if (livePaneCount >= MAX_SURFACE_WORKERS) return null;

	const visibleAgents = surface?.visibleAgents ?? [];
	if (!visibleAgents.includes("*") && !visibleAgents.includes(role)) return null;

	// Per cell: binary first, env after (cheap env read after the cached
	// subprocess check; the herdr ping — most expensive — runs last).
	const tmuxCell = (): boolean => hasBinary(opts.tmuxBin ?? "tmux") && !!env.TMUX;
	const herdrCell = (): boolean =>
		hasBinary(opts.herdrBin ?? "herdr") && env.HERDR_ENV === "1" && (opts.pingSocket ?? pingSocketSync)(herdrSocketPath(env));

	let kind: "tmux" | "herdr" | null;
	if (mode === "tmux") {
		kind = tmuxCell() ? "tmux" : null;
	} else if (mode === "herdr") {
		kind = herdrCell() ? "herdr" : null;
	} else {
		// auto — innermost wins: tmux beats herdr when both are present.
		kind = tmuxCell() ? "tmux" : herdrCell() ? "herdr" : null;
	}
	if (kind === null) return null;

	// TODO(T3/T4): default to the real provider factories once they land.
	const provider = opts.providers?.[kind];
	return provider ?? null;
}
