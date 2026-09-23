/**
 * US-030 (docs/specs/US-030.md) — webhook notifications on run completion.
 *
 * All fetch I/O is stubbed (deps.fetch injection + one globalThis.fetch stub
 * for the disabled path) — tests perform ZERO network calls. Quiet-hours
 * expectations are cross-checked against the router's own isInQuietHours to
 * prove the suppression reuses (not duplicates) that logic.
 *
 * Mutation target: the quiet-hours check inside createWebhookNotifier's
 * notifyTerminalRun — removing it must turn the two quiet-hours tests RED.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type AsyncNotifierState, startAsyncRunNotifier, stopAsyncRunNotifier } from "../../../src/extension/async-notifier.ts";
import { isInQuietHours } from "../../../src/extension/notification-router.ts";
import {
	buildWebhookPayload,
	createWebhookNotifier,
	isWebhookUrlAllowed,
	type WebhookDeliveryFailure,
	type WebhookNotifier,
	type WebhookTerminalRun,
} from "../../../src/extension/webhook-notify.ts";
import { createRunManifest, saveRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

const NOW = new Date("2026-09-23T10:20:30.000Z");

const RUN: WebhookTerminalRun = {
	runId: "team_20260923_webhook",
	status: "completed",
	team: "implementation",
	goal: "Ship the webhook feature\nlonger context on line two (must NOT leak)",
	createdAt: "2026-09-23T10:00:00.000Z",
	cwd: "/tmp/pi-crew-webhook-test",
};

function makeTask(id: string, usage?: TeamTaskState["usage"]): TeamTaskState {
	return {
		id,
		runId: RUN.runId,
		role: "executor",
		agent: "executor",
		title: `task ${id}`,
		status: "completed",
		dependsOn: [],
		cwd: RUN.cwd,
		usage,
	};
}

const TASKS: TeamTaskState[] = [
	makeTask("t1", { input: 5000, output: 2000, cost: 0.01 }),
	makeTask("t2", { input: 10_000, output: 5000, cost: 0.0023 }),
	makeTask("t3", undefined),
];

const EXPECTED_PAYLOAD = {
	event: "run.terminal",
	runId: "team_20260923_webhook",
	status: "completed",
	team: "implementation",
	goal: "Ship the webhook feature",
	durationMs: 1_230_000,
	cost: 0.0123,
	tokens: 22_000,
	at: "2026-09-23T10:20:30.000Z",
};

interface FetchStep {
	ok?: boolean;
	status?: number;
	reject?: Error;
}

interface RecordedCall {
	url: string;
	init: RequestInit;
}

function makeFetchStub(steps: FetchStep[]): { calls: RecordedCall[]; fetch: (url: string, init: RequestInit) => Promise<Response> } {
	const calls: RecordedCall[] = [];
	let index = 0;
	return {
		calls,
		fetch: (url: string, init: RequestInit): Promise<Response> => {
			calls.push({ url, init });
			const step = steps[index++];
			if (!step) return Promise.reject(new Error(`unexpected fetch call #${index} (no scripted step)`));
			if (step.reject) return Promise.reject(step.reject);
			return Promise.resolve({ ok: step.ok ?? true, status: step.status ?? 200 } as unknown as Response);
		},
	};
}

function activeDeps(overrides?: Partial<Parameters<typeof createWebhookNotifier>[1]>): Parameters<typeof createWebhookNotifier>[1] {
	return { now: () => NOW, loadTasks: () => TASKS, ...overrides };
}

// ── payload shape ───────────────────────────────────────────────────────────

test("payload shape exactly as documented (US-030 §Design): one POST, exact keys, PII-safe goal first line", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: true, status: 200 }]);
	const notifier = createWebhookNotifier({ webhook: { url: "https://hooks.example.test/x" } }, activeDeps({ fetch }));
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1, "exactly ONE POST");
	assert.equal(calls[0]!.url, "https://hooks.example.test/x");
	assert.equal(calls[0]!.init.method, "POST");
	const headers = calls[0]!.init.headers as Record<string, string>;
	assert.equal(headers["content-type"], "application/json");
	assert.equal("x-pi-crew-signature" in headers, false, "no signature header when secret unset");
	const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body), ["event", "runId", "status", "team", "goal", "durationMs", "cost", "tokens", "at"]);
	assert.deepEqual(body, EXPECTED_PAYLOAD);
	// PII-safety: line two of the goal must NOT leak; no transcript/event fields.
	assert.ok(!JSON.stringify(body).includes("must NOT leak"));
});

test("buildWebhookPayload (pure): missing goal → '', unparseable/missing createdAt → durationMs 0, usage-less tasks skipped", () => {
	const payload = buildWebhookPayload({ ...RUN, goal: undefined, createdAt: undefined }, TASKS.slice(0, 2), NOW);
	assert.equal(payload.goal, "");
	assert.equal(payload.durationMs, 0);
	assert.equal(payload.cost, 0.0123);
	assert.equal(payload.tokens, 22_000);
});

// ── disabled by default — zero network ──────────────────────────────────────

test("no URL / enabled:false / notifications unset → ZERO network calls (global fetch stubbed)", async () => {
	const originalFetch = globalThis.fetch;
	let globalCalls = 0;
	globalThis.fetch = (() => {
		globalCalls++;
		return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
	}) as typeof fetch;
	try {
		const { calls, fetch } = makeFetchStub([]);
		const unset = createWebhookNotifier({}, activeDeps({ fetch }));
		unset.notifyTerminalRun(RUN);
		await unset.settled();
		const disabled = createWebhookNotifier({ webhook: { url: "https://hooks.example.test/x", enabled: false } }, activeDeps({ fetch }));
		disabled.notifyTerminalRun(RUN);
		await disabled.settled();
		assert.equal(calls.length, 0);
		assert.equal(globalCalls, 0, "global fetch never invoked when disabled");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ── quiet hours (reuses the router's isInQuietHours — never a duplicate) ────

test("inside quiet hours (cross-day window) → suppressed, ZERO fetch calls", async () => {
	const local3am = new Date(2026, 8, 23, 3, 0, 0, 0);
	// Cross-check against the router helper itself — same gate, not a reimplementation.
	assert.equal(isInQuietHours("22:00-07:00", local3am), true);
	const { calls, fetch } = makeFetchStub([]);
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" }, quietHours: "22:00-07:00" },
		activeDeps({ fetch, now: () => local3am }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 0);
});

test("outside quiet hours → delivered exactly once", async () => {
	const localNoon = new Date(2026, 8, 23, 12, 0, 0, 0);
	assert.equal(isInQuietHours("22:00-07:00", localNoon), false);
	const { calls, fetch } = makeFetchStub([{ ok: true, status: 200 }]);
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" }, quietHours: "22:00-07:00" },
		activeDeps({ fetch, now: () => localNoon }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1);
});

// ── retry policy + never throw into the caller ──────────────────────────────

test("5xx then 200 → exactly ONE retry, success, no failure surfaced", async () => {
	const { calls, fetch } = makeFetchStub([
		{ ok: false, status: 503 },
		{ ok: true, status: 200 },
	]);
	const failures: WebhookDeliveryFailure[] = [];
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" } },
		activeDeps({ fetch, onFailure: (f) => failures.push(f) }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 2);
	assert.deepEqual(failures, []);
});

test("network error twice → ONE retry then give up; failure logged + surfaced once; NEVER throws into caller", async () => {
	const { calls, fetch } = makeFetchStub([{ reject: new Error("ECONNREFUSED") }, { reject: new Error("ETIMEDOUT") }]);
	const failures: WebhookDeliveryFailure[] = [];
	const originalError = console.error;
	const lines: string[] = [];
	console.error = ((...args: unknown[]) => {
		lines.push(args.join(" "));
	}) as typeof console.error;
	let notifier: WebhookNotifier;
	try {
		notifier = createWebhookNotifier(
			{ webhook: { url: "https://hooks.example.test/x" } },
			activeDeps({ fetch, onFailure: (f) => failures.push(f) }),
		);
		assert.doesNotThrow(() => notifier.notifyTerminalRun(RUN), "delivery failure must not throw into the run lifecycle path");
		await notifier.settled();
	} finally {
		console.error = originalError;
	}
	assert.equal(calls.length, 2, "exactly one retry");
	assert.equal(failures.length, 1, "exactly one failure surface");
	assert.equal(failures[0]!.attempts, 2);
	assert.equal(failures[0]!.error, "ETIMEDOUT");
	// Security fix: the failure record carries the ORIGIN only — the raw URL's
	// path/query/userinfo must never reach logs or the pi event stream.
	assert.equal(failures[0]!.url, "https://hooks.example.test");
	assert.ok(
		lines.some((line) => line.includes("webhook-notify.delivery")),
		"logInternalError fired for the failure",
	);
});

test("4xx → permanent failure, NO retry", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: false, status: 404 }]);
	const failures: WebhookDeliveryFailure[] = [];
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" } },
		activeDeps({ fetch, onFailure: (f) => failures.push(f) }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1);
	assert.equal(failures.length, 1);
	assert.equal(failures[0]!.attempts, 1);
});

// ── HMAC signature ──────────────────────────────────────────────────────────

test("secret set → x-pi-crew-signature: sha256=<hmac-sha256(raw body, secret)> (independently recomputed)", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: true, status: 200 }]);
	const secret = "unit-test-secret";
	const notifier = createWebhookNotifier({ webhook: { url: "https://hooks.example.test/x", secret } }, activeDeps({ fetch }));
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1);
	const rawBody = calls[0]!.init.body as string;
	const headers = calls[0]!.init.headers as Record<string, string>;
	const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
	assert.equal(headers["x-pi-crew-signature"], `sha256=${expected}`);
});

// ── SSRF guard ──────────────────────────────────────────────────────────────

test("SSRF guard: refuses non-http(s), loopback, unspecified, and link-local targets; allows private RFC1918", () => {
	assert.equal(isWebhookUrlAllowed("https://hooks.example.test/x"), true);
	assert.equal(isWebhookUrlAllowed("http://10.1.2.3:8080/hook"), true, "RFC1918 internal webhook is a use case, not SSRF");
	assert.equal(isWebhookUrlAllowed("http://192.168.1.5:8080/hook"), true);
	assert.equal(isWebhookUrlAllowed("file:///etc/passwd"), false);
	assert.equal(isWebhookUrlAllowed("ftp://example.test/x"), false);
	assert.equal(isWebhookUrlAllowed("not a url"), false);
	assert.equal(isWebhookUrlAllowed("http://169.254.169.254/latest/meta-data"), false, "cloud metadata endpoint");
	assert.equal(isWebhookUrlAllowed("http://169.254.0.1/hook"), false, "link-local 169.254.0.0/16");
	assert.equal(isWebhookUrlAllowed("http://localhost:9090/hook"), false);
	assert.equal(isWebhookUrlAllowed("http://LOCALHOST:9090/hook"), false, "case-insensitive host");
	assert.equal(isWebhookUrlAllowed("http://127.0.0.1:9090/hook"), false);
	assert.equal(isWebhookUrlAllowed("http://127.8.8.8/hook"), false, "whole 127/8 loopback");
	assert.equal(isWebhookUrlAllowed("http://[::1]:9090/hook"), false);
	assert.equal(isWebhookUrlAllowed("http://[fe80::1]:9090/hook"), false, "IPv6 link-local");
	assert.equal(isWebhookUrlAllowed("http://0.0.0.0/hook"), false, "unspecified");
});

test("factory refuses disallowed URLs at creation → ZERO fetch calls even with enabled:true", async () => {
	for (const url of ["file:///etc/passwd", "http://169.254.169.254/x", "http://localhost:9/hook", "http://[::1]:9/hook"]) {
		const { calls, fetch } = makeFetchStub([]);
		const notifier = createWebhookNotifier({ webhook: { url, enabled: true } }, activeDeps({ fetch }));
		notifier.notifyTerminalRun(RUN);
		await notifier.settled();
		assert.equal(calls.length, 0, `URL ${url} must never receive a request`);
	}
});

test("allowLocalhost:true → explicit opt-in permits loopback delivery", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: true, status: 200 }]);
	const notifier = createWebhookNotifier({ webhook: { url: "http://localhost:9090/hook", allowLocalhost: true } }, activeDeps({ fetch }));
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1);
});

// ── integration seam: the async-run notifier's terminal transition ─────────

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("async notifier wiring: terminal transition fires the webhook once (blocked does not); toast unaffected", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-webhook-wiring-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const notified: WebhookTerminalRun[] = [];
	const toasts: string[] = [];
	const state: AsyncNotifierState = { seenFinishedRunIds: new Set() };
	const webhookNotifier: WebhookNotifier = {
		notifyTerminalRun: (run) => {
			notified.push(run);
		},
		settled: () => Promise.resolve(),
		dispose: () => undefined,
	};
	try {
		const completed = createRunManifest({ cwd, team, workflow, goal: "wiring test completed" });
		const blocked = createRunManifest({ cwd, team, workflow, goal: "wiring test blocked" });
		saveRunManifest({ ...completed.manifest, status: "running" });
		saveRunManifest({ ...blocked.manifest, status: "running" });
		startAsyncRunNotifier(
			{
				cwd,
				ui: {
					notify: (text: string) => {
						toasts.push(text);
					},
				},
			} as never,
			state,
			10,
			{ webhookNotifier },
		);
		saveRunManifest({ ...completed.manifest, status: "completed", updatedAt: new Date().toISOString() });
		saveRunManifest({ ...blocked.manifest, status: "blocked", updatedAt: new Date().toISOString() });
		await wait(120);
		assert.equal(notified.length, 1, "exactly one webhook — only the spec terminal status");
		assert.equal(notified[0]!.runId, completed.manifest.runId);
		assert.equal(notified[0]!.status, "completed");
		assert.equal(notified[0]!.team, "default");
		assert.equal(toasts.length, 2, "local toasts unaffected by the webhook path");
	} finally {
		stopAsyncRunNotifier(state);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── security-review hardening (2026-09-23) ───────────────────────────────────

test("SECURITY HIGH: fetch runs with redirect:'manual'; a 3xx is REFUSED (no follow, no retry)", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: false, status: 302 }]);
	const failures: WebhookDeliveryFailure[] = [];
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" } },
		activeDeps({ fetch, onFailure: (f) => failures.push(f) }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	// The stub cannot simulate undici's redirect chasing — that is exactly the
	// point: the CONTRACT pins manual mode, so a 302 from the allowed host can
	// never be followed to a blocked target (169.254.x, loopback, RFC1918).
	assert.equal(calls.length, 1, "no retry for 3xx — permanent failure");
	assert.equal(calls[0]!.init.redirect, "manual", "redirect mode must be manual");
	assert.equal(failures.length, 1);
	assert.match(failures[0]!.error, /refused redirect HTTP 302/);
});

test("SECURITY MEDIUM: trailing-dot localhost and userinfo URLs are refused", () => {
	assert.equal(isWebhookUrlAllowed("http://localhost.:9000/hook"), false, "trailing-dot FQDN resolves to loopback");
	assert.equal(isWebhookUrlAllowed("https://user:token@hooks.example.test/x"), false, "userinfo must never reach logs/headers");
	assert.equal(isWebhookUrlAllowed("https://hooks.example.test/x"), true, "sanity: plain https still allowed");
});

test("SECURITY LOW: goal first line is capped at 256 chars (agent-composable stuffing channel)", () => {
	const long = "A".repeat(5000);
	const payload = buildWebhookPayload({ ...RUN, goal: long }, TASKS, NOW);
	assert.equal(payload.goal.length, 256);
});

test("SECURITY LOW: a pattern-valid but clock-invalid quietHours delivers anyway (no silent suppression)", async () => {
	const { calls, fetch } = makeFetchStub([{ ok: true, status: 200 }]);
	const notifier = createWebhookNotifier(
		{ webhook: { url: "https://hooks.example.test/x" }, quietHours: "99:99-00:00" },
		activeDeps({ fetch }),
	);
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(calls.length, 1, "parseHHMMRange throws are contained — delivery proceeds");
});

test("SECURITY LOW: response body is cancelled (no socket pinning against slow-trickle endpoints)", async () => {
	let cancelled = 0;
	const body = {
		cancel: () => {
			cancelled += 1;
			return Promise.resolve();
		},
	};
	const fetch = (url: string, init: RequestInit): Promise<Response> =>
		Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
	const notifier = createWebhookNotifier({ webhook: { url: "https://hooks.example.test/x" } }, activeDeps({ fetch: fetch as never }));
	notifier.notifyTerminalRun(RUN);
	await notifier.settled();
	assert.equal(cancelled, 1, "body.cancel() must be invoked on the success path");
});

test("SECURITY LOW: team-settings get never echoes webhook secret (sensitive-path redaction)", async () => {
	const envBackup = new Map<string, string | undefined>();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-webhook-home-"));
	process.env.PI_CREW_HOME = home;
	delete process.env.PI_TEAMS_HOME;
	try {
		const { updateConfig } = (await import("../../../src/config/config.ts")) as typeof import("../../../src/config/config.ts");
		updateConfig(
			{ notifications: { webhook: { url: "https://hooks.example.test/x", secret: "supersecret", enabled: true } } },
			{ scope: "user" },
		);
		const { handleSettings } = (await import(
			"../../../src/extension/team-tool/handle-settings.ts"
		)) as typeof import("../../../src/extension/team-tool/handle-settings.ts");
		const get = handleSettings({ config: { args: "get notifications.webhook.secret" } }, { cwd: home });
		const text = (get.content?.[0] as { text?: string }).text ?? "";
		assert.ok(text.includes("***(redacted"), `secret must be redacted, got: ${text}`);
		assert.ok(!text.includes("supersecret"), "the secret value must never appear in tool output");
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!envBackup.has(key)) delete process.env[key];
		}
		for (const [key, value] of envBackup) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(home, { recursive: true, force: true });
	}
});
