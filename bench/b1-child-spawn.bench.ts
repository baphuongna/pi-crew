/**
 * b1 — child-pi spawn cold start benchmark (REAL spawn path).
 *
 * Measures the REAL cost of spawning a pi-crew subagent worker, using the
 * same spawn path the runtime uses:
 *   - `getPiSpawnCommand(args)` from src/runtime/pi-spawn.ts — resolves the
 *     actual `pi` binary (npm global bin / project node_modules/.bin).
 *   - `buildFinalChildPiSpawnOptions()` from src/runtime/child-pi/child-pi-spawn.ts
 *     — allowlist env filter + provider-key scoping + detached/setsid, same as
 *     child-pi.ts does at the real spawn site.
 *
 * This is NOT a bare `node -e "process.exit(0)"` probe (that only measures the
 * Node bootstrap, ~38 ms). The real cost per subagent is:
 *     spawn (~10-40 ms) + pi runtime bundle load (~1.2-1.3 s) + broker
 *     handshake (~8 ms) + LLM call.
 *
 * Each child runs the actual `pi --version` command (NOT a full agent task —
 * that would require a live LLM + credentials and would take minutes). The
 * child must EXIT 0 within the timeout; that proves the pi binary was
 * resolved, env-filtered, spawned detached, and booted far enough to answer.
 *
 * A full "spawn + handshake + first LLM turn" probe requires a live Pi session
 * and provider credentials — recorded as TODO (see perf-analysis.md §7).
 *
 * Sizes: 1, 5, 10 children (sequential within a batch).
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b1-child-spawn.bench.ts
 */

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildFinalChildPiSpawnOptions } from "../src/runtime/child-pi/child-pi-spawn.ts";
import { getPiSpawnCommand } from "../src/runtime/pi-spawn.ts";

function resolveSpawnSpec(): { command: string; args: string[] } {
	// `pi --version` — boots the real pi CLI far enough to answer, no LLM needed.
	const spec = getPiSpawnCommand(["--version"]);
	if (!spec.command) {
		throw new Error("getPiSpawnCommand returned an empty command — pi binary not resolvable");
	}
	return spec;
}

function runBatch(count: number): {
	wallMs: number;
	maxBlockMs: number;
	perChildMs: number[];
	rssDelta: number;
	error?: string;
} {
	const rssBefore = process.memoryUsage().rss;
	const blockSamples: number[] = [];
	let last = performance.now();
	const sampler = setInterval(() => {
		const now = performance.now();
		blockSamples.push(now - last);
		last = now;
	}, 1);

	const spec = resolveSpawnSpec();
	const spawnOptions = buildFinalChildPiSpawnOptions(process.cwd(), process.env, {}, undefined);

	const perChildMs: number[] = [];
	const start = performance.now();
	for (let i = 0; i < count; i++) {
		const c0 = performance.now();
		const res = spawnSync(spec.command, spec.args, {
			...spawnOptions,
			encoding: "utf-8",
			timeout: 30_000,
			stdio: "ignore",
		});
		perChildMs.push(performance.now() - c0);
		if (res.status !== 0) {
			clearInterval(sampler);
			return {
				wallMs: performance.now() - start,
				maxBlockMs: 0,
				perChildMs,
				rssDelta: process.memoryUsage().rss - rssBefore,
				error: `child ${i} exited ${res.status ?? res.signal} (${String(res.error ?? "")})`,
			};
		}
	}
	const wallMs = performance.now() - start;
	clearInterval(sampler);
	const maxBlockMs = blockSamples.length > 0 ? Math.max(...blockSamples) : 0;
	const rssDelta = process.memoryUsage().rss - rssBefore;
	return { wallMs, maxBlockMs, perChildMs, rssDelta };
}

function main(): void {
	const sizes = [1, 5, 10];
	const cases: Record<string, unknown> = {};
	let error: string | undefined;
	for (const size of sizes) {
		const res = runBatch(size);
		error = res.error;
		cases[`n${size}`] = {
			wallMs: round(res.wallMs),
			perChildAvgMs: round(res.wallMs / size),
			perChildMs: res.perChildMs.map(round),
			maxBlockMs: round(res.maxBlockMs),
			rssDeltaBytes: res.rssDelta,
			spawnsPerSec: round(size / (res.wallMs / 1000)),
			...(res.error ? { error: res.error } : {}),
		};
		console.log(
			`b1 n=${size}: ${round(res.wallMs)}ms total, ${round(res.wallMs / size)}ms/child, maxBlock=${round(res.maxBlockMs)}ms, rssDelta=${res.rssDelta}${res.error ? ` ERROR=${res.error}` : ""}`,
		);
	}

	const result = {
		name: "b1.child-spawn.real",
		unit: "ms",
		sizes,
		cases,
		spawnSpec: resolveSpawnSpec().command,
		note: "REAL pi binary spawn via getPiSpawnCommand + buildFinalChildPiSpawnOptions. Includes pi runtime boot (--version). NOT a bare node -e probe. Full spawn+handshake+LLM requires live Pi session (see TODO in perf-analysis.md).",
		error,
		rssBaselineBytes: process.memoryUsage().rss,
	};
	console.log(JSON.stringify(result));
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

main();
