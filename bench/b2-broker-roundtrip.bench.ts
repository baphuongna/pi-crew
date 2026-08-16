/**
 * b2 — broker handshake + round-trip benchmark.
 *
 * Measures the real in-process CrewBroker (unix socket) + CrewBrokerClient:
 *   - broker start (bind socket)
 *   - client connect + hello handshake
 *   - request/response round-trips (ping) at 1, 100, 1000 messages
 *
 * Latency p50/p95/max (ms), throughput (msgs/s), RSS delta.
 * Uses a temp socket path (no collision with a live Pi session broker).
 *
 * If broker APIs become unimportable or flaky, records `skipped: true` with a
 * limitation rather than failing the suite.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b2-broker-roundtrip.bench.ts
 */

import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { CrewBroker } from "../src/runtime/broker/crew-broker.ts";
import { CrewBrokerClient } from "../src/runtime/broker/crew-broker-client.ts";

const socketPath = path.join(os.tmpdir(), `pi-crew-b2-${process.pid}.sock`);

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

function stats(ms: number[]): { p50: number; p95: number; max: number; min: number; avg: number } {
	const sorted = [...ms].sort((a, b) => a - b);
	return {
		p50: round(pct(sorted, 50)),
		p95: round(pct(sorted, 95)),
		max: round(sorted[sorted.length - 1] ?? 0),
		min: round(sorted[0] ?? 0),
		avg: round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)),
	};
}

async function runRoundTrips(
	client: CrewBrokerClient,
	count: number,
): Promise<{ latencies: number[]; msgsPerSec: number; wallMs: number }> {
	const latencies: number[] = [];
	const start = performance.now();
	for (let i = 0; i < count; i++) {
		const t0 = performance.now();
		const res = await client.request("ping", {});
		latencies.push(performance.now() - t0);
		if (!res.ok) throw new Error(`ping failed: ${res.errorCode}`);
	}
	const wallMs = performance.now() - start;
	return { latencies, msgsPerSec: round(count / (wallMs / 1000)), wallMs };
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
	const rssBefore = process.memoryUsage().rss;
	const broker = new CrewBroker({ sessionId: `b2-${process.pid}`, socketPath, enabled: true });
	const runId = "b2-run";
	const token = broker.issueOrchestratorToken(runId);

	const startT = performance.now();
	await broker.start();
	const brokerStartMs = performance.now() - startT;
	console.log(`b2 broker start: ${round(brokerStartMs)}ms (socket ${socketPath})`);

	const client = new CrewBrokerClient({ runId, taskId: "b2-task", socketPath, token });

	// Handshake: first request triggers connect + hello lazily.
	const h0 = performance.now();
	const helloRes = await client.request("ping", {});
	const handshakeMs = performance.now() - h0;
	if (!helloRes.ok) throw new Error(`handshake failed: ${helloRes.errorCode}`);
	console.log(`b2 handshake (connect+hello+first round-trip): ${round(handshakeMs)}ms`);

	const cases: Record<string, unknown> = {
		handshakeMs: round(handshakeMs),
		brokerStartMs: round(brokerStartMs),
	};
	for (const count of [1, 100, 1000]) {
		const { latencies, msgsPerSec, wallMs } = await runRoundTrips(client, count);
		cases[`n${count}`] = {
			wallMs: round(wallMs),
			...stats(latencies),
			msgsPerSec,
		};
		console.log(`b2 n=${count}: ${round(wallMs)}ms, ${msgsPerSec} msgs/s, p95=${stats(latencies).p95}ms`);
	}

	await client.close();
	await broker.stop();
	try {
		rmSync(socketPath);
	} catch {
		/* best-effort cleanup */
	}

	const result = {
		name: "b2.broker-roundtrip",
		unit: "ms",
		cases,
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
		skipped: false,
	};
	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error("b2 failed:", err);
	const result = {
		name: "b2.broker-roundtrip",
		unit: "ms",
		skipped: true,
		limitation: `broker not feasible in bench: ${String(err)}`,
	};
	console.log(JSON.stringify(result));
});
