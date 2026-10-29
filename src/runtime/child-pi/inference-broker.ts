/**
 * inference-broker.ts — v0.11.31 (S-broker PoC): loopback inference broker.
 *
 * WHY (the A7 endgame continuation): S\* (v0.11.30) made the child env EXACT
 * the intended allowlisted set, but the intended set still must include a
 * credential the child can USE to call its LLM — and any real provider key
 * in the child is a reusable secret a prompt-injected worker could exfiltrate.
 * The broker removes that requirement entirely: the child's ONLY credential
 * is a per-worker token valid exclusively at this process's loopback proxy,
 * which substitutes the real upstream key after the request leaves the
 * worker. The real key never exists in any surface the worker can reach —
 * env (S\* shadows it), auth.json (scoped agent dir has none), or process
 * memory. Same pattern Docker Sandboxes/OpenShell sell as "credential
 * substitution", self-hosted in-process (zero infrastructure).
 *
 * Model routing: the scoped agent dir's models.json overrides ONLY the
 * built-in "anthropic" provider endpoint + apiKey (pi preserves built-in
 * model metadata when a models.json provider entry supplies just baseUrl —
 * docs/models.md "Configure a compatible endpoint"), so `--model
 * anthropic/<id>` and bare `<id>` resolve exactly as before, but every
 * request goes to 127.0.0.1:<port> with `x-api-key: $PI_CREW_INFERENCE_TOKEN`
 * interpolated from the CHILD's env at request time. No model metadata is
 * mirrored, no ids are rewritten, fallback chains inside anthropic work.
 *
 * Credential sources (parent side): ANTHROPIC_API_KEY (x-api-key upstream)
 * or ANTHROPIC_AUTH_TOKEN (Authorization: Bearer upstream) — the documented
 * env-var credential path (models.md "provide an API key through the
 * provider's environment variable… useful in CI"). auth.json-only users are
 * NOT supported by this PoC (reading the parent's auth.json into the broker
 * is a separate, sensitive workstream). FAIL-CLOSED: PI_CREW_INFERENCE_BROKER=1
 * with neither env var present THROWS at the first spawn — never silently
 * falls back to passing real keys to workers.
 *
 * Enforcement: per-worker random 256-bit token; per-worker request budget
 * (PI_CREW_INFERENCE_BUDGET_TOKENS, 0 = unlimited) counted from streamed
 * Anthropic usage events; per-worker in-flight cap; revoke(workerKey) /
 * revokeAll() kill-switch (revoked token → 401 on the NEXT request; in-flight
 * requests are allowed to drain — killing sockets mid-stream corrupts
 * transcripts without adding security, the token is already dead). The token
 * map is keyed by the SHA-256 digest of each token, never the raw secret
 * (constant-time discipline, same pattern as crew-broker-tokens.ts); after
 * registerInferenceWorker hands the raw token to the caller, the broker
 * retains only its digest.
 *
 * Honest boundary: the broker protects the REUSABLE CREDENTIAL channel only.
 * A worker can still read other host files (~/.ssh, ~/.aws, ~/.pi/agent/
 * auth.json via bash) and make arbitrary network egress — those need an OS
 * boundary (container/bwrap), which is a separate documented workstream.
 *
 * Version history: v0.11.30 (S\*) made env exact; THIS module removes the
 * need for any real credential to be in the env at all.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { getCrewEnv, getCrewEnvBool, getCrewEnvInt } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { createSafeTempDir, getPiTempBase } from "../model/pi-args.ts";

// ── Env contract ─────────────────────────────────────────────────────────
// All child-side vars are control-namespace (PI_CREW_*) except
// PI_CODING_AGENT_DIR, which is pi's OWN native override (read by the SDK
// config loader) — it is injected at the spawn-options layer, never through
// built.env, so assertOnlyControlEnvKeys' contract is untouched.
export const INFERENCE_BROKER_ENABLE_ENV = "PI_CREW_INFERENCE_BROKER";
export const INFERENCE_TOKEN_ENV = "PI_CREW_INFERENCE_TOKEN";
export const INFERENCE_BUDGET_ENV = "PI_CREW_INFERENCE_BUDGET_TOKENS";
/** pi-native agent-dir override (SDK config.js ENV_AGENT_DIR) — set on the child. */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const MAX_BODY_BYTES = 64 * 1024 * 1024; // generous: image attachments
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INFLIGHT_PER_WORKER = 4;

/** Upstream headers we forward (client auth headers are NEVER forwarded). */
const FORWARD_REQUEST_HEADERS = new Set([
	"content-type",
	"accept",
	"anthropic-version",
	"anthropic-beta",
	"user-agent",
	"x-stainless-retry-count",
	"x-stainless-timeout",
	"x-request-id",
]);
/** Response headers we must NOT copy (undici already decoded the body). */
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

interface WorkerEntry {
	workerKey: string;
	/** SHA-256 hex digest of the worker token — the RAW secret is handed to
	 *  the caller by registerInferenceWorker and never retained here
	 *  (constant-time discipline, fix-wave TASK [5]). */
	tokenDigest: string;
	revoked: boolean;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	inFlight: number;
	maxTokens: number;
}

/** Map key for the per-worker token registry: the SHA-256 hex digest of the
 * token, NEVER the raw secret — mirrors BrokerTokenRegistry.hashToken
 * (runtime/broker/crew-broker-tokens.ts). Hashed locally with the identical
 * implementation instead of importing the registry class, so this module's
 * static import graph is untouched. */
function tokenKey(token: string): string {
	return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface InferenceBrokerSnapshot {
	active: boolean;
	baseUrl: string;
	port: number;
	scopedAgentDir: string | undefined;
	/** Provider names with a resolvable upstream credential (v0.11.34). */
	providers: string[];
}

/** One provider's upstream route: base URL + substituted auth header. The
 * upstream DEFAULT carries the provider's version path (openai …/v1, google
 * …/v1beta) exactly like the built-in models' baseUrls do — the scoped
 * models.json replaces the WHOLE baseUrl with a bare /<provider> prefix, so
 * the version path must never be duplicated on the broker side. */
interface ProviderRoute {
	name: "anthropic" | "openai" | "google";
	upstream: string;
	auth: { header: "x-api-key" | "authorization" | "x-goog-api-key"; value: string };
}

interface BrokerState {
	server: http.Server;
	port: number;
	routes: Map<string, ProviderRoute>; // by path prefix ("/anthropic", "/openai")
	workers: Map<string, WorkerEntry>; // by SHA-256 token digest (never the raw secret)
	byKey: Map<string, WorkerEntry>; // by workerKey
	scopedAgentDir: string;
}

// Module-level singleton (same pattern as the env-splice canary window).
// Started lazily by ensureInferenceBroker() from prepareSpawnContext;
// stopped by stopInferenceBroker() (extension teardown / tests).
let broker: BrokerState | undefined;

/**
 * Read the PARENT's auth.json credential store — the documented file shape is
 * `{ "<provider>": { "type": "api_key", "key": "..." } }` (verified against
 * the SDK store + a live file). Read ONCE at broker start; the key stays in
 * memory exactly like an env-sourced key. Parse failures are logged WITHOUT
 * the key and ignored (env credentials still work).
 */
function readAuthJsonCredentials(env: NodeJS.ProcessEnv): Record<string, { type?: string; key?: string }> {
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const authPath = path.join(agentDir, "auth.json");
	try {
		const raw = fs.readFileSync(authPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as Record<string, { type?: string; key?: string }>;
	} catch {
		return {}; // absent/unreadable/malformed — env credentials remain the path
	}
}

/**
 * Resolve every provider route (v0.11.34 multi-provider). Precedence per
 * provider: env credential FIRST (CI behavior identical to v0.11.33), then
 * the parent's auth.json file credential. Returns the routes that resolved
 * and a human-readable trace of what was consulted (never contains keys).
 */
function resolveProviderRoutes(env: NodeJS.ProcessEnv): { routes: ProviderRoute[]; trace: string } {
	const authJson = readAuthJsonCredentials(env);
	const genericUpstream = getCrewEnv("PI_CREW_INFERENCE_UPSTREAM", env); // tests: applies to every provider
	const routes: ProviderRoute[] = [];
	const consulted: string[] = [];

	const anthropicUpstream = getCrewEnv("PI_CREW_INFERENCE_UPSTREAM_ANTHROPIC", env) || genericUpstream || "https://api.anthropic.com";
	const anthropicApiKey = env.ANTHROPIC_API_KEY;
	const anthropicAuthToken = env.ANTHROPIC_AUTH_TOKEN;
	const anthropicStored = authJson.anthropic;
	consulted.push("env ANTHROPIC_API_KEY", "env ANTHROPIC_AUTH_TOKEN", "auth.json:anthropic");
	if (anthropicApiKey && anthropicApiKey.length > 0) {
		routes.push({ name: "anthropic", upstream: anthropicUpstream, auth: { header: "x-api-key", value: anthropicApiKey } });
	} else if (anthropicAuthToken && anthropicAuthToken.length > 0) {
		routes.push({
			name: "anthropic",
			upstream: anthropicUpstream,
			auth: { header: "authorization", value: `Bearer ${anthropicAuthToken}` },
		});
	} else if (anthropicStored?.type === "api_key" && typeof anthropicStored.key === "string" && anthropicStored.key.length > 0) {
		routes.push({ name: "anthropic", upstream: anthropicUpstream, auth: { header: "x-api-key", value: anthropicStored.key } });
	}

	const openaiUpstream = getCrewEnv("PI_CREW_INFERENCE_UPSTREAM_OPENAI", env) || genericUpstream || "https://api.openai.com/v1";
	const openaiApiKey = env.OPENAI_API_KEY;
	const openaiStored = authJson.openai;
	consulted.push("env OPENAI_API_KEY", "auth.json:openai");
	if (openaiApiKey && openaiApiKey.length > 0) {
		routes.push({ name: "openai", upstream: openaiUpstream, auth: { header: "authorization", value: `Bearer ${openaiApiKey}` } });
	} else if (openaiStored?.type === "api_key" && typeof openaiStored.key === "string" && openaiStored.key.length > 0) {
		routes.push({ name: "openai", upstream: openaiUpstream, auth: { header: "authorization", value: `Bearer ${openaiStored.key}` } });
	}

	// v0.11.36 google (native google-generative-ai wire): the built-in google
	// provider speaks `x-goog-api-key` and paths under /v1beta (verified against
	// the pi catalog: ids like "gemini-2.5-pro", baseUrl ...
	// /v1beta). Credential precedence mirrors the others: env FIRST
	// (GOOGLE_API_KEY, then GEMINI_API_KEY — both conventional), then auth.json:google.
	const googleUpstream =
		getCrewEnv("PI_CREW_INFERENCE_UPSTREAM_GOOGLE", env) || genericUpstream || "https://generativelanguage.googleapis.com/v1beta";
	const googleApiKey = env.GOOGLE_API_KEY;
	const geminiApiKey = env.GEMINI_API_KEY;
	const googleStored = authJson.google;
	consulted.push("env GOOGLE_API_KEY", "env GEMINI_API_KEY", "auth.json:google");
	const googleCredential =
		googleApiKey && googleApiKey.length > 0
			? googleApiKey
			: geminiApiKey && geminiApiKey.length > 0
				? geminiApiKey
				: googleStored?.type === "api_key" && typeof googleStored.key === "string" && googleStored.key.length > 0
					? googleStored.key
					: undefined;
	if (googleCredential) {
		routes.push({ name: "google", upstream: googleUpstream, auth: { header: "x-goog-api-key", value: googleCredential } });
	}

	return { routes, trace: consulted.join(", ") };
}

/**
 * Idempotent lazy start (ASYNC — http listen needs an event-loop turn; call
 * sites: child-pi.ts run() BEFORE prepareSpawnContext, which stays sync).
 * Returns the live snapshot, or `{active:false}` when the feature flag is
 * off. FAIL-CLOSED: flag on + no upstream credential → THROWS (the run fails
 * loudly; workers must never silently fall back to receiving real provider
 * keys).
 */
export async function maybeStartInferenceBroker(env: NodeJS.ProcessEnv = process.env): Promise<InferenceBrokerSnapshot> {
	if (broker)
		return {
			active: true,
			baseUrl: `http://127.0.0.1:${broker.port}`,
			port: broker.port,
			scopedAgentDir: broker.scopedAgentDir,
			providers: [...broker.routes.values()].map((r) => r.name),
		};
	if (!getCrewEnvBool(INFERENCE_BROKER_ENABLE_ENV))
		return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined, providers: [] };

	const { routes, trace } = resolveProviderRoutes(env);
	if (routes.length === 0) {
		throw new Error(
			`${INFERENCE_BROKER_ENABLE_ENV}=1 but no provider credential resolved for the inference broker (consulted: ${trace}) — fail-closed: workers would otherwise receive no usable credential, or worse, fall back to real provider keys. Provide ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY / GOOGLE_API_KEY / GEMINI_API_KEY in the parent env, an api_key entry for anthropic/openai/google in the parent's auth.json, or unset ${INFERENCE_BROKER_ENABLE_ENV}.`,
		);
	}
	broker = await createBrokerServer(routes);
	return {
		active: true,
		baseUrl: `http://127.0.0.1:${broker.port}`,
		port: broker.port,
		scopedAgentDir: broker.scopedAgentDir,
		providers: [...broker.routes.values()].map((r) => r.name),
	};
}

/**
 * SYNC guard for the spawn path: when the flag is on, the broker MUST already
 * be running (child-pi.ts run() awaits maybeStartInferenceBroker() first).
 * Direct prepareSpawnContext callers under an active flag without a started
 * broker get a loud programming error instead of a keyless worker.
 */
export function requireInferenceBrokerIfEnabled(): InferenceBrokerSnapshot {
	if (broker)
		return {
			active: true,
			baseUrl: `http://127.0.0.1:${broker.port}`,
			port: broker.port,
			scopedAgentDir: broker.scopedAgentDir,
			providers: [...broker.routes.values()].map((r) => r.name),
		};
	if (!getCrewEnvBool(INFERENCE_BROKER_ENABLE_ENV))
		return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined, providers: [] };
	throw new Error(
		`${INFERENCE_BROKER_ENABLE_ENV}=1 but the broker is not started — run() must await maybeStartInferenceBroker() before prepareSpawnContext()`,
	);
}

/** Read-only view for spawn-option builders. Never starts anything. */
export function getInferenceBrokerSnapshot(): InferenceBrokerSnapshot {
	if (!broker) return { active: false, baseUrl: "", port: 0, scopedAgentDir: undefined, providers: [] };
	return {
		active: true,
		baseUrl: `http://127.0.0.1:${broker.port}`,
		port: broker.port,
		scopedAgentDir: broker.scopedAgentDir,
		providers: [...broker.routes.values()].map((r) => r.name),
	};
}

async function createBrokerServer(routes: ProviderRoute[]): Promise<BrokerState> {
	const workers = new Map<string, WorkerEntry>();
	const byKey = new Map<string, WorkerEntry>();
	const routeMap = new Map<string, ProviderRoute>(routes.map((r) => [`/${r.name}`, r]));

	const server = http.createServer((req, res) => {
		void handleRequest(req, res, { routes: routeMap, workers });
	});
	server.unref(); // never hold the parent's event loop open
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("inference broker failed to bind a loopback port");
	const port = address.port;

	const scopedAgentDir = buildScopedAgentDir(port, routes);

	return { server, port, routes: routeMap, workers, byKey, scopedAgentDir };
}

/**
 * Scoped agent dir for workers: models.json ONLY — no auth.json, no
 * extensions, no skills, no settings. The single override reroutes the
 * built-in anthropic provider to the broker with per-worker token
 * interpolation at request time. Mode 0o600 file / 0o700 dir.
 */
function buildScopedAgentDir(port: number, routes: ProviderRoute[]): string {
	const dir = createSafeTempDir(getPiTempBase(), "pi-crew-inference-");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Every resolvable provider gets a PATH-PREFIXED baseUrl ("/anthropic",
	// "/openai") so the broker routes deterministically by prefix and forwards
	// the remaining path verbatim to that provider's upstream.
	const providers: Record<string, { baseUrl: string; apiKey: string }> = {};
	for (const route of routes) {
		providers[route.name] = {
			baseUrl: `http://127.0.0.1:${port}/${route.name}`,
			apiKey: `$${INFERENCE_TOKEN_ENV}`,
		};
	}
	const models = {
		$schema: "https://pi.dev/schemas/models.schema.json",
		providers,
	};
	const file = path.join(dir, "models.json");
	fs.writeFileSync(file, `${JSON.stringify(models, null, "\t")}\n`, { mode: 0o600 });
	return dir;
}

/** Extract the caller token from x-api-key, x-goog-api-key, or Authorization: Bearer. */
function extractToken(req: http.IncomingMessage): string | undefined {
	const apiKey = req.headers["x-api-key"];
	if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
	const googKey = req.headers["x-goog-api-key"];
	if (typeof googKey === "string" && googKey.length > 0) return googKey;
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
	return undefined;
}

function deny(res: http.ServerResponse, status: number, message: string): void {
	const body = JSON.stringify({ type: "error", error: { type: "pi_crew_broker_error", message } });
	res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
	res.end(body);
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	ctx: { routes: Map<string, ProviderRoute>; workers: Map<string, WorkerEntry> },
): Promise<void> {
	// Assigned AFTER concurrency admission (step 2b). The catch path releases
	// the slot for body-read/upstream failures that bypass the normal
	// response-close settlement; the release itself is idempotent.
	let releaseSlot: (() => void) | undefined;
	try {
		// (0) Provider routing: the FIRST path segment names the provider
		// ("/anthropic/v1/messages", "/openai/chat/completions"); the broker
		// forwards the REMAINING path verbatim to that provider's upstream.
		const url = req.url ?? "/";
		let route: ProviderRoute | undefined;
		let upstreamPath = url;
		for (const [prefix, candidate] of ctx.routes) {
			if (url === prefix || url.startsWith(`${prefix}/`)) {
				route = candidate;
				upstreamPath = url.slice(prefix.length) || "/";
				break;
			}
		}
		if (!route) {
			deny(res, 404, "unknown provider route (expected /anthropic/..., /openai/..., or /google/...)");
			return;
		}
		// (1) Auth — fail-closed, generic errors (never echo tokens).
		const token = extractToken(req);
		const worker = token ? ctx.workers.get(tokenKey(token)) : undefined;
		if (!worker || worker.revoked) {
			deny(res, 401, "invalid or revoked inference token");
			return;
		}
		// (2) Budget + concurrency (per worker).
		if (worker.maxTokens > 0 && worker.inputTokens + worker.outputTokens >= worker.maxTokens) {
			deny(res, 429, "worker inference token budget exhausted");
			return;
		}
		if (worker.inFlight >= MAX_INFLIGHT_PER_WORKER) {
			deny(res, 429, "too many concurrent inference requests for this worker");
			return;
		}
		// (2b) Take the concurrency slot BEFORE the body read, and release it
		// EXACTLY once on every post-admission exit path: the "close" handler
		// covers normal completion, client aborts, and post-admission denies
		// (deny() ends the response → close fires), and the idempotent guard
		// makes the explicit catch-path call a no-op when close already fired.
		// Without the matching increment the >= cap gate above was dead code
		// (inFlight only ever walked negative after the first response close),
		// so one valid worker token could hold unbounded concurrent requests —
		// each buffering up to MAX_BODY_BYTES in parent-process memory — for
		// the life of the token.
		worker.inFlight += 1;
		const usage = new UsageCounter();
		let settled = false;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			worker.inFlight -= 1;
			worker.inputTokens += usage.input;
			worker.outputTokens += usage.output;
		};
		releaseSlot = settle;
		res.on("close", settle);
		// (3) Read the request body (bounded).
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) {
				settle();
				deny(res, 413, "request body too large");
				return;
			}
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		// (4) Forward — client auth headers DROPPED, real key substituted.
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (!FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) continue;
			if (typeof value === "string") headers[name.toLowerCase()] = value;
		}
		headers[route.auth.header] = route.auth.value;
		const upstreamRes = await fetch(`${route.upstream}${upstreamPath}`, {
			// eslint-disable-next-line
			method: req.method ?? "POST",
			headers,
			body: body.length > 0 ? body : undefined,
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		// (5) Relay the response — strip transport framing, stream through,
		//     count usage from Anthropic SSE events / JSON bodies on the way.
		const outHeaders: Record<string, string> = {};
		upstreamRes.headers.forEach((value, name) => {
			if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) outHeaders[name.toLowerCase()] = value;
		});
		res.writeHead(upstreamRes.status, outHeaders);
		worker.requests += 1;
		// Slot settlement + usage accounting were wired at admission (2b);
		// "close" fires here on normal completion (res.end / pipe drain).
		if (!upstreamRes.body) {
			res.end();
			return;
		}
		const nodeStream = Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream);
		nodeStream.on("error", (e) => {
			console.error("[ib-debug] nodeStream error:", e?.message);
			res.destroy();
		});
		nodeStream.pipe(usage.tee).pipe(res);
	} catch (error) {
		// Release the admitted concurrency slot for body-read/upstream failures
		// (client abort mid-body, fetch throw, ...) — idempotent when the
		// response close already settled it.
		releaseSlot?.();
		logInternalError("inference-broker.forward", undefined, error instanceof Error ? error.message : String(error), "warn");
		if (!res.headersSent) deny(res, 502, "inference broker upstream failure");
		else res.destroy();
	}
}

/**
 * Count Anthropic usage from a streamed response without buffering it:
 * SSE `message_start` carries usage.input_tokens; `message_delta` carries
 * usage.output_tokens (cumulative — take max). Non-stream JSON bodies carry a
 * top-level usage object (also scanned — `data:`-less lines are parsed
 * defensively). `message_start` nests usage under evt.message.usage.
 */
class UsageCounter {
	input = 0;
	output = 0;
	private leftover = "";
	// NB: named `tee` — a field named `transform` would SHADOW the Transform
	// base class method slot and silently break piping.
	readonly tee = new Transform({
		transform: (chunk: Buffer, _enc: string, cb: (e: Error | null, d?: Buffer) => void) => {
			this.scan(chunk);
			cb(null, chunk);
		},
	});

	private scan(chunk: Buffer): void {
		const text = this.leftover + chunk.toString("utf8");
		const lines = text.split("\n");
		this.leftover = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed.startsWith("{") ? trimmed : "";
			if (!payload || payload === "[DONE]") continue;
			try {
				const evt = JSON.parse(payload);
				// SSE message_start: usage nested under evt.message.usage.
				// SSE message_delta: evt.usage.output_tokens is CUMULATIVE (take max).
				// Non-stream JSON body: top-level evt.usage, both absolute.
				const usage = evt?.message?.usage ?? evt?.usage;
				// Google native (google-generative-ai): usageMetadata with
				// promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount) —
				// CUMULATIVE per stream, so max() below lands on the final totals.
				const meta = evt?.usageMetadata;
				if (meta && typeof meta === "object") {
					const prompt = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
					const candidates = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
					const thoughts = typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0;
					this.input = Math.max(this.input, prompt);
					this.output = Math.max(this.output, candidates + thoughts);
				}
				if (!usage || typeof usage !== "object") continue;
				// Anthropic: input_tokens / output_tokens. OpenAI chat-completions:
				// prompt_tokens / completion_tokens (final usage chunk, absolute).
				// Google native (google-generative-ai): usageMetadata with
				// promptTokenCount / candidatesTokenCount (+ thoughtsTokenCount) —
				// CUMULATIVE per stream, so max() below lands on the final totals.
				const inTok =
					typeof usage.input_tokens === "number"
						? usage.input_tokens
						: typeof usage.prompt_tokens === "number"
							? usage.prompt_tokens
							: undefined;
				const outTok =
					typeof usage.output_tokens === "number"
						? usage.output_tokens
						: typeof usage.completion_tokens === "number"
							? usage.completion_tokens
							: undefined;
				if (typeof inTok === "number" && evt.type !== "message_delta") this.input = Math.max(this.input, inTok);
				if (typeof outTok === "number") this.output = Math.max(this.output, outTok);
			} catch {
				// non-JSON line — ignore
			}
		}
	}
}

/**
 * Issue a per-worker token. Re-registering the same workerKey REPLACES the
 * old token (old one dies immediately) — retries of one task must never
 * accumulate live tokens.
 */
export function registerInferenceWorker(workerKey: string): string {
	if (!broker) throw new Error("inference broker not started");
	const existing = broker.byKey.get(workerKey);
	if (existing) {
		existing.revoked = true;
		broker.workers.delete(existing.tokenDigest);
		broker.byKey.delete(workerKey);
	}
	const token = crypto.randomBytes(32).toString("hex");
	const maxTokens = getCrewEnvInt(INFERENCE_BUDGET_ENV) ?? 0;
	const entry: WorkerEntry = {
		workerKey,
		tokenDigest: tokenKey(token),
		revoked: false,
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		inFlight: 0,
		maxTokens,
	};
	broker.workers.set(entry.tokenDigest, entry);
	broker.byKey.set(workerKey, entry);
	return token;
}

/** Deterministic worker key for a task-owned worker — SHARED by the spawn side (prepareSpawnContext) and the exit-revoke wrapper (runChildPi finally). */
export function inferenceWorkerKeyForAgent(agentId: string): string {
	return `inference:${agentId}`;
}

/**
 * Non-throwing exit hook (v0.11.36): revoke a task worker's inference token
 * when its runChildPi call settles — normal exit, crash, or abort. Anonymous
 * (agentId-less) spawns use per-spawn unique keys that only the spawn path
 * knows; their tokens die at register-replacement or broker stop. Broker off
 * → no-op. NEVER throws (must not mask a worker result).
 */
export function revokeInferenceWorkerForAgent(agentId: string | undefined): boolean {
	if (!agentId) return false;
	try {
		if (!getInferenceBrokerSnapshot().active) return false;
		return revokeInferenceWorker(inferenceWorkerKeyForAgent(agentId));
	} catch {
		return false;
	}
}

/** Kill-switch for one worker: its token dies on the NEXT request. */
export function revokeInferenceWorker(workerKey: string): boolean {
	if (!broker) return false;
	const entry = broker.byKey.get(workerKey);
	if (!entry) return false;
	entry.revoked = true;
	broker.workers.delete(entry.tokenDigest);
	broker.byKey.delete(workerKey);
	return true;
}

export function revokeAllInferenceWorkers(): number {
	if (!broker) return 0;
	const n = broker.byKey.size;
	for (const entry of broker.byKey.values()) entry.revoked = true;
	broker.workers.clear();
	broker.byKey.clear();
	return n;
}

/** Redacted per-worker stats (never includes tokens). */
export function inferenceBrokerStats(): Array<{ workerKey: string; requests: number; inputTokens: number; outputTokens: number }> {
	if (!broker) return [];
	return [...broker.byKey.values()].map((e) => ({
		workerKey: e.workerKey,
		requests: e.requests,
		inputTokens: e.inputTokens,
		outputTokens: e.outputTokens,
	}));
}

/** Stop the broker: revoke every token, close the server, remove the scoped dir. */
export function stopInferenceBroker(): void {
	if (!broker) return;
	revokeAllInferenceWorkers();
	broker.server.close();
	try {
		fs.rmSync(broker.scopedAgentDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup (tracked temp cleaner will catch it)
	}
	broker = undefined;
}

/** @internal Reset module state — TESTS ONLY (never call in production paths). */
export function __resetInferenceBrokerForTests(): void {
	stopInferenceBroker();
}

/** @internal TESTS ONLY — the live token-map keys. By construction these are
 * SHA-256 digests (see tokenKey); the suite pins that no RAW token ever
 * appears as a map key (constant-time discipline). */
export function __inferenceBrokerTokenMapKeysForTests(): string[] {
	return broker ? [...broker.workers.keys()] : [];
}

/** @internal TESTS ONLY — the live per-worker in-flight counter (looked up
 * by worker key, never the raw token). Pins the MAX_INFLIGHT_PER_WORKER
 * admission cap: incremented at admission, exactly one release per settled
 * request (success, upstream failure, client abort, post-admission deny). */
export function __inferenceBrokerInFlightForTests(workerKey: string): number | undefined {
	return broker?.byKey.get(workerKey)?.inFlight;
}
