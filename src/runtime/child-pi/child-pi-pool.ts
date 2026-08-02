// 2.6 — Child-pi warm pool skeleton (ADR 0008 Proposed).
//
// This module exposes the pool interface that child-pi.ts will consume
// once Pi gains the wait-for-prompt handshake protocol. Until the Pi-side
// support lands, the pool is permanently disabled (size=0): callers always
// receive null from `acquirePooledChild` and fall through to the regular
// spawn path. This keeps the integration point ready without altering
// production behaviour.
//
// Enabling a real pool requires three pieces in order:
//
//   1. Pi runtime: respond to a `PI_CREW_POOL_HEALTH=1` ping on stdin and
//      block in a "wait-for-prompt" state until the parent writes a real
//      prompt. Pi does not currently implement this.
//   2. This module: replace the `acquirePooledChild` returning null with
//      an actual pool that spawn-and-park N processes.
//   3. child-pi.ts: prefer pooled children on `runChildPi` entry; fall
//      back to fresh spawn on miss.
//
// Disabled by default; opt-in via `runtime.warmPool.size > 0` config or
// the `PI_CREW_WARM_POOL_SIZE` env var.
import type { ChildProcess } from "node:child_process";

export interface WarmPoolOptions {
	/** Number of warm processes to maintain. 0 disables the pool. */
	size: number;
	/** Drop pooled processes that have been idle longer than this. */
	maxIdleMs: number;
}

export const DEFAULT_WARM_POOL_OPTIONS: WarmPoolOptions = {
	size: 0,
	maxIdleMs: 5 * 60_000,
};

/** Resolve the effective pool size from env / config / defaults. */
export function resolveWarmPoolSize(env: NodeJS.ProcessEnv = process.env, configured?: number): number {
	const fromEnv = Number.parseInt(env.PI_CREW_WARM_POOL_SIZE ?? "", 10);
	if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
	if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) return configured;
	return DEFAULT_WARM_POOL_OPTIONS.size;
}

/**
 * Try to acquire a parked child from the pool. Returns null when the pool
 * is disabled or empty; caller should spawn a fresh child instead.
 *
 * Skeleton — currently always returns null. See module docstring.
 */
export function acquirePooledChild(_options: Partial<WarmPoolOptions> = {}): ChildProcess | null {
	return null;
}

/**
 * Mark a pooled child as done. Pool processes are single-use: this terminates
 * the child rather than returning it to the pool, because state contamination
 * across runs would be unsafe (file handles, env mutations, mounted FDs).
 *
 * Skeleton — currently a no-op since acquirePooledChild never returns a child.
 */
export function releasePooledChild(_child: ChildProcess | null | undefined): void {
	// no-op while the pool is disabled
}

/** Drain and terminate every parked child. Call on cleanupRuntime. */
export function disposeWarmPool(): void {
	// no-op while the pool is disabled
}
