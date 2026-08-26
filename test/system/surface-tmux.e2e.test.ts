/**
 * surface-tmux.e2e.test.ts — E2E system test MuxSurface A1 trong tmux THẬT
 * (Task 13, spec §13).
 *
 * Khác mọi test surface trước (provider fake, script không bao giờ chạy): ở đây
 * TOÀN BỘ chuỗi là thật trừ binary `pi` —
 *
 *   runChildPi → trySurfaceBranch → prepareSurfaceSpawn
 *     → createTmuxProvider (thật) → tmux split-window (pane thật)
 *     → buildLaunchScript (script bash thật trên đĩa)
 *     → sendCommand `bash <script>; exit` (send-keys thật)
 *     → fake `pi` bash script chạy TRONG pane, tự ghi per-agent log +
 *       worker.completed vào RUN log (shape T11 probe đọc) rồi exit
 *     → pane tự đóng → onExit → classifyOnExit probe thật → result.
 *
 * `pi` giả được cắm qua PI_TEAMS_PI_BIN (đường production duy nhất để đổi
 * binary worker); NPM_CONFIG_PREFIX đưa temp bin dir vào danh sách prefix an
 * toàn mà pi-spawn.ts chấp nhận — không monkey-patch module nào.
 *
 * Skip guard: `process.env.CI || !process.env.TMUX` → skip toàn file — chỉ chạy
 * local bên trong tmux (CI không có mux, fail-closed là đúng thiết kế §3).
 * Chạy local: `npm run test:system` từ một tmux session.
 *
 * Case 2 (degrade, spec §7 D3): worker giả treo (không bao giờ ghi
 * worker.completed) → test kill-pane giữa chừng → classify không thấy completed
 * trong cửa sổ 2s → surface.degraded event + controller lockout + re-dispatch
 * headless với worker giả hoàn thành → run vẫn done.
 *
 * Case 3 (T12 wiring): pane mồ côi thật được doctor liệt kê + đóng, report
 * in ra đúng pane id.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { createTmuxProvider } from "../../src/runtime/surface/tmux-provider.ts";
import { runEventBus } from "../../src/ui/run-event-bus.ts";

/** Chỉ chạy local trong tmux — CI/môi trường không mux thì skip (spec §3). */
const E2E_OPTS: { skip?: string } =
	process.env.CI || !process.env.TMUX ? { skip: "requires a real tmux session ($TMUX unset or CI=1)" } : {};

test.before(() => {
	// Gate §3 và mock path của child-pi phải tắt tuyệt đối — E2E này cần nhánh
	// surface thật, không được chặn từ env thừa của suite.
	delete process.env.PI_CREW_ASYNC_RUN;
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
});

// ── Fake `pi` workers ─────────────────────────────────────────────────────

/**
 * Worker hoàn thành (surface): ghi sentinel mang TMUX_PANE + pid (chứng minh
 * chạy trong ĐÚNG pane), tự report qua per-agent log theo shape T8 recorder
 * ({seq,time,event}), ghi `worker.completed` vào RUN log (D7 report-before-
 * dying) rồi exit 0. Headless: exit 0 ngay — re-dispatch vẫn "done".
 *
 * `sleep 2` cuối giữ pane sống đủ lâu cho test kịp khẳng định pane tồn tại
 * trong list-panes trước khi nó tự đóng.
 */
const FAKE_PI_OK_BODY = [
	"set -u",
	`if [ -z "\${PI_CREW_SURFACE:-}" ]; then`,
	"  # Headless re-dispatch (spec §7 bước 5): hoàn thành sạch để run vẫn done.",
	"  exit 0",
	"fi",
	'AGENT_DIR="$(dirname -- "$PI_CREW_AGENT_EVENTS_PATH")"',
	'mkdir -p -- "$AGENT_DIR"',
	`printf 'TMUX_PANE=%s\nPID=%s\n' "\${TMUX_PANE:-}" "$$" > e2e-sentinel.txt`,
	'SESSION_PATH="$PI_CREW_STATE_ROOT/agents/$PI_CREW_TASK_ID/session.jsonl"',
	'TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
	"# T8 recorder parity: per-agent log là các dòng {seq,time,event}.",
	'printf \'{"seq":1,"time":"%s","event":{"type":"worker.started","pid":%s,"sessionPath":"%s"}}\\n\' "$TS" "$$" "$SESSION_PATH" >> "$PI_CREW_AGENT_EVENTS_PATH"',
	'printf \'{"seq":2,"time":"%s","event":{"type":"worker.completed","result":"E2E SURFACE DONE"}}\\n\' "$TS" >> "$PI_CREW_AGENT_EVENTS_PATH"',
	"# D7 (spec §7): report-before-dying — RUN log phải có worker.completed TRƯỚC khi pane chết.",
	'printf \'{"type":"worker.completed","runId":"%s","taskId":"%s","data":{"result":"E2E SURFACE DONE","stopReason":"stop"}}\\n\' "$PI_CREW_BROKER_RUN_ID" "$PI_CREW_TASK_ID" >> "$PI_CREW_EVENTS_PATH"',
	"sleep 2",
	"exit 0",
].join("\n");

/**
 * Worker treo (surface): sentinel + worker.started rồi sleep — KHÔNG bao giờ
 * ghi worker.completed. Pane chết giữa chừng (test kill-pane) phải đi degrade.
 */
const FAKE_PI_HANG_BODY = [
	"set -u",
	`if [ -z "\${PI_CREW_SURFACE:-}" ]; then`,
	"  exit 0",
	"fi",
	'AGENT_DIR="$(dirname -- "$PI_CREW_AGENT_EVENTS_PATH")"',
	'mkdir -p -- "$AGENT_DIR"',
	`printf 'TMUX_PANE=%s\nPID=%s\n' "\${TMUX_PANE:-}" "$$" > e2e-sentinel.txt`,
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
	/** Mọi pane test này tạo ra — finally kill best-effort để không rò rơi pane. */
	panes: string[];
}

async function setupE2e(): Promise<E2eCtx> {
	const workRoot = mkdtempSync(join(tmpdir(), "surface-e2e-"));
	const fakeBinRoot = mkdtempSync(join(tmpdir(), "surface-e2e-bin-"));
	const launchDir = mkdtempSync(join(tmpdir(), "surface-e2e-launch-"));
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
			execFileSync("tmux", ["kill-pane", "-t", paneId]);
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

function tmuxPaneIds(): Set<string> {
	try {
		const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
		return new Set(
			out
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

async function waitUntil(check: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return check();
}

/**
 * Giữ event loop sống cho trọn test. Toàn bộ I/O của surface path là unref
 * THEO THIẾT KẾ production (tmux poll interval, response deadline, tail
 * bootstrap — host pi TUI luôn có handle riêng giữ loop), nhưng process test
 * thuần thì không: không handle ref nào → node:test coi event loop đã xong và
 * hủy test đang chờ pane ("Promise resolution is still pending"). Keep-alive
 * ref đóng đúng vai trò host-sesion đó.
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

/** Fixture worker spawn chuẩn (parity test/unit child-pi-surface). */
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

test("E2E tmux: pane thật được spawn, script chạy trong pane, pane tự đóng, run hoàn thành", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const runId = "run_e2e_spawn";
	const taskId = "01_explore";
	const runLog = makeRunLog(ctx.workRoot, runId);
	const stopKeepAlive = keepEventLoopAlive();
	try {
		installFakePi(ctx, FAKE_PI_OK_BODY);
		const provider = createTmuxProvider();
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
				surface: { providers: { tmux: provider }, baseDir: ctx.launchDir },
			}),
		);
		const paneId = await paneIdOfSpawn(lifecycle);

		// (1) pane thật xuất hiện trong tmux server (toàn server, không chỉ window).
		assert.ok(await waitUntil(() => tmuxPaneIds().has(paneId), 5_000), `pane ${paneId} phải xuất hiện trong list-panes`);

		const result = await resultPromise;
		off();

		// (2) script pi giả đã chạy ĐÚNG trong pane đó — sentinel mang TMUX_PANE.
		assert.ok(existsSync(join(ctx.workRoot, "e2e-sentinel.txt")), "sentinel phải được ghi bởi script chạy trong pane");
		const sentinel = readSentinel(ctx.workRoot);
		assert.equal(sentinel.TMUX_PANE, paneId, "sentinel phải mang đúng pane id vừa spawn");
		assert.ok(/^\d+$/.test(sentinel.PID ?? ""), "sentinel phải mang pid của worker trong pane");

		// (3) pane tự đóng sau khi worker exit (`; exit` + T8 auto-exit).
		assert.ok(await waitUntil(() => !tmuxPaneIds().has(paneId), 10_000), `pane ${paneId} phải tự đóng sau exit`);

		// (4) run hoàn thành không lỗi: classify đọc được worker.completed của script.
		assert.equal(result.exitCode, 0);
		assert.ok(result.surface, "phải đi nhánh surface");
		assert.equal(result.surface?.kind, "tmux");
		assert.equal(result.surface?.paneId, paneId);
		assert.equal(result.surface?.degraded, undefined, "đã có worker.completed → không được degrade");
		assert.equal(result.rawFinalText, "E2E SURFACE DONE", "result text phải đến từ worker.completed trong RUN log");
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

test("E2E tmux: kill-pane giữa chừng → degrade + lockout + re-dispatch headless vẫn done", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const runId = "run_e2e_degrade";
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
		const provider = createTmuxProvider();
		const lifecycle: ChildPiLifecycleEvent[] = [];

		const result1Promise = runChildPi(
			makeRunInput(ctx.workRoot, runId, taskId, runLog, {
				onLifecycleEvent: (event: ChildPiLifecycleEvent) => {
					lifecycle.push(event);
					if (event.type === "surface_spawned" && event.paneId) ctx.panes.push(event.paneId);
				},
				surface: { providers: { tmux: provider }, baseDir: ctx.launchDir },
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

		// Giết pane giữa chừng — worker chưa hoàn thành, RUN log không có worker.completed.
		execFileSync("tmux", ["kill-pane", "-t", paneId]);

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
				surface: { providers: { tmux: provider }, baseDir: ctx.launchDir },
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

test("E2E tmux: doctor liệt kê + đóng pane mồ côi thật, report chứa pane id", E2E_OPTS, async () => {
	const ctx = await setupE2e();
	const stopKeepAlive = keepEventLoopAlive();
	try {
		// Pane mồ côi thật: tạo trực tiếp qua provider, không worker nào chạy trong đó.
		const provider = createTmuxProvider();
		const handle = await provider.createSurface("e2e-doctor-probe", { cwd: ctx.workRoot });
		ctx.panes.push(handle.id);
		assert.ok(tmuxPaneIds().has(handle.id), "pane gốc phải đang sống");

		const scan: ZombieScanResult = {
			zombies: [
				{
					pid: 4_242_424,
					ppid: 1,
					crewParentPid: 4_242_423,
					parentAlive: false,
					role: "executor",
					surface: "tmux",
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
		assert.ok(await waitUntil(() => !tmuxPaneIds().has(handle.id), 5_000), "pane phải biến mất khỏi tmux server");
		const report = formatOrphanPaneReport(cleanupResult);
		assert.ok(report.includes(handle.id), "doctor report phải nêu pane id (T12 text wiring)");
	} finally {
		stopKeepAlive();
		await teardownE2e(ctx);
	}
});
