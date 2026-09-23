/**
 * US-030 (docs/specs/US-030.md) — outbound webhook notifications on run
 * terminal transitions (completed/failed/cancelled).
 *
 * Pattern: bounded sibling of notification-router.ts / schedule-toast-bridge.ts
 * — an opt-in, fire-and-forget sink. The terminal TRANSITION itself is
 * observed by the async-run notifier (src/extension/async-notifier.ts, the
 * existing poller that also toasts run completion for background runs);
 * this module only formats + delivers. No new polling loop was introduced.
 *
 * Safety model (spec "SECURITY-SENSITIVE"):
 *  - Disabled by default: no `notifications.webhook.url` (or `enabled:false`)
 *    → the factory returns a shared no-op singleton — ZERO network calls and
 *    zero allocation on the hot path (notifyTerminalRun is an empty fn).
 *  - SSRF guard: URL must be http(s) and must not target localhost /
 *    127.0.0.0/8 / 0.0.0.0 / [::1] / :: / fe80::/10 / 169.254.0.0/16 unless
 *    `allowLocalhost: true` is set explicitly (checked once at creation —
 *    fail closed). Hostname-LITERAL checks only (no DNS resolution): a DNS
 *    name that resolves to loopback is not detected — documented limitation.
 *  - PII-safe payload: event/runId/status/team/goal FIRST LINE/durationMs/
 *    cost/tokens/at only. NO transcripts, events, task bodies, or summaries.
 *  - The config block is `sensitive: true` in the schema, so project-level
 *    config drops it (user config only) — an untrusted repo cannot point
 *    pi-crew at an attacker URL.
 *  - Delivery never throws into the caller (async-notifier poller / run
 *    lifecycle path): every entry point is wrapped; failures land in
 *    logInternalError (always-on "warn") + a `crew.webhook.failed` pi event
 *    surfaced via deps.onFailure (wired in registration/lifecycle.ts).
 *
 * Delivery: ONE POST (content-type application/json) with a 5 s per-attempt
 * timeout and EXACTLY ONE retry on 5xx/network error, then give up. Uses the
 * Node 22 global fetch — no new dependency.
 */
import { createHmac } from "node:crypto";
import type { CrewWebhookConfig } from "../config/types.ts";
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { isInQuietHours } from "./notification-router.ts";

/** Documented payload (spec §Design). Field order matches the spec example. */
export interface WebhookPayload {
	event: "run.terminal";
	runId: string;
	status: string;
	team: string;
	goal: string;
	durationMs: number;
	cost: number;
	tokens: number;
	at: string;
}

/** Manifest projection the notifier needs — TeamRunManifest satisfies this structurally. */
export interface WebhookTerminalRun {
	runId: string;
	status: string;
	team: string;
	goal?: string;
	createdAt?: string;
	/** Working dir of the project that owns the run (task loader input). */
	cwd: string;
}

export interface WebhookDeliveryFailure {
	runId: string;
	/** Target URL — carries no secret material (the secret only ever lives in the signature header). */
	url: string;
	attempts: number;
	error: string;
}

export interface WebhookNotifier {
	/** Fire-and-forget terminal notification. NEVER throws. */
	notifyTerminalRun(run: WebhookTerminalRun): void;
	/** Determinism seam: resolves once no delivery is in flight. */
	settled(): Promise<void>;
	/** Stop accepting new deliveries (in-flight ones still settle). */
	dispose(): void;
}

export interface WebhookNotifierDeps {
	/** Fetch implementation (injectable for tests); default = Node 22 global fetch. */
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** Clock for the quiet-hours gate and the payload `at` field; default `() => new Date()`. */
	now?: () => Date;
	/** Task loader for cost/token sums; default reads the run's tasks from disk (best-effort). */
	loadTasks?: (run: WebhookTerminalRun) => TeamTaskState[] | undefined;
	/** Extra failure surface (the wiring emits `crew.webhook.failed` here). logInternalError always fires. */
	onFailure?: (failure: WebhookDeliveryFailure) => void;
	/** Per-attempt timeout. Default 5000 ms (spec "e.g. 5 s"). */
	timeoutMs?: number;
}

export interface WebhookNotifyOptions {
	/** `notifications.webhook` config block (url/enabled/secret/allowLocalhost). */
	webhook?: CrewWebhookConfig;
	/** `notifications.quietHours` — the SAME gate as the TUI router (reuses isInQuietHours — do not duplicate the logic). */
	quietHours?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** One attempt + exactly one retry (spec: "ONE retry on 5xx/network error"). */
const MAX_ATTEMPTS = 2;

// ── SSRF guard ─────────────────────────────────────────────────────────────

function ipv4Octets(host: string): number[] | undefined {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined;
	const parts = host.split(".").map(Number);
	if (!parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return undefined;
	return parts;
}

/**
 * True for localhost NAMES and loopback/unspecified/link-local address
 * literals. RFC1918 (10/8, 172.16/12, 192.168/16) is deliberately NOT
 * blocked — internal webhooks are a primary use case (spec blocks only
 * localhost / 127.0.0.1 / [::1] / 169.254.0.0/16).
 */
function isLocalAddress(hostname: string): boolean {
	const host = hostname.toLowerCase();
	// URL.hostname keeps brackets on IPv6 literals — strip for matching. A
	// trailing dot ("localhost.", FQDN form) also resolves to loopback via
	// getaddrinfo — strip it too (security review finding).
	let bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare.endsWith(".")) bare = bare.slice(0, -1);
	if (bare === "localhost" || bare.endsWith(".localhost")) return true;
	// IPv4 literal, incl. IPv4-mapped IPv6 (::ffff:a.b.c.d).
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
	const v4 = ipv4Octets(mapped ? mapped[1] : bare);
	if (v4) {
		const [a, b] = v4;
		// 127/8 loopback, 0/8 unspecified, 169.254/16 link-local.
		return a === 127 || a === 0 || (a === 169 && b === 254);
	}
	if (bare === "::1" || bare === "::") return true;
	// IPv6 link-local fe80::/10: first non-empty hextet in 0xfe80..0xfebf.
	const firstHextet = bare.split(":").find((segment) => segment.length > 0);
	if (firstHextet && /^[0-9a-f]{1,4}$/.test(firstHextet)) {
		const value = Number.parseInt(firstHextet, 16);
		return value >= 0xfe80 && value <= 0xfebf;
	}
	return false;
}

/** SSRF guard (pure, exported for tests): http(s) only + local-address refusal unless opted in. */
export function isWebhookUrlAllowed(rawUrl: string, allowLocalhost = false): boolean {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	// Credentials embedded in the URL would leak into logs — refuse them
	// (use the `secret` HMAC field, never userinfo).
	if (parsed.username || parsed.password) return false;
	if (allowLocalhost) return true;
	return !isLocalAddress(parsed.hostname);
}

/** Log-safe URL form: origin only — never path, query, or userinfo. */
function safeUrlForLog(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "(unparseable-url)";
	}
}

// ── payload ────────────────────────────────────────────────────────────────

function sumUsage(tasks: TeamTaskState[] | undefined): { cost: number; tokens: number } {
	let cost = 0;
	let tokens = 0;
	for (const task of tasks ?? []) {
		const usage = task.usage;
		if (!usage) continue;
		cost += usage.cost ?? 0;
		tokens += (usage.input ?? 0) + (usage.output ?? 0);
	}
	// Round the FP cost sum at micro-USD precision — keeps the JSON stable and test-friendly.
	return { cost: Math.round(cost * 1e6) / 1e6, tokens };
}

/** Pure payload builder (exported for tests). PII-safe by construction: only
 *  the documented fields; goal is reduced to its FIRST line. */
export function buildWebhookPayload(run: WebhookTerminalRun, tasks: TeamTaskState[] | undefined, now: Date): WebhookPayload {
	const createdAtMs = run.createdAt ? new Date(run.createdAt).getTime() : Number.NaN;
	const { cost, tokens } = sumUsage(tasks);
	return {
		event: "run.terminal",
		runId: run.runId,
		status: run.status,
		team: run.team,
		// First line, capped at 256 chars: goals of nested runs are
		// agent-composable — an uncapped line is a data-stuffing channel to
		// the configured endpoint (security review finding).
		goal: ((run.goal ?? "").split(/\r?\n/)[0] ?? "").slice(0, 256),
		durationMs: Number.isFinite(createdAtMs) ? Math.max(0, now.getTime() - createdAtMs) : 0,
		cost,
		tokens,
		at: now.toISOString(),
	};
}

// ── notifier ───────────────────────────────────────────────────────────────

const DISABLED_NOTIFIER: WebhookNotifier = Object.freeze({
	notifyTerminalRun: () => undefined,
	settled: () => Promise.resolve(),
	dispose: () => undefined,
});

function defaultLoadTasks(run: WebhookTerminalRun): TeamTaskState[] | undefined {
	try {
		return loadRunManifestById(run.cwd, run.runId)?.tasks;
	} catch {
		return undefined;
	}
}

/** Active-config check (pure, exported for tests): url present + not disabled. */
export function isWebhookActive(config: { webhook?: CrewWebhookConfig }): boolean {
	return Boolean(config.webhook?.url) && config.webhook?.enabled !== false;
}

export function createWebhookNotifier(options: WebhookNotifyOptions, deps: WebhookNotifierDeps = {}): WebhookNotifier {
	const webhook = options.webhook;
	const url = webhook?.url ?? "";
	if (!isWebhookActive(options)) return DISABLED_NOTIFIER;
	if (!isWebhookUrlAllowed(url, webhook?.allowLocalhost === true)) {
		// Fail closed at creation: the notifier stays a no-op — a disallowed
		// target must never receive a request, not even once.
		logInternalError(
			"webhook-notify.config",
			new Error(
				`refusing webhook URL '${safeUrlForLog(url)}' (SSRF guard); set notifications.webhook.allowLocalhost=true to target loopback/link-local explicitly`,
			),
			undefined,
			"warn",
		);
		return DISABLED_NOTIFIER;
	}
	const secret = webhook?.secret;
	const quietHours = options.quietHours;
	const now = deps.now ?? (() => new Date());
	const fetchImpl = deps.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
	const loadTasks = deps.loadTasks ?? defaultLoadTasks;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const onFailure = deps.onFailure;
	let disposed = false;
	const inflight = new Set<Promise<void>>();

	async function deliverOnce(body: string): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (secret) {
			// Signature over the EXACT serialized body the receiver sees, so the
			// receiver can verify with hmac_sha256(secret, raw_body).
			headers["x-pi-crew-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// SSRF (security review HIGH): redirect:"follow" (the default) lets
			// undici chase up to 20 hops WITHOUT re-running the guard — a
			// 302 at the allowed host reaches 169.254.169.254 / loopback /
			// internal RFC1918, and a 307 REPLAYS the signed body there. Manual
			// mode surfaces any 3xx as a response we treat as failure below.
			return await fetchImpl(url, {
				method: "POST",
				headers,
				body,
				signal: controller.signal,
				redirect: "manual",
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async function deliver(body: string, runId: string): Promise<void> {
		let lastError: unknown = new Error("webhook delivery failed");
		let attempts = 0;
		while (attempts < MAX_ATTEMPTS) {
			attempts++;
			try {
				const response = await deliverOnce(body);
				// Always release the body — undici pins the socket until the body
				// is drained/cancelled (default bodyTimeout ~300s), which a
				// slow-trickle endpoint would exploit across fire-and-forget calls.
				void response.body?.cancel?.().catch(() => {});
				if (response.ok) return;
				// 3xx under redirect:"manual" = a redirect we REFUSE to follow
				// (the guard validated the configured URL, not the hop target).
				// Permanent failure — no retry.
				if (response.status >= 300 && response.status < 400) {
					lastError = new Error(`refused redirect HTTP ${response.status} (SSRF guard — redirects are not followed)`);
					break;
				}
				lastError = new Error(`HTTP ${response.status}`);
				// Retry ONLY on 5xx (and only once). 4xx is permanent — fail fast.
				if (response.status >= 500 && attempts < MAX_ATTEMPTS) continue;
				break;
			} catch (error) {
				// Network error / abort-timeout → exactly one retry.
				lastError = error;
			}
		}
		const failure: WebhookDeliveryFailure = {
			runId,
			// Origin only: the raw URL (path/query/userinfo) must never reach
			// logs or the pi event stream (security review finding).
			url: safeUrlForLog(url),
			attempts,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		};
		logInternalError(
			"webhook-notify.delivery",
			lastError instanceof Error ? lastError : new Error(String(lastError)),
			`runId=${runId} url=${failure.url} attempts=${failure.attempts}`,
			"warn",
		);
		try {
			onFailure?.(failure);
		} catch (callbackError) {
			logInternalError("webhook-notify.onFailure", callbackError, runId);
		}
	}

	return {
		notifyTerminalRun(run) {
			// NEVER throws into the caller (async-notifier poller → run lifecycle).
			try {
				if (disposed) return;
				// Quiet-hours gate reuses the router's isInQuietHours — the SAME
				// suppression window as the TUI notification path. A pattern-valid
				// but clock-invalid value ("99:99-00:00" passes the schema regex)
				// throws in parseHHMMRange; suppression is a nicety, not a gate —
				// deliver anyway and log once (security review finding: the throw
				// previously silenced every delivery with only a console line).
				if (quietHours) {
					try {
						if (isInQuietHours(quietHours, now())) return;
					} catch (quietError) {
						logInternalError(
							"webhook-notify.quiet-hours",
							quietError instanceof Error ? quietError : new Error(String(quietError)),
							`invalid quietHours='${quietHours}' — delivering anyway`,
							"warn",
						);
					}
				}
				const tasks = loadTasks(run);
				const payload = buildWebhookPayload(run, tasks, now());
				const body = JSON.stringify(payload);
				const tracked = deliver(body, run.runId).then(
					() => undefined,
					(error) => {
						// deliver() is designed to never reject; belt-only.
						logInternalError("webhook-notify.unexpected", error, run.runId, "warn");
					},
				);
				inflight.add(tracked);
				void tracked.then(() => {
					inflight.delete(tracked);
				});
			} catch (error) {
				logInternalError("webhook-notify.terminal", error, run.runId);
			}
		},
		async settled() {
			// Loop: new deliveries may start while awaiting (only relevant in tests).
			while (inflight.size > 0) await Promise.all([...inflight]);
		},
		dispose() {
			disposed = true;
		},
	};
}
