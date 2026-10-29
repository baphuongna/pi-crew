/**
 * inference-broker-inflight-cap.test.ts — regression pins for the per-worker
 * in-flight concurrency cap.
 *
 * Finding (fixed): MAX_INFLIGHT_PER_WORKER (= 4) admission gate checked
 * `worker.inFlight >= 4` but NOTHING ever incremented inFlight — the only
 * write was the response-close decrement, so the counter walked 0, -1, -2,…
 * and the cap could never trip: one valid worker token could hold unbounded
 * concurrent large-body (≤ 64 MiB) requests inside the parent process.
 *
 * Pins:
 *   (cap1) 6 concurrent requests against a HOLDING upstream → exactly 4
 *          forwarded, 2 × 429 'too many concurrent inference requests for
 *          this worker' while the cap is held; inFlight == 4 during the
 *          hold; after release all 4 drain with 200 and inFlight returns
 *          to exactly 0 (no negative, no leak).
 *   (cap2) sequential requests over a normal upstream never leak slots:
 *          6 in a row all admitted, inFlight == 0 after each.
 *   (cap3) upstream failure (fetch throws → 502) releases the slot: the
 *          next request is admitted (502 again, NOT 429), inFlight == 0.
 *   (cap4) client abort mid-flight releases the slot and it is reusable.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import test from "node:test";
import {
	__inferenceBrokerInFlightForTests,
	__resetInferenceBrokerForTests,
	getInferenceBrokerSnapshot,
	INFERENCE_BROKER_ENABLE_ENV,
	INFERENCE_BUDGET_ENV,
	inferenceBrokerStats,
	maybeStartInferenceBroker,
	registerInferenceWorker,
	stopInferenceBroker,
} from "../../../../src/runtime/child-pi/inference-broker.ts";

const REAL_KEY = "sk-ant-realkey-inflight-pin";
/** Keep in sync with the module-private MAX_INFLIGHT_PER_WORKER constant. */
const MAX_INFLIGHT = 4;
const WORKER_KEY = "inflight-pin-worker";

// ── Mock upstreams ──────────────────────────────────────────────────────

interface HoldingUpstream {
	port: number;
	forwarded(): number;
	releaseAll(): void;
	close(): Promise<void>;
}

/** Mock upstream that HOLDS every forwarded request (never responds) until released. */
function startHoldingUpstream(): Promise<HoldingUpstream> {
	let forwardedCount = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = http.createServer((req, res) => {
		forwardedCount += 1;
		req.resume();
		req.on("end", () => {
			void gate.then(() => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
			});
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				forwarded: () => forwardedCount,
				releaseAll: () => release?.(),
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

/** Mock upstream that answers every forwarded request immediately. */
function startInstantUpstream(): Promise<{ port: number; close(): Promise<void> }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as { port: number }).port,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

// ── Broker fixture (env scoped, broker reset per test) ──────────────────

const BROKER_ENV_KEYS = [
	INFERENCE_BROKER_ENABLE_ENV,
	INFERENCE_BUDGET_ENV,
	"PI_CREW_INFERENCE_UPSTREAM",
	"PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
];

async function withBrokerEnv(upstreamPort: number, run: (baseUrl: string, token: string) => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of BROKER_ENV_KEYS) saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = REAL_KEY;
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
	delete process.env[INFERENCE_BUDGET_ENV]; // 0 = unlimited — the cap under test is the CONCURRENCY cap
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.equal(snap.active, true, "broker must be active");
		const token = registerInferenceWorker(WORKER_KEY);
		await run(snap.baseUrl, token);
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function brokerPost(baseUrl: string, token: string, init?: RequestInit): Promise<Response> {
	return fetch(`${baseUrl}/anthropic/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": token },
		body: JSON.stringify({ model: "claude-inflight", messages: [] }),
		...init,
	});
}

async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met within timeout");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

function inFlight(): number | undefined {
	return __inferenceBrokerInFlightForTests(WORKER_KEY);
}

// ── (cap1) the cap actually trips — the finding's headline behavior ─────

test("(cap1) over-cap concurrent requests get 429 while the cap holds; slots drain back to 0", async () => {
	const upstream = await startHoldingUpstream();
	try {
		await withBrokerEnv(upstream.port, async (baseUrl, token) => {
			const settled: number[] = [];
			const promises = Array.from({ length: MAX_INFLIGHT + 2 }, async () => {
				const r = await brokerPost(baseUrl, token);
				const status = r.status;
				await r.arrayBuffer(); // drain the relayed body / deny JSON
				settled.push(status);
				return status;
			});
			// Hold: exactly MAX_INFLIGHT requests may be forwarded upstream.
			await waitFor(() => upstream.forwarded() >= MAX_INFLIGHT);
			await waitFor(() => settled.length >= 2);
			assert.equal(upstream.forwarded(), MAX_INFLIGHT, "no request beyond the cap may be forwarded while slots are held");
			assert.deepEqual([...settled].sort(), [429, 429], "the over-cap requests must settle 429 while the cap holds");
			assert.equal(await inFlight(), MAX_INFLIGHT, "inFlight must equal the cap during the hold (incremented at admission)");
			assert.ok(!settled.includes(-1), "no request may fail at the transport layer while the cap logic runs");

			// Release: the held requests drain, the counter returns to exactly 0.
			upstream.releaseAll();
			const all = await Promise.all(promises);
			const tally = new Map<number, number>();
			for (const s of all) tally.set(s, (tally.get(s) ?? 0) + 1);
			assert.equal(tally.get(200), MAX_INFLIGHT, "all admitted requests eventually drain with 200");
			assert.equal(tally.get(429), 2, "exactly the 2 over-cap requests were rejected");
			await waitFor(() => inFlight() === 0);
			assert.equal(await inFlight(), 0, "inFlight must return to exactly 0 (never negative) after all requests settle");
			const stats = inferenceBrokerStats();
			assert.equal(stats.length, 1);
			assert.equal(stats[0].workerKey, WORKER_KEY);
			assert.equal(stats[0].requests, MAX_INFLIGHT, "only admitted (forwarded) requests are counted");
		});
	} finally {
		upstream.releaseAll();
		await upstream.close();
	}
});

// ── (cap2) exactly-once release over repeated cycles ────────────────────

test("(cap2) sequential requests never leak slots: every request admitted, inFlight exactly 0 after each", async () => {
	const upstream = await startInstantUpstream();
	try {
		await withBrokerEnv(upstream.port, async (baseUrl, token) => {
			for (let i = 0; i < 6; i++) {
				const res = await brokerPost(baseUrl, token);
				assert.equal(res.status, 200, `request ${i + 1} must be admitted (a slot leak would 429 it)`);
				await res.arrayBuffer();
				await waitFor(() => inFlight() === 0);
				assert.equal(await inFlight(), 0, `slot must settle to 0 after request ${i + 1} (never negative, never stuck)`);
			}
		});
	} finally {
		await upstream.close();
	}
});

// ── (cap3) upstream failure releases the slot ───────────────────────────

test("(cap3) upstream failure (502) releases the slot; the next request is admitted again", async () => {
	const dead = await startInstantUpstream();
	const deadPort = dead.port;
	await dead.close(); // guaranteed-connection-refused loopback port
	await withBrokerEnv(deadPort, async (baseUrl, token) => {
		const res1 = await brokerPost(baseUrl, token);
		assert.equal(res1.status, 502, "admitted request against a dead upstream fails 502");
		await res1.arrayBuffer();
		await waitFor(() => inFlight() === 0);
		assert.equal(await inFlight(), 0, "the failed request must release its slot");
		const res2 = await brokerPost(baseUrl, token);
		assert.equal(res2.status, 502, "the next request must be ADMITTED (502 upstream failure), not 429 (cap)");
		await res2.arrayBuffer();
		await waitFor(() => inFlight() === 0);
		assert.equal(await inFlight(), 0);
	});
});

// ── (cap4) client abort mid-flight releases the slot ────────────────────

test("(cap4) client abort mid-flight releases the slot and the slot is reusable", async () => {
	const upstream = await startHoldingUpstream();
	try {
		await withBrokerEnv(upstream.port, async (baseUrl, token) => {
			const ac = new AbortController();
			const pending = brokerPost(baseUrl, token, { signal: ac.signal }).then(
				(r) => {
					void r.arrayBuffer();
					return r.status;
				},
				() => "aborted",
			);
			await waitFor(() => upstream.forwarded() >= 1);
			assert.equal(await inFlight(), 1, "slot taken while the request is in flight");
			ac.abort();
			assert.equal(await pending, "aborted");
			await waitFor(() => inFlight() === 0);
			assert.equal(await inFlight(), 0, "the client abort must release the slot");
			// the released slot is genuinely reusable:
			upstream.releaseAll();
			const res = await brokerPost(baseUrl, token);
			assert.equal(res.status, 200, "a follow-up request must be admitted on the released slot");
			await res.arrayBuffer();
			await waitFor(() => inFlight() === 0);
			assert.equal(await inFlight(), 0);
		});
	} finally {
		upstream.releaseAll();
		await upstream.close();
	}
});
