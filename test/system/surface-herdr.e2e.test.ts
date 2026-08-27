/**
 * surface-herdr.e2e.test.ts — E2E system test MuxSurface A1 trên herdr THẬT
 * (anh em sinh đôi của surface-tmux.e2e.test.ts).
 *
 * Cùng chuỗi thật như bản tmux — runChildPi → trySurfaceBranch →
 * prepareSurfaceSpawn → createHerdrProvider (thật, socket NDJSON thật) →
 * pane.split (pane thật) → buildLaunchScript → pane.send_text → fake `pi`
 * bash script chạy TRONG pane → pane tự đóng → onExit → classifyOnExit.
 *
 * Khác biệt so với bản tmux:
 *   - Sentinel dùng PI_CREW_SURFACE_PANE (provider-agnostic) thay TMUX_PANE —
 *     herdr pane không set TMUX_PANE.
 *   - "Pane còn sống?" dò qua pane.read (source "visible") thay list-panes.
 *   - Kill-pane giữa chừng (case 2) gọi thẳng pane.close qua socket — mô phỏng
 *     pane chết từ ngoài luồng provider, đúng vai tmux kill-pane.
 *
 * Skip guard: CI, đang trong tmux (innermost-wins §3 — resolve sẽ chọn tmux),
 * hoặc socket herdr không tồn tại → skip toàn file. Chạy local khi herdr
 * đang chạy: `node --experimental-strip-types --test --test-concurrency=1
 * --test-timeout=120000 test/system/surface-herdr.e2e.test.ts`.
 *
 * LƯU Ý: test tạo pane thật trong herdr server đang chạy (split từ pane đang
 * focus) rồi tự dọn — pane sẽ hiện trong ~4s rồi tự đóng.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cleanupOrphanSurfacePanes, formatOrphanPaneReport } from "../../src/extension/team-tool/doctor.ts";
import type { ChildPiLifecycleEvent } from "../../src/runtime/child-pi/child-pi.ts";
import { runChildPi } from "../../src/runtime/child-pi/child-pi.ts";
import type { ZombieScanResult } from "../../src/runtime/process/zombie-scanner.ts";
import {
	clearSurfaceRuntimeController,
	createSurfaceRuntimeController,
	registerSurfaceRuntimeController,
	type SurfaceDegradedEntry,
} from "../../src/runtime/surface/degrade.ts";
import { createHerdrProvider, herdrSocketPath } from "../../src/runtime/surface/herdr-provider.ts";
import { runEventBus } from "../../src/ui/run-event-bus.ts";

const HERDR_SOCK = herdrSocketPath(process.env);

/** Chỉ chạy local, NGOÀI tmux, khi herdr server đang sống (spec §3 D2). */
const E2E_OPTS: { skip?: string } =
	process.env.CI || process.env.TMUX || !existsSync(HERDR_SOCK)
		? { skip: "requires a running herdr server outside tmux ($TMUX set, CI=1, or no herdr socket)" }
		: {};

test.before(() => {
	// Gate §3 và mock path của child-pi phải tắt tuyệt đối — E2E này cần nhánh
	// surface thật, không được chặn từ env thừa của suite.
	delete process.env.PI_CREW_ASYNC_RUN;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
});

// ── Raw socket helpers (1 request = 1 connection — wire thật herdr) ────────

/**
 * Gọi method qua socket herdr ngoài luồng provider — dùng cho kill-pane
 * (pane.close) và dò pane sống. 1 request = 1 connection, mỗi dòng response
 * là JSON; đây đúng wire format mà herdr-provider.ts đã verify trên 0.8.2:
 * id PHẢI là string (integer bị từ chối invalid_request), error trả về trong
 * envelope `{"id":"","error":{...}}` — reject thay vì resolve.
 */
function herdrCall<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const socket = net.createConnection({ path: HERDR_SOCK });
		let buffer = "";
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(err);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error(`herdrCall ${method} timeout`)));
		socket.on("error", (err) => fail(err as Error));
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const idx = buffer.indexOf("\n");
			if (idx === -1) return;
			const line = buffer.slice(0, idx).trim();
			settled = true;
			socket.end();
			try {
				const parsed = JSON.parse(line || "{}") as { error?: { message?: string } };
				if (parsed.error) {
					reject(new Error(`herdrCall ${method} error: ${parsed.error.message ?? "unknown"}`));
					return;
				}
				resolve(parsed as T);
			} catch (err) {
				reject(err as Error);
			}
		});
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ id: "e2e-probe", method, params })}\n`);
		});
	});
}

/** Pane còn sống ⇔ pane.read không ném (pane chết → herdr trả lỗi). */
async function herdrPaneAlive(paneId: string): Promise<boolean> {
	try {
		await herdrCall("pane.read", { pane_id: paneId, source: "visible", lines: 5 });
		return true;
	} catch {
		return false;
	}
}

// ── Fake `pi` workers ──────────────────────────────────────────────────────

/**
 * Worker hoàn thành (surface): ghi sentinel mang PI_CREW_SURFACE_PANE + pid
 * (chứng minh chạy trong ĐÚNG pane), tự report qua per-agent log theo shape
 * T8 recorder ({seq,time,event}), ghi `worker.completed` vào RUN log (D7
 * report-before-dying) rồi exit 0. Headless: exit 0 ngay.
 */
const FAKE_PI_OK_BODY = [
	"set -u",
	`if [ -z "\${PI_CREW_SURFACE:-}" ]; then`,
	"  # Headless re-dispatch (spec §7 bước 5): hoàn thành sạch để run vẫn done.",
	"  exit 0",
	"fi",
	'AGENT_DIR="$(dirname -- "$PI_CREW_AGENT_EVENTS_PATH")"',
	'mkdir -p -- "$AGENT_DIR"',
	`printf 'PANE=%s\nPID=%s\n' "\${PI_CREW_SURFACE_PANE:-}" "$$" > e2e-sentinel.txt`,
	'SESSION_PATH="$PI_CREW_STATE_ROOT/agents/$PI_CREW_TASK_ID/session.jsonl"',
	'TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
	"# T8 recorder parity: per-agent log là các dòng {seq,time,event}.",
	'printf \'{"seq":1,"time":"%s","event":{"type":"worker.started","pid":%s,"sessionPath":"%s"}}\\n\' "$TS" "$$" "$SESSION_PATH" >> "$PI_CREW_AGENT_EVENTS_PATH"',
	'printf \'{"seq":2,"time":"%s","event":{"type":"worker.completed","result":"E2E HERDR DONE"}}\\n\' "$TS" >> "$PI_CREW_AGENT_EVENTS_PATH"',
	"# D7 (spec §7): report-before-dying — RUN log phải có worker.completed TRƯỚC khi pane chết.",
	'printf \'{"type":"worker.completed","runId":"%s","taskId":"%s","data":{"result":"E2E HERDR DONE","stopReason":"stop"}}\\n\' "$PI_CREW_BROKER_RUN_ID" "$PI_CREW_TASK_ID" >> "$PI_CREW_EVENTS_PATH"',
	"sleep 2",
	"exit 0",
].join("\n");

/**
 * Worker treo (surface): sentinel + worker.started rồi sleep — KHÔNG bao giờ
 * ghi worker.completed. Pane chết giữa chừng (test pane.close) phải đi degrade.
 */
const FAKE_PI_HANG_BODY = [
	"set -u",
	`if [ -z "\${PI_CREW_SURFACE:-}" ]; then`,
	"  exit 0",
	"fi",
	'AGENT_DIR="$(dirname -- "$PI_CREW_AGENT_EVENTS_PATH")"',
	'mkdir -p -- "$AGENT_DIR"',
	`printf 'PANE=%s\nPID=%s\n' "\${PI_CREW_SURFACE_PANE:-}" "$$" > e2e-sentinel.txt`,
	'SESSION_PATH="$PI_CREW_STATE_ROOT/agents/$PI_CREW_TASK_ID/session.jsonl"',
	'TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
	'printf \'{"seq":1,"time":"%s","event":{"type":"worker.started","pid":%s,"sessionPath":"%s"}}\\n\' "$TS" "$$" "$SESSION_PATH" >> "$PI_CREW_AGENT_EVENTS_PATH"',
	"sleep 300",
].join("\n");

// ── Helpers ────────────────────────────────────────────────────────────────

interface E2eCtx {
	workRoot: string;
	fakeBinRoot: string;
	launchDir: string;
	/** Mọi pane test này tạo ra — finally close best-effort để không rò pane. */
	panes: string[];
}

async function setupE2e(): Promise<E2eCtx> {
	const workRoot = mkdtempSync(join(tmpdir(), "surface-herdr-e2e-"));
	const fakeBinRoot = mkdtempSync(join(tmpdir(), "surface-herdr-e2e-bin-"));
	const launchDir = mkdtempSync(join(tmpdir(), "surface-herdr-e2e-launch-"));
	return { workRoot, fakeBinRoot, launchDir, panes: [] };
}

/** Cài `pi` giả qua đường production PI_TEAMS_PI_BIN (không monkey-patch). */
function installFakePi(ctx: E2eCtx, body: string): void {
	const binDir = join(ctx.fakeBinRoot, "bin");
	mkdirSync(binDir, { recursive: true });
	const piPath = join(binDir, "pi");
	writeFileSync(piPath, `#!/usr/bin/env bash\n${body}\n`, "utf8");
	chmodSync(piPath, 0o755);
	process.env.PI_TEAMS_PI_BIN = piPath;
	// pi-spawn.ts chỉ chấp nhận PI_TEAMS_PI_BIN nằm trong prefix an toàn (npm
	// global / node_modules/.bin / …). Cả hai dạng biến prefix phải được ghi:
	// code đọc `npm_config_prefix ?? NPM_CONFIG_PREFIX` và `npm run` set sẵn
	// dạng thường — chỉ ghi NPM_CONFIG_PREFIX thì allowlist bỏ qua nó.
	process.env.npm_config_prefix = ctx.fakeBinRoot;
	process.env.NPM_CONFIG_PREFIX = ctx.fakeBinRoot;
}

async function teardownE2e(ctx: E2eCtx, runId?: string): Promise<void> {
	for (const paneId of ctx.panes) {
		try {
			await herdrCall("pane.close", { pane_id: paneId });
		} catch {
			// pane đã tự đóng — đúng kịch bản
		}
	}
	if (runId) clearSurfaceRuntimeController(runId);
	delete process.env.PI_TEAMS_PI_BIN;
	delete process.env.NPM_CONFIG_PREFIX;
	delete process.env.npm_config_prefix;
	rmSync(ctx.workRoot, { recursive: true, force: true });
	rmSync(ctx.fakeBinRoot, { recursive: true, force: true });
	rmSync(ctx.launchDir, { recursive: true, force: true });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return await check();
}

/**
 * Giữ event loop sống cho trọn test. Subscription socket của herdr provider
 * giữ loop khi còn watcher, nhưng giữa các pha (trước pane đầu đăng ký
 * onExit) process test thuần không có handle ref nào → node:test coi event
 * loop đã xong. Keep-alive ref đóng đúng vai trò host-session đó.
 */
function keepEventLoopAlive(): () => void {
	const timer = setInterval(() => {
		// no-op: tồn tại để ref giữ event loop
	}, 1000);
	return () => clearInterval(timer);
}

/** Pane id từ lifecycle event surface_spawned (bắn sync ngay khi boot xong). */
function paneIdOfSpawn(lifecycle: ChildPiLifecycleEvent[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			const found = lifecycle.find((event) => event.type === "surface_spawned" && typeof event.paneId === "string");
			if (found) {
				clearInterval(timer);
				resolve(found.paneId as string);
			} else if (Date.now() - startedAt > 30_000) {
				clearInterval(timer);
				reject(new Error("no surface_spawned lifecycle event within 30s — surface branch never booted"));
			}
		}, 20);
	});
}

/** Fixture worker spawn chuẩn (parity surface-tmux E2E). */
function makeRunInput(cwd: string, runId: string, agentId: string, eventsPath: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd,
		task: "Do the E2E thing then stop.",
		agent: {
			name: "executor",
			description: "e2e executor",
			source: "builtin" as const,
			filePath: "/builtin/agents/executor.md",
			systemPrompt: "",
		},
		model: "glm-test-model",
		runId,
		agentId,
		eventsPath,
		transcriptPath: join(cwd, "transcripts", `${agentId}.jsonl`),
		...overrides,
	};
}

function makeRunLog(workRoot: string, runId: string): string {
	const runLog = join(workRoot, "state", "runs", runId, "events.jsonl");
	mkdirSync(dirname(runLog), { recursive: true });
	writeFileSync(runLog, "", "utf8");
	return runLog;
}

function readSentinel(workRoot: string): Record<string, string> {
	const lines = readFileSync(join(workRoot, "e2e-sentinel.txt"), "utf8").trim().split("\n");
	const entries: Array<[string, string]> = [];
	for (const line of lines) {
		const eq = line.indexOf("=");
		if (eq > 0) entries.push([line.slice(0, eq), line.slice(eq + 1)]);
	}
	return Object.fromEntries(entries);
}

// ── Case 1: spawn thật → hoàn thành ────────────────────────────────────────

test("E2E herdr: pane thật được spawn, script chạy trong pane, pane tự đóng, run hoàn thành", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const runId = "run_e2e_herdr_spawn";
	const taskId = "01_explore";
	const runLog = makeRunLog(ctx.workRoot, runId);
	const stopKeepAlive = keepEventLoopAlive();
	try {
		installFakePi(ctx, FAKE_PI_OK_BODY);
		const provider = createHerdrProvider();
		const lifecycle: ChildPiLifecycleEvent[] = [];
		const busEvents: Array<Record<string, unknown>> = [];
		const off = runEventBus.on(runId, (payload) => {
			if (payload.type === "worker_status") busEvents.push(payload.data as Record<string, unknown>);
		});

		const resultPromise = runChildPi(
			makeRunInput(ctx.workRoot, runId, taskId, runLog, {
				onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
					lifecycle.push(event);
					if (event.type === "surface_spawned" && event.paneId) ctx.panes.push(event.paneId);
				},
				surface: { providers: { herdr: provider }, baseDir: ctx.launchDir },
			}),
		);
		const paneId = await paneIdOfSpawn(lifecycle);

		// (1) pane thật tồn tại trên herdr server (pane.read không ném).
		assert.ok(await waitUntil(() => herdrPaneAlive(paneId), 5_000), `pane ${paneId} phải đọc được qua pane.read`);

		const result = await resultPromise;
		off();

		// (2) script pi giả đã chạy ĐÚNG trong pane đó — sentinel mang pane id.
		assert.ok(existsSync(join(ctx.workRoot, "e2e-sentinel.txt")), "sentinel phải được ghi bởi script chạy trong pane");
		const sentinel = readSentinel(ctx.workRoot);
		assert.equal(sentinel.PANE, paneId, "sentinel phải mang đúng pane id vừa spawn (PI_CREW_SURFACE_PANE)");
		assert.ok(/^\d+$/.test(sentinel.PID ?? ""), "sentinel phải mang pid của worker trong pane");

		// (3) pane tự đóng sau khi worker exit (`; exit` + T8 auto-exit).
		assert.ok(await waitUntil(async () => !(await herdrPaneAlive(paneId)), 10_000), `pane ${paneId} phải tự đóng sau exit`);

		// (4) run hoàn thành không lỗi: classify đọc được worker.completed của script.
		assert.equal(result.exitCode, 0);
		assert.ok(result.surface, "phải đi nhánh surface");
		assert.equal(result.surface?.kind, "herdr");
		assert.equal(result.surface?.paneId, paneId);
		assert.equal(result.surface?.degraded, undefined, "đã có worker.completed → không được degrade");
		assert.equal(result.rawFinalText, "E2E HERDR DONE", "result text phải đến từ worker.completed trong RUN log");
		assert.ok(
			lifecycle.some((event) => event.type === "surface_spawned"),
			"lifecycle phải báo surface_spawned",
		);
		assert.ok(
			lifecycle.some((event) => event.type === "surface_closed"),
			"lifecycle phải báo surface_closed",
		);
		// T9 E2E parity: per-agent log được host tail và bridge ra run event bus.
		assert.ok(
			busEvents.some((event) => event.eventType === "worker.started"),
			`phải thấy worker.started qua runEventBus, nhận: ${JSON.stringify(busEvents)}`,
		);
	} finally {
		stopKeepAlive();
		await teardownE2e(ctx, runId);
	}
});

// ── Case 2: degrade thật → re-dispatch headless ────────────────────────────

test("E2E herdr: pane.close giữa chừng → degrade + lockout + re-dispatch headless vẫn done", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const runId = "run_e2e_herdr_degrade";
	const taskId = "02_execute";
	const runLog = makeRunLog(ctx.workRoot, runId);
	const stopKeepAlive = keepEventLoopAlive();
	try {
		installFakePi(ctx, FAKE_PI_HANG_BODY);
		const degradedSeen: SurfaceDegradedEntry[] = [];
		const controller = createSurfaceRuntimeController({
			runId,
			eventsPath: runLog,
			onDegrade: (entry) => degradedSeen.push(entry),
		});
		registerSurfaceRuntimeController(controller);
		const provider = createHerdrProvider();
		const lifecycle: ChildPiLifecycleEvent[] = [];

		const result1Promise = runChildPi(
			makeRunInput(ctx.workRoot, runId, taskId, runLog, {
				onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
					lifecycle.push(event);
					if (event.type === "surface_spawned" && event.paneId) ctx.panes.push(event.paneId);
				},
				surface: { providers: { herdr: provider }, baseDir: ctx.launchDir },
			}),
		);
		const paneId = await paneIdOfSpawn(lifecycle);

		// Worker treo đã boot trong pane: sentinel + self-report worker.started.
		assert.ok(
			await waitUntil(() => existsSync(join(ctx.workRoot, "e2e-sentinel.txt")), 10_000),
			"worker treo phải ghi sentinel trong pane",
		);
		const agentLog = join(ctx.workRoot, "state", "runs", runId, "agents", taskId, "events.jsonl");
		assert.ok(
			await waitUntil(() => existsSync(agentLog) && readFileSync(agentLog, "utf8").includes("worker.started"), 10_000),
			"worker treo phải tự report worker.started vào per-agent log",
		);
		assert.ok(
			await waitUntil(() => controller.snapshot().workerPids[taskId] !== undefined, 10_000),
			"T11 controller phải nhận pid qua T9 tail → worker.started bridge",
		);

		// Giết pane giữa chừng qua socket (đúng vai kill-pane ngoài provider) —
		// worker chưa hoàn thành, RUN log không có worker.completed.
		await herdrCall("pane.close", { pane_id: paneId });

		const result1 = await result1Promise;
		assert.ok(result1.surface, "lần 1 phải đi nhánh surface");
		assert.equal(result1.surface?.degraded?.cause, "pane-closed", "classify 2s không thấy completed → degrade");
		assert.equal(result1.surface?.degraded?.exitReason, "pane-closed");
		assert.equal(result1.rawFinalText, "", "worker chưa hoàn thành thì không được giả kết quả");

		// T11: entry degrade cho scheduler drain + event bền vững + lockout chống flap.
		const drained = controller.takeDegraded();
		assert.equal(drained.length, 1, "controller phải xếp đúng 1 entry degrade");
		assert.equal(drained[0]?.taskId, taskId);
		assert.equal(drained[0]?.paneId, paneId);
		assert.equal(degradedSeen.length, 1);
		assert.equal(controller.shouldAttemptSurface(), false, "lockout phải bật ngay degrade đầu tiên (F1)");
		assert.ok(
			await waitUntil(() => readFileSync(runLog, "utf8").includes('"surface.degraded"'), 5_000),
			"RUN event log phải có dòng surface.degraded bền vững",
		);

		// Re-dispatch headless (spec §7 bước 5): cùng runId — lockout chặn surface,
		// worker giả headless hoàn thành → run vẫn done.
		installFakePi(ctx, FAKE_PI_OK_BODY);
		const result2 = await runChildPi(
			makeRunInput(ctx.workRoot, runId, taskId, runLog, {
				surface: { providers: { herdr: provider }, baseDir: ctx.launchDir },
			}),
		);
		assert.equal(result2.surface, undefined, "lockout phải chặn nhánh surface cho phần còn lại của run");
		assert.equal(result2.exitCode, 0, "re-dispatch headless vẫn phải hoàn thành");
	} finally {
		stopKeepAlive();
		await teardownE2e(ctx, runId);
	}
});

// ── Case 3: doctor dọn pane mồ côi thật (T12 wiring) ───────────────────────

test("E2E herdr: doctor liệt kê + đóng pane mồ côi thật, report chứa pane id", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const stopKeepAlive = keepEventLoopAlive();
	try {
		// Pane mồ côi thật: tạo trực tiếp qua provider, không worker nào chạy trong đó.
		const provider = createHerdrProvider();
		const handle = await provider.createSurface("e2e-herdr-doctor-probe", { cwd: ctx.workRoot });
		ctx.panes.push(handle.id);
		assert.ok(await herdrPaneAlive(handle.id), "pane gốc phải đang sống");

		const scan: ZombieScanResult = {
			zombies: [
				{
					pid: 4_242_425,
					ppid: 1,
					crewParentPid: 4_242_424,
					parentAlive: false,
					role: "executor",
					surface: "herdr",
					surfacePaneId: handle.id,
					rssKb: 20_480,
					elapsedSec: 3_600,
					cmd: "pi Task: orphaned surface worker",
				},
			],
			live: [],
			errors: [],
		};
		const cleanupResult = await cleanupOrphanSurfacePanes({
			cwd: ctx.workRoot,
			scan,
			deps: { runScanLimit: 0, tempBase: ctx.launchDir },
		});
		assert.ok(cleanupResult.closed.includes(handle.id), `doctor phải đóng pane thật, kết quả: ${JSON.stringify(cleanupResult)}`);
		assert.ok(await waitUntil(async () => !(await herdrPaneAlive(handle.id)), 5_000), "pane phải biến mất khỏi herdr server");
		const report = formatOrphanPaneReport(cleanupResult);
		assert.ok(report.includes(handle.id), "doctor report phải nêu pane id (T12 text wiring)");
	} finally {
		stopKeepAlive();
		await teardownE2e(ctx);
	}
});
