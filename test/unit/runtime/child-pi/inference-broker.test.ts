/**
 * inference-broker.test.ts — v0.11.31 (S-broker PoC) pins.
 *
 * Layers:
 *   (a) AUTH fail-closed: no token / wrong token / revoked token → 401.
 *   (b) SUBSTITUTION: the upstream receives the REAL key (x-api-key) — never
 *       the worker token; anthropic-version preserved; the real key never
 *       appears in any client-visible byte.
 *   (c) PER-WORKER: unique tokens; budget 429; revoke/revokeAll kill-switch;
 *       re-register replaces (kills) the old token; the token map is keyed
 *       by SHA-256 digest, never the raw secret (constant-time discipline).
 *   (d) SCOPED DIR: models.json reroutes anthropic to the broker with
 *       $PI_CREW_INFERENCE_TOKEN interpolation; NO auth.json; 0o600/0o700.
 *   (e) WIRING: buildFinalChildPiSpawnOptions with an active broker passes
 *       PI_CODING_AGENT_DIR + token and NEVER a provider key (even with an
 *       anthropic model chain); broker off keeps the legacy provider-key
 *       behavior (regression pin).
 *   (f) ensure() fail-closed: flag on + no upstream credential → throws.
 *   (g) LIVE e2e (linux + pi binary): a REAL `pi -p` run with the scoped
 *       agent dir + broker + mock upstream completes end-to-end — proving
 *       PI_CODING_AGENT_DIR scoping, models.json provider override, env
 *       interpolation, broker substitution, and SSE relay all work against
 *       the actual SDK.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildFinalChildPiSpawnOptions } from "../../../../src/runtime/child-pi/child-pi-spawn.ts";
import {
	__inferenceBrokerTokenMapKeysForTests,
	__resetInferenceBrokerForTests,
	getInferenceBrokerSnapshot,
	INFERENCE_BROKER_ENABLE_ENV,
	INFERENCE_TOKEN_ENV,
	inferenceBrokerStats,
	inferenceWorkerKeyForAgent,
	maybeStartInferenceBroker,
	PI_AGENT_DIR_ENV,
	registerInferenceWorker,
	revokeAllInferenceWorkers,
	revokeInferenceWorker,
	revokeInferenceWorkerForAgent,
	stopInferenceBroker,
} from "../../../../src/runtime/child-pi/inference-broker.ts";
import { getPiSpawnCommand } from "../../../../src/runtime/pi-spawn.ts";
import { readProcIdentity } from "../../../../src/runtime/process/reap-group.ts";
import { type FixtureHandle, reapFixture, registerFixtureTrap } from "../../../helpers/fixture-process.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const REAL_KEY = "sk-ant-realkey-do-not-leak-0123456789";

interface UpstreamCapture {
	headers: Record<string, string | string[] | undefined>;
	body: string;
	url: string;
	method: string;
}

/** Minimal Anthropic-shaped SSE response the SDK accepts end-to-end. */
function anthropicSse(text: string, usage: { input: number; output: number }): string {
	return [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_broker_1","type":"message","role":"assistant","model":"claude-broker","content":[],"usage":{"input_tokens":' +
			usage.input +
			',"output_tokens":1}}}',
		"",
		'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
		"",
		`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
		"",
		'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
		"",
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":' +
			usage.output +
			"}}",
		"",
		'event: message_stop\ndata: {"type":"message_stop"}',
		"",
	].join("\n");
}

interface MockUpstream {
	port: number;
	captures: UpstreamCapture[];
	close(): Promise<void>;
}

function startMockUpstream(opts?: { sse?: string; status?: number; contentType?: string }): Promise<MockUpstream> {
	const captures: UpstreamCapture[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			captures.push({
				headers: { ...req.headers },
				body: Buffer.concat(chunks).toString("utf8"),
				url: req.url ?? "/",
				method: req.method ?? "POST",
			});
			const status = opts?.status ?? 200;
			if (status !== 200) {
				const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "mock overloaded" } });
				res.writeHead(status, { "content-type": "application/json" });
				res.end(body);
				return;
			}
			// Compute the body ONCE — content-length must match what res.end()
			// actually sends (a mismatched "0" once silently emptied every
			// default-path response and cost a long debug detour).
			const body = opts?.sse ?? anthropicSse("BROKER-OK", { input: 12, output: 7 });
			res.writeHead(200, {
				"content-type": opts?.contentType ?? "text/event-stream",
				// deliberate framing headers the broker MUST strip:
				"content-encoding": "identity",
				"content-length": String(Buffer.byteLength(body)),
			});
			res.end(body);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				captures,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

async function brokerFetch(baseUrl: string, token: string | undefined, body: unknown, path = "/anthropic/v1/messages"): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "text/event-stream",
		"anthropic-version": "2023-06-01",
	};
	if (token !== undefined) headers["x-api-key"] = token;
	return fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** OpenAI chat-completions shaped SSE (the final usage chunk carries totals). */
function openaiSse(text: string, usage: { prompt: number; completion: number }): string {
	return [
		`data: {"id":"chatcmpl-broker","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}}}]}`,
		"",
		`data: {"id":"chatcmpl-broker","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":${usage.prompt},"completion_tokens":${usage.completion}}}`,
		"",
		"data: [DONE]",
		"",
	].join("\n");
}

/** Broker + mock upstream fixture (tests must call stop()). */
async function withBroker(
	run: (fn: { baseUrl: string; token: string; upstream: MockUpstream }) => Promise<void>,
	opts?: { budget?: number; sse?: string },
): Promise<void> {
	const upstream = await startMockUpstream({ sse: opts?.sse });
	const savedEnv: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CREW_INFERENCE_BUDGET_TOKENS",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = REAL_KEY;
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	if (opts?.budget !== undefined) process.env.PI_CREW_INFERENCE_BUDGET_TOKENS = String(opts.budget);
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.equal(snap.active, true, "broker snapshot must be active");
		const token = registerInferenceWorker("test-worker");
		await run({ baseUrl: snap.baseUrl, token, upstream });
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
}

// ── (a) AUTH fail-closed ────────────────────────────────────────────────

test("(a1) no token → 401, upstream untouched", async () => {
	await withBroker(async (fn) => {
		const res = await brokerFetch(fn.baseUrl, undefined, { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		const text = await res.text();
		assert.ok(!text.includes(REAL_KEY), "401 body must not leak the real key");
		assert.equal(fn.upstream.captures.length, 0, "unauthenticated request must never reach upstream");
	});
});

test("(a2) wrong token → 401, upstream untouched", async () => {
	await withBroker(async (fn) => {
		const res = await brokerFetch(fn.baseUrl, "deadbeef".repeat(8), { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		assert.equal(fn.upstream.captures.length, 0);
	});
});

test("(a3) revoked token → 401 (kill-switch)", async () => {
	await withBroker(async (fn) => {
		revokeInferenceWorker("test-worker");
		const res = await brokerFetch(fn.baseUrl, fn.token, { model: "claude-broker", messages: [] });
		assert.equal(res.status, 401);
		assert.equal(fn.upstream.captures.length, 0);
	});
});

// ── (b) SUBSTITUTION — the real key goes upstream, never to the client ──

test("(b1) upstream receives REAL x-api-key (never the worker token); anthropic-version preserved; body intact", async () => {
	await withBroker(async (fn) => {
		const payload = { model: "claude-broker", messages: [{ role: "user", content: "hi" }], stream: true };
		const res = await brokerFetch(fn.baseUrl, fn.token, payload);
		assert.equal(res.status, 200);
		await res.text(); // drain the SSE relay
		assert.equal(fn.upstream.captures.length, 1, "exactly one upstream request");
		const cap = fn.upstream.captures[0];
		assert.equal(cap.headers["x-api-key"], REAL_KEY, "upstream must see the REAL key");
		assert.notEqual(cap.headers["x-api-key"], fn.token, "upstream must NEVER see the worker token");
		assert.equal(cap.headers.authorization, undefined, "client auth must not leak as bearer");
		assert.equal(cap.headers["anthropic-version"], "2023-06-01");
		assert.deepEqual(JSON.parse(cap.body), payload, "request body must arrive byte-equivalent");
	});
});

test("(b2) SSE response relays byte-accurate; framing headers stripped; usage counted from message_start+message_delta", async () => {
	const sse = anthropicSse("BROKER-OK", { input: 33, output: 21 });
	await withBroker(
		async (fn) => {
			const res = await brokerFetch(fn.baseUrl, fn.token, { model: "claude-broker", messages: [] });
			assert.equal(res.headers.get("content-type"), "text/event-stream");
			assert.equal(res.headers.get("content-encoding"), null, "content-encoding must be stripped");
			assert.equal(res.headers.get("content-length"), null, "content-length must be stripped");
			const text = await res.text();
			assert.equal(text, sse, "SSE body must relay byte-accurate");
			await new Promise((r) => setTimeout(r, 50)); // let the res-close accounting land
			const stats = inferenceBrokerStats();
			assert.equal(stats.length, 1);
			assert.equal(stats[0].inputTokens, 33, "input usage counted from message_start");
			assert.equal(stats[0].outputTokens, 21, "output usage counted from message_delta (cumulative max)");
		},
		{ sse },
	);
});

test("(b3) bearer-token auth style: ANTHROPIC_AUTH_TOKEN upstream uses Authorization header", async () => {
	const upstream = await startMockUpstream();
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PI_CREW_INFERENCE_UPSTREAM"])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_AUTH_TOKEN = "oauth-bearer-real";
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		const token = registerInferenceWorker("bearer-worker");
		const res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		assert.equal(res.status, 200);
		await res.text();
		assert.equal(upstream.captures[0].headers.authorization, "Bearer oauth-bearer-real");
		assert.equal(upstream.captures[0].headers["x-api-key"], undefined);
		assert.equal(upstream.captures[0].url, "/v1/messages", "provider prefix must be stripped before forwarding");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
});

// ── (c) PER-WORKER isolation ────────────────────────────────────────────

test("(c1) workers get unique tokens; revoking one leaves the other working", async () => {
	await withBroker(async (fn) => {
		const t2 = registerInferenceWorker("worker-2");
		assert.notEqual(t2, fn.token, "tokens must be per-worker unique");
		revokeInferenceWorker("test-worker");
		const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
		assert.equal(r1.status, 401);
		const r2 = await brokerFetch(fn.baseUrl, t2, { model: "x", messages: [] });
		assert.equal(r2.status, 200);
		await r2.text();
	});
});

test("(c2) re-registering a workerKey kills the previous token (retry safety)", async () => {
	await withBroker(async (fn) => {
		const old = fn.token;
		const fresh = registerInferenceWorker("test-worker");
		assert.notEqual(fresh, old);
		const rOld = await brokerFetch(fn.baseUrl, old, { model: "x", messages: [] });
		assert.equal(rOld.status, 401, "old token must die on re-register");
		const rNew = await brokerFetch(fn.baseUrl, fresh, { model: "x", messages: [] });
		assert.equal(rNew.status, 200);
		await rNew.text();
	});
});

test("(c3) token budget: usage past the budget → 429 on the NEXT request", async () => {
	await withBroker(
		async (fn) => {
			const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			await r1.text();
			const stats = inferenceBrokerStats()[0];
			assert.ok(stats.inputTokens + stats.outputTokens > 0, "usage must have been counted");
		},
		{ budget: 1 },
	); // first response alone (33+21) blows past 1
	await withBroker(
		async (fn) => {
			const r1 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			await r1.text();
			const r2 = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
			assert.equal(r2.status, 429, "budget-exhausted worker must be refused");
			assert.ok((await r2.text()).includes("budget"), "429 must explain the budget");
		},
		{ budget: 10 },
	);
});

test("(c4) revokeAll flips every worker off", async () => {
	await withBroker(async (fn) => {
		registerInferenceWorker("worker-b");
		const n = revokeAllInferenceWorkers();
		assert.ok(n >= 2, `revokeAll must report the revoked workers (got ${n})`);
		const res = await brokerFetch(fn.baseUrl, fn.token, { model: "x", messages: [] });
		assert.equal(res.status, 401);
	});
});

test("(c5) constant-time discipline: the token map is keyed by SHA-256 digest, never the raw token", async () => {
	await withBroker(async (fn) => {
		const keys = __inferenceBrokerTokenMapKeysForTests();
		assert.equal(keys.length, 1, "one registered worker → one token-map entry");
		assert.ok(!keys.includes(fn.token), "the RAW token must never appear as a map key");
		assert.deepEqual(
			keys,
			[createHash("sha256").update(fn.token, "utf8").digest("hex")],
			"the key must be the SHA-256 hex digest of the token (crew-broker-tokens pattern)",
		);
	});
});

// ── (d) SCOPED AGENT DIR ────────────────────────────────────────────────

test("(d1) scoped dir: models.json reroutes anthropic to the broker with $PI_CREW_INFERENCE_TOKEN; NO auth.json; private modes", async () => {
	await withBroker(async (fn) => {
		const snap = getInferenceBrokerSnapshot();
		assert.ok(snap.scopedAgentDir, "scoped agent dir must exist");
		const files = fs.readdirSync(snap.scopedAgentDir);
		assert.deepEqual(files, ["models.json"], "scoped dir must contain ONLY models.json");
		const models = JSON.parse(fs.readFileSync(path.join(snap.scopedAgentDir, "models.json"), "utf8"));
		assert.equal(models.providers.anthropic.baseUrl, `${snap.baseUrl}/anthropic`);
		assert.equal(models.providers.anthropic.apiKey, `$${INFERENCE_TOKEN_ENV}`);
		// POSIX-only contract: Windows fs.statSync().mode is always 0o666
		// regardless of the requested mode (v0.11.21 CI lesson).
		if (process.platform !== "win32") {
			const mode = fs.statSync(path.join(snap.scopedAgentDir, "models.json")).mode & 0o777;
			assert.equal(mode, 0o600, "models.json must be owner-only");
		}
	});
});

// ── (e) WIRING into spawn options ───────────────────────────────────────

test("(e1) WIRING: active broker → child env gets PI_CODING_AGENT_DIR + token and NEVER a provider key", async () => {
	await withBroker(async () => {
		const opts = buildFinalChildPiSpawnOptions(
			process.cwd(),
			{ ...process.env, ANTHROPIC_API_KEY: REAL_KEY, PATH: process.env.PATH ?? "/usr/bin" } as NodeJS.ProcessEnv,
			{ [INFERENCE_TOKEN_ENV]: "worker-token-x", PI_CREW_CONTROL: "1" },
			"anthropic/claude-sonnet-5",
			["anthropic/claude-sonnet-5", "anthropic/claude-opus-4"],
		);
		const childEnv = opts.env ?? {};
		assert.equal(childEnv[PI_AGENT_DIR_ENV], getInferenceBrokerSnapshot().scopedAgentDir);
		assert.equal(childEnv[INFERENCE_TOKEN_ENV], "worker-token-x");
		assert.equal(childEnv.ANTHROPIC_API_KEY, undefined, "broker mode must NOT pass the real provider key");
	});
});

test("(e2) REGRESSION: broker off → provider keys flow per the legacy scoped allowlist; no broker env keys", () => {
	const saved = { [INFERENCE_BROKER_ENABLE_ENV]: process.env[INFERENCE_BROKER_ENABLE_ENV] };
	delete process.env[INFERENCE_BROKER_ENABLE_ENV];
	try {
		const opts = buildFinalChildPiSpawnOptions(
			process.cwd(),
			{ ANTHROPIC_API_KEY: REAL_KEY, PATH: "/usr/bin", HOME: "/home/x" } as NodeJS.ProcessEnv,
			{ PI_CREW_CONTROL: "1" },
			"anthropic/claude-sonnet-5",
		);
		const childEnv = opts.env ?? {};
		assert.equal(childEnv.ANTHROPIC_API_KEY, REAL_KEY, "legacy behavior: model-scoped provider key passes");
		assert.equal(childEnv[PI_AGENT_DIR_ENV], undefined, "no agent-dir override when broker off");
	} finally {
		if (saved[INFERENCE_BROKER_ENABLE_ENV] !== undefined) process.env[INFERENCE_BROKER_ENABLE_ENV] = saved[INFERENCE_BROKER_ENABLE_ENV];
	}
});

// ── (f) ensure() fail-closed ────────────────────────────────────────────

test("(f1) flag on + no upstream credential → throws (never silently falls back to real keys)", async () => {
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	try {
		__resetInferenceBrokerForTests();
		await assert.rejects(
			() => maybeStartInferenceBroker(),
			/ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/,
			"must throw naming the missing credential",
		);
	} finally {
		__resetInferenceBrokerForTests();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// ── (h) auth.json credential fallback (v0.11.34) ────────────────────────

test("(h1) auth.json api_key resolves when env credentials are absent; key goes upstream; env WINS over auth.json", async () => {
	// Fixture agent dir with an auth.json credential store (the documented
	// shape verified against the live SDK store).
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ib-authjson-"));
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({
			anthropic: { type: "api_key", key: "sk-ant-authjson-key" },
			openai: { type: "api_key", key: "sk-openai-authjson" },
		}),
	);
	const upstream = await startMockUpstream();
	const saved: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"OPENAI_API_KEY",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CODING_AGENT_DIR",
	])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	delete process.env.OPENAI_API_KEY;
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	process.env.PI_CODING_AGENT_DIR = agentDir; // parent reads ITS auth.json from here
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.deepEqual(snap.providers.sort(), ["anthropic", "openai"], "both auth.json providers resolve");
		const token = registerInferenceWorker("authjson-worker");
		const res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		assert.equal(res.status, 200);
		await res.text();
		assert.equal(upstream.captures[0].headers["x-api-key"], "sk-ant-authjson-key", "auth.json key substitutes upstream");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await removeDirWithRetry(agentDir);
		await upstream.close();
	}
	// env beats auth.json
	const agentDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ib-authjson-"));
	fs.writeFileSync(path.join(agentDir2, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-authjson-loser" } }));
	const upstream2 = await startMockUpstream();
	const saved2: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "PI_CREW_INFERENCE_UPSTREAM", "PI_CODING_AGENT_DIR"])
		saved2[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = "sk-env-winner";
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream2.port}`;
	process.env.PI_CODING_AGENT_DIR = agentDir2;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		const token = registerInferenceWorker("precedence-worker");
		const res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		await res.text();
		assert.equal(upstream2.captures[0].headers["x-api-key"], "sk-env-winner", "env credential must beat auth.json");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved2)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await removeDirWithRetry(agentDir2);
		await upstream2.close();
	}
});

// ── (i) multi-provider routing + openai usage (v0.11.34) ────────────────

test("(i1) both providers route by path prefix; openai gets Bearer, anthropic gets x-api-key; unknown prefix 404", async () => {
	const anthropicUp = await startMockUpstream();
	const openaiUp = await startMockUpstream({
		sse: openaiSse("OPENAI-OK", { prompt: 40, completion: 9 }),
		contentType: "text/event-stream",
	});
	const saved: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC",
		"PI_CREW_INFERENCE_UPSTREAM_OPENAI",
		"PI_CREW_INFERENCE_UPSTREAM",
	])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = "sk-ant-multi";
	process.env.OPENAI_API_KEY = "sk-oai-multi";
	delete process.env.PI_CREW_INFERENCE_UPSTREAM;
	process.env.PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${anthropicUp.port}`;
	process.env.PI_CREW_INFERENCE_UPSTREAM_OPENAI = `http://127.0.0.1:${openaiUp.port}`;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.deepEqual(snap.providers.sort(), ["anthropic", "openai"]);
		// scoped models.json covers BOTH providers with prefixed baseUrls
		const models = JSON.parse(fs.readFileSync(path.join(snap.scopedAgentDir ?? "", "models.json"), "utf8"));
		assert.equal(models.providers.anthropic.baseUrl, `${snap.baseUrl}/anthropic`);
		assert.equal(models.providers.openai.baseUrl, `${snap.baseUrl}/openai`);
		assert.equal(models.providers.openai.apiKey, `$${INFERENCE_TOKEN_ENV}`);
		const token = registerInferenceWorker("multi-worker");
		// openai route
		const oai = await fetch(`${snap.baseUrl}/openai/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: "{}",
		});
		const oaiBody = await oai.text();
		assert.equal(oai.status, 200);
		assert.ok(oaiBody.includes("OPENAI-OK"), "openai SSE relays");
		assert.equal(openaiUp.captures[0].headers.authorization, "Bearer sk-oai-multi", "openai upstream sees the REAL bearer");
		assert.equal(openaiUp.captures[0].url, "/chat/completions", "prefix stripped for openai");
		// anthropic route still works
		const ant = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		await ant.text();
		assert.equal(anthropicUp.captures[0].headers["x-api-key"], "sk-ant-multi");
		// unknown prefix → generic 404, no upstream touch
		const bad = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] }, "/google/v1:x");
		assert.equal(bad.status, 404);
		assert.equal(anthropicUp.captures.length, 1, "unknown route must not reach any upstream");
		// usage counted from the openai final chunk (prompt/completion names)
		await new Promise((r) => setTimeout(r, 60));
		const stats = inferenceBrokerStats()[0];
		// Usage is per-response and the worker total SUMS across requests:
		// openai (prompt 40 + completion 9) + anthropic default (input 12 + output 7).
		assert.equal(stats.inputTokens, 52, "prompt_tokens + later anthropic input accumulate");
		assert.equal(stats.outputTokens, 16, "completion_tokens + later anthropic output accumulate");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await anthropicUp.close();
		await openaiUp.close();
	}
});

// ── (g) LIVE e2e — REAL pi binary through the broker (linux) ────────────

/**
 * Safety-net SIGKILL for a LIVE `pi` run that never exits (ms).
 *
 * GAP-3 (fix-wave 12c-F3): this used to BE the teardown — `setTimeout(() =>
 * child.kill("SIGKILL"), 90_000).unref?.()` fired-and-forgotten inside the promise,
 * with no retained handle and no `finally`. Two holes: an `unref`'d timer never
 * fires if the host drains first (watchdog / CI timeout / suite abort leaves `pi`
 * running), and a pid-only kill never reaches `pi`'s bash-tool children. It is now
 * ARMED (ref'd), tracked and cleared in `finally`, and it is only a net — the
 * teardown is the group reap in {@link runLivePi}.
 */
const PI_RUN_SAFETY_NET_MS = 90_000;

/** `true` when `pid` is still a live process we can signal (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** What one LIVE `pi` invocation reports back. */
interface LivePiResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn the REAL `pi` for a LIVE case and OWN its teardown.
 *
 * `pi` is spawned `detached` (it becomes a session/group leader ⇒ `pgid === pid`)
 * and its `/proc` identity is snapshotted immediately, so `finally` can reap the
 * whole group through {@link reapFixture}: SIGTERM → SIGKILL escalation, every
 * signal re-validated against the spawn-time identity (pgid-reuse proof).
 *
 * `registerFixtureTrap` covers the abort window that a `finally` cannot: a throw
 * between spawn and teardown, or a file-level abort (`after()` + `process.on("exit")`).
 *
 * RESIDUAL, documented rather than faked (SPEC §3.3): `pi`'s bash-tool children
 * are spawned in their OWN groups (wave-11 GAP-0), so this group reap cannot reach
 * them. That is a src-level group-topology problem (tracked children / cgroup) and
 * out of scope for test teardown.
 */
async function runLivePi(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<LivePiResult> {
	const child = spawn(command, args, { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
	const pid = child.pid;
	if (!pid) throw new Error(`failed to spawn ${command} (spawn returned no pid)`);
	// Snapshot NOW (only readable while the pid is ours) and normalise `pgid`: a
	// detached child leads its own group, but an immediate /proc read can land
	// before its setsid and report the RUNNER's pgid instead.
	const raw = readProcIdentity(pid);
	const handle: FixtureHandle = { pid, pgid: pid, child, identity: raw ? { ...raw, pgid: pid } : undefined };
	registerFixtureTrap([handle]);
	let safetyNet: NodeJS.Timeout | undefined;
	try {
		return await new Promise<LivePiResult>((resolve) => {
			let settled = false;
			let stdout = "";
			let stderr = "";
			const settle = (result: LivePiResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
			child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
			child.on("exit", (code) => settle({ code, stdout, stderr }));
			// Spawn failure (missing binary, EACCES) must not hang the case.
			child.on("error", (err) => settle({ code: null, stdout, stderr: `${stderr}${String(err)}` }));
			safetyNet = setTimeout(() => child.kill("SIGKILL"), PI_RUN_SAFETY_NET_MS);
		});
	} finally {
		if (safetyNet !== undefined) clearTimeout(safetyNet);
		const reaped = await reapFixture(handle);
		// `ok: false` is EXPECTED on the happy path: a run that exited cleanly leaves
		// an empty group, which reapGroup reports as `identity-missing` (nothing to
		// signal) and reapFixture then degrades to a pid kill on a pid that is
		// already gone. Warn only when a process is ACTUALLY still there — that is
		// the leak this teardown exists for.
		if (!reaped.ok && pidAlive(pid)) {
			console.warn(`[inference-broker] pi fixture pid=${pid} still alive after reap (${reaped.reason ?? "unknown"})`);
		}
	}
}

test("(g1) LIVE: real `pi -p` completes via scoped dir + broker + mock upstream; upstream saw the real key; worker env had no real key", {
	skip: process.platform !== "linux",
}, async () => {
	const piCmd = getPiSpawnCommand([]);
	if (!piCmd.command || !fs.existsSync(piCmd.command)) {
		assert.ok(`pi binary not found (${piCmd.command})` === "skip");
		return;
	}
	await withBroker(async (fn) => {
		const snap = getInferenceBrokerSnapshot();
		const res = await runLivePi(piCmd.command, [...piCmd.args, "--mode", "json", "-p", "Reply with exactly BROKER-LIVE-OK"], {
			PATH: process.env.PATH ?? "/usr/bin",
			HOME: process.env.HOME ?? "/home",
			[PI_AGENT_DIR_ENV]: snap.scopedAgentDir ?? "",
			[INFERENCE_TOKEN_ENV]: fn.token,
			// NOTE: deliberately NO ANTHROPIC_API_KEY — the worker must
			// authenticate solely through the broker token.
		});
		// The run must complete and the model reply must have come through.
		assert.equal(res.code, 0, `pi exited code=${res.code}\nstdout=${res.stdout.slice(0, 800)}\nstderr=${res.stderr.slice(0, 800)}`);
		assert.ok(res.stdout.includes("BROKER-LIVE-OK"), "model reply must relay through the broker");
		// Upstream proof: the SDK hit the broker (not api.anthropic.com), with the real key.
		assert.ok(fn.upstream.captures.length >= 1, "mock upstream must have received the request");
		assert.equal(fn.upstream.captures[0].headers["x-api-key"], REAL_KEY);
	});
});

// ── (g2) LIVE e2e — REAL pi via the OPENAI route (linux) ────────────────

test("(g2) LIVE: real `pi -p` on an openai-completions model through the broker; upstream saw the real bearer; prefix stripped", {
	skip: process.platform !== "linux",
}, async () => {
	const piCmd = getPiSpawnCommand([]);
	if (!piCmd.command || !fs.existsSync(piCmd.command)) return;
	const openaiUp = await startMockUpstream({ sse: openaiSse("OPENAI-LIVE-OK", { prompt: 5, completion: 3 }) });
	const saved: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"PI_CREW_INFERENCE_UPSTREAM_OPENAI",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC",
	])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	delete process.env.ANTHROPIC_API_KEY;
	process.env.OPENAI_API_KEY = "sk-oai-live-real";
	delete process.env.PI_CREW_INFERENCE_UPSTREAM;
	delete process.env.PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC;
	process.env.PI_CREW_INFERENCE_UPSTREAM_OPENAI = `http://127.0.0.1:${openaiUp.port}`;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.deepEqual(snap.providers, ["openai"], "only the openai route resolves without anthropic creds");
		// The scoped dir covers the openai provider; add a TEST MODEL entry with
		// the openai-completions api so the run uses the /chat/completions wire
		// (built-in gpt models use the responses api — the route forwards that
		// verbatim too, but the mock speaks chat-completions).
		const modelsPath = path.join(snap.scopedAgentDir ?? "", "models.json");
		const models = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
		models.providers.openai.models = [{ id: "broker-openai-live", api: "openai-completions" }];
		fs.writeFileSync(modelsPath, JSON.stringify(models, null, "\t"));
		const token = registerInferenceWorker("openai-live");
		const res = await runLivePi(
			piCmd.command,
			[...piCmd.args, "--mode", "json", "-p", "Reply with exactly OPENAI-LIVE-OK", "--model", "openai/broker-openai-live"],
			{
				PATH: process.env.PATH ?? "/usr/bin",
				HOME: process.env.HOME ?? "/home",
				PI_CODING_AGENT_DIR: snap.scopedAgentDir ?? "",
				[INFERENCE_TOKEN_ENV]: token,
			},
		);
		assert.equal(res.code, 0, `pi exited code=${res.code}\nstdout=${res.stdout.slice(0, 800)}\nstderr=${res.stderr.slice(0, 800)}`);
		assert.ok(res.stdout.includes("OPENAI-LIVE-OK"), "openai reply must relay through the broker");
		assert.ok(openaiUp.captures.length >= 1, "openai mock upstream received the request");
		assert.equal(openaiUp.captures[0].headers.authorization, "Bearer sk-oai-live-real");
		assert.equal(openaiUp.captures[0].url, "/chat/completions");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await openaiUp.close();
	}
});

// ── (j) v0.11.36 google provider route (native google-generative-ai wire) ──

/** Google native SSE shape: cumulative usageMetadata on stream chunks. */
function googleSse(text: string, usage: { prompt: number; candidates: number; thoughts: number }): string {
	return [
		`data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}],"role":"model"}}],"usageMetadata":{"promptTokenCount":${usage.prompt},"candidatesTokenCount":1,"thoughtsTokenCount":1}}`,
		"",
		`data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":${usage.prompt},"candidatesTokenCount":${usage.candidates},"thoughtsTokenCount":${usage.thoughts},"totalTokenCount":${usage.prompt + usage.candidates + usage.thoughts}}}`,
		"",
		"",
	].join("\n");
}

async function googleBrokerFetch(baseUrl: string, token: string, path: string): Promise<Response> {
	// The pi google-generative-ai client carries apiKey as x-goog-api-key.
	return fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream", "x-goog-api-key": token },
		body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
	});
}

test("(j1) google route: x-goog-api-key substitution, /v1beta path forwarding, usageMetadata counting, models.json suffix", async () => {
	const upstream = await startMockUpstream({ sse: googleSse("GOOG-OK", { prompt: 40, candidates: 9, thoughts: 3 }) });
	const saved: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CREW_INFERENCE_UPSTREAM_GOOGLE",
	])
		saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = REAL_KEY; // second provider — proves routing isolation
	process.env.GOOGLE_API_KEY = "goog-real-key-123";
	process.env.PI_CREW_INFERENCE_UPSTREAM_GOOGLE = `http://127.0.0.1:${upstream.port}`;
	delete process.env.PI_CREW_INFERENCE_UPSTREAM;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		assert.ok(snap.providers.includes("google"), "google route resolves from GOOGLE_API_KEY");
		assert.ok(snap.scopedAgentDir, "scoped agent dir exists");
		const models = JSON.parse(fs.readFileSync(path.join(snap.scopedAgentDir!, "models.json"), "utf8"));
		assert.equal(
			models.providers.google.baseUrl,
			`http://127.0.0.1:${snap.port}/google`,
			"google baseUrl is the BARE /google prefix (the /v1beta lives in the upstream default, not duplicated here)",
		);
		const token = registerInferenceWorker("google-worker");
		const res = await googleBrokerFetch(snap.baseUrl, token, "/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
		assert.equal(res.status, 200);
		await res.text();
		const cap = upstream.captures[0];
		assert.equal(
			cap.url,
			"/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
			"the /google prefix is stripped; the rest (incl. query) forwards verbatim",
		);
		assert.equal(cap.headers["x-goog-api-key"], "goog-real-key-123", "REAL google key substitutes upstream");
		assert.equal(cap.headers.authorization, undefined, "no Bearer on the google wire");
		assert.equal(cap.headers["x-api-key"], undefined, "no anthropic x-api-key on the google wire");
		assert.notEqual(cap.headers["x-goog-api-key"], token, "worker token never reaches the upstream");
		const stats = inferenceBrokerStats().find((s) => s.workerKey === "google-worker");
		assert.equal(stats?.inputTokens, 40, "usageMetadata.promptTokenCount counted as input");
		assert.equal(stats?.outputTokens, 12, "candidatesTokenCount(9) + thoughtsTokenCount(3) counted as output");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
});

test("(j2) google credential precedence: GOOGLE_API_KEY > GEMINI_API_KEY > auth.json:google", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-ib-authjson-"));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ google: { type: "api_key", key: "goog-authjson-loser" } }));
	const upstream = await startMockUpstream();
	const saved: Record<string, string | undefined> = {};
	for (const key of [
		INFERENCE_BROKER_ENABLE_ENV,
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"PI_CREW_INFERENCE_UPSTREAM",
		"PI_CREW_INFERENCE_UPSTREAM_GOOGLE",
		"PI_CODING_AGENT_DIR",
	])
		saved[key] = process.env[key];
	delete process.env.PI_CREW_INFERENCE_UPSTREAM;
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.PI_CREW_INFERENCE_UPSTREAM_GOOGLE = `http://127.0.0.1:${upstream.port}`;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		// auth.json alone resolves
		__resetInferenceBrokerForTests();
		delete process.env.GOOGLE_API_KEY;
		delete process.env.GEMINI_API_KEY;
		await maybeStartInferenceBroker();
		assert.ok(getInferenceBrokerSnapshot().providers.includes("google"), "auth.json:google resolves");
		stopInferenceBroker();
		// GEMINI_API_KEY beats auth.json
		__resetInferenceBrokerForTests();
		process.env.GEMINI_API_KEY = "goog-gemini-env";
		await maybeStartInferenceBroker();
		let token = registerInferenceWorker("g-prec-1");
		let res = await googleBrokerFetch(getInferenceBrokerSnapshot().baseUrl, token, "/google/models/x:streamGenerateContent");
		await res.text();
		assert.equal(upstream.captures.at(-1)?.headers["x-goog-api-key"], "goog-gemini-env", "GEMINI_API_KEY beats auth.json");
		stopInferenceBroker();
		// GOOGLE_API_KEY beats both
		__resetInferenceBrokerForTests();
		process.env.GOOGLE_API_KEY = "goog-primary-env";
		await maybeStartInferenceBroker();
		token = registerInferenceWorker("g-prec-2");
		res = await googleBrokerFetch(getInferenceBrokerSnapshot().baseUrl, token, "/google/models/x:streamGenerateContent");
		await res.text();
		assert.equal(upstream.captures.at(-1)?.headers["x-goog-api-key"], "goog-primary-env", "GOOGLE_API_KEY wins");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await removeDirWithRetry(agentDir);
		await upstream.close();
	}
});

// ── (k) v0.11.36 exit-revoke helpers ────────────────────────────────────

test("(k1) inferenceWorkerKeyForAgent + revokeInferenceWorkerForAgent: token dies on the next request; broker-off and agentId-less are no-ops", async () => {
	assert.equal(inferenceWorkerKeyForAgent("t-42"), "inference:t-42", "deterministic key shared with the spawn side");
	assert.equal(revokeInferenceWorkerForAgent(undefined), false, "agentId-less spawn: no-op (unique key, dies at broker stop)");
	assert.equal(revokeInferenceWorkerForAgent("t-42"), false, "broker off: no-op, never throws");
	const upstream = await startMockUpstream();
	const saved: Record<string, string | undefined> = {};
	for (const key of [INFERENCE_BROKER_ENABLE_ENV, "ANTHROPIC_API_KEY", "PI_CREW_INFERENCE_UPSTREAM"]) saved[key] = process.env[key];
	process.env[INFERENCE_BROKER_ENABLE_ENV] = "1";
	process.env.ANTHROPIC_API_KEY = REAL_KEY;
	process.env.PI_CREW_INFERENCE_UPSTREAM = `http://127.0.0.1:${upstream.port}`;
	try {
		__resetInferenceBrokerForTests();
		await maybeStartInferenceBroker();
		const snap = getInferenceBrokerSnapshot();
		const token = registerInferenceWorker(inferenceWorkerKeyForAgent("t-42"));
		let res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		assert.equal(res.status, 200);
		await res.text();
		assert.equal(revokeInferenceWorkerForAgent("t-42"), true, "active worker revoked");
		res = await brokerFetch(snap.baseUrl, token, { model: "x", messages: [] });
		assert.equal(res.status, 401, "revoked token dies on the NEXT request");
		assert.equal(revokeInferenceWorkerForAgent("t-42"), false, "second revoke of the same key: already gone");
	} finally {
		stopInferenceBroker();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await upstream.close();
	}
});
