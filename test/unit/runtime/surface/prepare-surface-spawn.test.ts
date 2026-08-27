/**
 * prepareSurfaceSpawn — nhánh spawn surface của child-pi pipeline (spec §13.1).
 *
 * Contract:
 * - Mọi chướng ngại (mode off, async run, depth>0, cap đầy, role không visible,
 *   mux thiếu, provider lỗi, builder lỗi) → `{mode:"headless"}`, KHÔNG BAO GIỜ
 *   throw ra ngoài (fail-closed §3); pane mồ côi được đóng ngay.
 * - Flow đúng thứ tự: sweep TTL registry → resolveSurface → createSurface
 *   (KHÔNG command, trả pane id) → strip `--mode json -p` khỏi piArgs →
 *   buildLaunchScript với env chứa PI_CREW_SURFACE_PANE = id thật +
 *   PI_CREW_PARENT_PID + PI_CREW_PARENT_START_TIME + PI_CREW_AGENT_EVENTS_PATH
 *   → sendCommand(`bash <script>; exit`).
 * - KHÔNG placeholder mechanism: env map trong script mang pane id THẬT.
 * - Task prompt đi vào argv phải shell-escaped — chứng minh bằng cách CHẠY
 *   script thật (resolveCommand injection) rồi đối chiếu stdout nguyên vẹn.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LAUNCH_SCRIPT_TTL_MS, launchScriptRegistry } from "../../../../src/runtime/surface/launch-script.ts";
import { MAX_SURFACE_WORKERS } from "../../../../src/runtime/surface/resolve-surface.ts";
import type {
	SurfaceDetection,
	SurfaceExitReason,
	SurfaceHandle,
	SurfaceProvider,
	SurfaceSpawnOpts,
} from "../../../../src/runtime/surface/surface-provider.ts";
import {
	type PrepareSurfaceSpawnInput,
	prepareSurfaceSpawn,
	readParentStartTime,
	stripHeadlessModeArgs,
	waitForSurfaceExit,
} from "../../../../src/runtime/surface/surface-spawn.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────

interface FakeProviderOptions {
	kind?: "tmux" | "herdr";
	paneId?: string;
	failCreate?: Error;
	withoutSendCommand?: boolean;
}

interface FakeSurfaceProvider extends SurfaceProvider {
	calls: string[];
	sentCommands: string[];
	spawnOptsSeen: SurfaceSpawnOpts[];
	handle: SurfaceHandle;
	closeCalls: Array<{ force?: boolean }>;
}

/** Provider giả ghi lại thứ tự createSurface/sendCommand/closeSurface cho test flow. */
function fakeProvider(options: FakeProviderOptions = {}): FakeSurfaceProvider {
	const kind = options.kind ?? "tmux";
	const paneId = options.paneId ?? "%42";
	const calls: string[] = [];
	const sentCommands: string[] = [];
	const spawnOptsSeen: SurfaceSpawnOpts[] = [];
	const closeCalls: Array<{ force?: boolean }> = [];
	let exitCb: ((reason: SurfaceExitReason) => void) | null = null;
	const handle: SurfaceHandle = {
		id: paneId,
		kind,
		onExit(cb) {
			exitCb = cb;
		},
		// biome-ignore lint/suspicious/noEmptyBlockStatements: fixture không cần dọn gì
		dispose() {},
	};
	return {
		kind,
		calls,
		sentCommands,
		spawnOptsSeen,
		closeCalls,
		handle,
		detect(): SurfaceDetection {
			return { ok: true, kind };
		},
		async createSurface(_name: string, opts: SurfaceSpawnOpts) {
			if (options.failCreate) throw options.failCreate;
			spawnOptsSeen.push(opts);
			calls.push("createSurface");
			return handle;
		},
		async sendCommand(_handle, text) {
			if (options.withoutSendCommand) throw new Error("sendCommand not implemented");
			calls.push("sendCommand");
			sentCommands.push(text);
		},
		async readScreen() {
			return "";
		},
		async closeSurface(_handle, opts) {
			calls.push("closeSurface");
			closeCalls.push(opts ?? {});
		},
		attach() {
			return null;
		},
	};
}

/** Config surface bật rõ ràng cho role `executor` (không cần mux thật). */
function surfaceConfig(mode: "auto" | "tmux" | "herdr" | "off" = "tmux", visibleAgents: string[] = ["*"]) {
	return { runtime: { surface: { mode, visibleAgents } } };
}

/** File thực thi giả để `command -v <path>` thành công (như test T2). */
function fakeBinary(basename: string): string {
	const binDir = mkdtempSync(join(tmpdir(), "surface-spawn-bin-"));
	const binPath = join(binDir, basename);
	writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
	chmodSync(binPath, 0o755);
	binDirsToClean.push(binDir);
	return binPath;
}

const binDirsToClean: string[] = [];

let baseDir: string;

test.before(() => {
	baseDir = mkdtempSync(join(tmpdir(), "surface-spawn-test-"));
});

test.after(() => {
	for (const dir of binDirsToClean) rmSync(dir, { recursive: true, force: true });
	rmSync(baseDir, { recursive: true, force: true });
});

const HOST_ENV = { PATH: process.env.PATH, HOME: tmpdir(), PI_CREW_DEPTH: "0", TMUX: "/tmp/tmux-1000/default,12345,0" };

/** Worker env chuẩn do child-pi build sẵn (headless parity: depth con = cha + 1). */
function workerEnv(extra: Record<string, string> = {}) {
	return {
		PI_CREW_KIND: "subagent",
		PI_CREW_ROLE: "executor",
		PI_CREW_DEPTH: "1",
		...extra,
	};
}

function baseInput(overrides: Partial<PrepareSurfaceSpawnInput> = {}): PrepareSurfaceSpawnInput {
	return {
		env: HOST_ENV,
		workerEnv: workerEnv(),
		config: surfaceConfig(),
		role: "executor",
		livePaneCount: 0,
		taskId: "01_explore",
		cwd: "/tmp/project",
		piArgs: ["--mode", "json", "-p", "--model", "glm-4.7:medium", "Task: hello world"],
		stateRoot: "/tmp/state/runs/run-1",
		baseDir,
		deps: {
			resolve: { tmuxBin: fakeBinary("tmux"), providers: {} },
			resolveCommand: (args) => ({ command: "/bin/echo", args }),
			now: () => 1_000_000_000_000,
		},
		...overrides,
	};
}

function assertHeadless(
	outcome: Awaited<ReturnType<typeof prepareSurfaceSpawn>>,
	reasonPattern?: RegExp,
): asserts outcome is Extract<Awaited<ReturnType<typeof prepareSurfaceSpawn>>, { mode: "headless" }> {
	assert.equal(outcome.mode, "headless", JSON.stringify(outcome));
	if (!reasonPattern || outcome.mode !== "headless") return;
	assert.ok(outcome.reason !== undefined, "fallback headless phải ghi lý do nội bộ");
	assert.match(outcome.reason, reasonPattern);
}

// ── Flow chính ───────────────────────────────────────────────────────────

test("happy path: resolves provider, splits pane WITHOUT command, builds script, then sends `bash <script>`", async () => {
	const provider = fakeProvider();
	launchScriptRegistry.clear();
	const input = baseInput();
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assert.ok(outcome.mode === "surface", JSON.stringify(outcome));
	assert.equal(outcome.kind, "tmux");
	assert.equal(outcome.paneId, "%42");
	assert.equal(outcome.handle.id, "%42");
	// Pane được tạo TRƯỚC khi biết command gì cả — KHÔNG placeholder mechanism.
	// T11 (F4): title = taskId để pane đọc được trong mux, không phải command.
	assert.deepEqual(
		provider.spawnOptsSeen[0],
		{ cwd: "/tmp/project", title: "01_explore" },
		"createSurface chỉ nhận cwd + title (taskId), chưa gửi command",
	);
	// Thứ tự bắt buộc: createSurface → sendCommand.
	assert.deepEqual(provider.calls, ["createSurface", "sendCommand"]);
	// Command gửi vào pane bọc path script bằng shellEscape và thoát shell sau chạy.
	assert.equal(provider.sentCommands.length, 1);
	const sent = provider.sentCommands[0];
	assert.match(sent, /^bash '.+pi-crew-launch-01_explore-\d+\.sh'; exit$/);
	// Script tồn tại trên đĩa đúng path đã escape, 0600, đăng ký TTL registry.
	const scriptPath = sent.slice("bash '".length, sent.length - "; exit".length - 1);
	assert.equal(scriptPath, outcome.scriptPath);
	assert.ok(existsSync(scriptPath));
	assert.equal(statSync(scriptPath).mode & 0o777, 0o600);
	assert.ok(launchScriptRegistry.has(scriptPath), "script phải đăng ký vào TTL registry");
	rmSync(scriptPath, { force: true });
	launchScriptRegistry.clear();
});

test("pre-resolved deps.provider wins over resolveSurface (T11 dispatch owns resolution)", async () => {
	const provider = fakeProvider();
	launchScriptRegistry.clear();
	// Không truyền deps.resolve gì hết — vẫn phải thành công qua provider.injected.
	const outcome = await prepareSurfaceSpawn({ ...baseInput(), deps: { provider } });
	assert.ok(outcome.mode === "surface");
	rmSync((outcome as { scriptPath: string }).scriptPath, { force: true });
	launchScriptRegistry.clear();
});

// ── Fix round 1 (T9 review) — path-formula parity với consumer host ───────
// agent-view / crew-agent-records đọc per-agent file qua safeAgentTaskId
// (strip phần trước ":" + assertSafePathId). surfaceAgentEventsPath phải áp
// CÙNG sanitize — nếu không, taskId chứa ":" làm worker ghi một file khác
// file agent-view đọc (dashboard host tail vẫn khớp vì cùng công thức spawn,
// nhưng agent-view trống).

test("fix r1: taskId chứa ':' được sanitize như agentStateFile — eventsPath + env dùng phần sanitized", async () => {
	launchScriptRegistry.clear();
	const provider = fakeProvider();
	const input = baseInput({ taskId: "01_explore:extra" });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assert.ok(outcome.mode === "surface", JSON.stringify(outcome));
	if (outcome.mode !== "surface") return;
	// safeAgentTaskId("01_explore:extra") = "extra" — đúng file mọi consumer
	// host (agentEventsPath/agentStateFile) đọc cho cùng taskId này.
	assert.equal(outcome.eventsPath, join("/tmp/state/runs/run-1", "agents", "extra", "events.jsonl"));
	const content = readFileSync(outcome.scriptPath, "utf-8");
	assert.match(content, /export PI_CREW_AGENT_EVENTS_PATH='\/tmp\/state\/runs\/run-1\/agents\/extra\/events\.jsonl'/);
	rmSync(outcome.scriptPath, { force: true });
	launchScriptRegistry.clear();
});

test("fix r1: taskId không sanitize được (phần sau ':' unsafe) → fail-closed headless, không throw", async () => {
	launchScriptRegistry.clear();
	const provider = fakeProvider();
	const input = baseInput({ taskId: "01_explore:../escape" });
	input.deps!.resolve!.providers!.tmux = provider;
	// assertSafePathId throw bên trong prepareSurfaceSpawn → catch chung →
	// đóng pane mồ côi + fallback headless (§3) — KHÔNG throw ra caller.
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /surface boot failed: Invalid taskId/);
	launchScriptRegistry.clear();
});

test("script content carries REAL pane id + parent info + agent events path + TUI argv without --mode json", async () => {
	launchScriptRegistry.clear();
	const provider = fakeProvider({ paneId: "%77" });
	const input = baseInput({
		workerEnv: workerEnv({ PI_CREW_RUN_ID: "run-1", PI_CREW_TASK_ID: "01_explore" }),
	});
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assert.ok(outcome.mode === "surface");
	const content = readFileSync(outcome.scriptPath, "utf-8");
	// Pane id THẬT từ createSurface — không placeholder.
	assert.match(content, /export PI_CREW_SURFACE_PANE='%77'/);
	assert.match(content, /export PI_CREW_SURFACE='tmux'/);
	assert.match(content, /export PI_CREW_AUTO_EXIT='1'/);
	assert.match(content, /export PI_CREW_PARENT_PID='\d+'/);
	assert.match(content, /export PI_CREW_AGENT_EVENTS_PATH='\/tmp\/state\/runs\/run-1\/agents\/01_explore\/events\.jsonl'/);
	// Parity headless: worker depth của CHÍNH NÓ (cha+1) vẫn export — parity với
	// spawn stdio; guard lớp 2 đọc CALLER env nên không bị chặn nhầm.
	assert.match(content, /export PI_CREW_DEPTH='1'/);
	// argv TUI: đúng một dòng lệnh (= resolveCommand), KHÔNG có --mode json -p,
	// phần còn lại của argv nguyên vẹn.
	const commandLines = content.split("\n").filter((line) => line.startsWith("'"));
	assert.equal(commandLines.length, 1, `đúng một dòng lệnh worker, thấy ${commandLines.length}`);
	assert.ok(!/--mode\b/.test(commandLines[0]), "surface variant KHÔNG được chứa --mode json -p");
	assert.ok(commandLines[0].includes("--model"), "phải giữ --model và phần còn lại của argv");
	rmSync(outcome.scriptPath, { force: true });
});

test("running the built script delivers the argv verbatim to the worker process (no expansion)", async () => {
	launchScriptRegistry.clear();
	const evilTask = "it's a $(touch pwned-by-test) task with 'quotes'";
	const provider = fakeProvider();
	const input = baseInput({
		piArgs: ["--mode", "json", "-p", "--model", "m", `Task: ${evilTask}`],
	});
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assert.ok(outcome.mode === "surface");
	const stdout = execFileSync("bash", [outcome.scriptPath], { encoding: "utf8" });
	// Arg cuối phải đến NGUYÊN VẸN: không expansion $(…), nháy đơn giữ nguyên.
	assert.equal(stdout, `--model m Task: ${evilTask}\n`);
	assert.ok(!existsSync(outcome.scriptPath), 'script tự xóa qua rm -f -- "$0"');
});

// ── Fail-closed matrix (spec §3) — resolveSurface gate đứng trước provider ──

test("depth > 0 in detection env → headless (guard lớp 1), no pane created", async () => {
	const provider = fakeProvider();
	const input = baseInput({ env: { ...HOST_ENV, PI_CREW_DEPTH: "2" }, livePaneCount: 3 });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /gate "depth"/);
	assert.deepEqual(provider.calls, [], "không được đụng provider khi guard chặn trước");
});

test("livePaneCount >= MAX_SURFACE_WORKERS → headless", async () => {
	const provider = fakeProvider();
	const input = baseInput({ livePaneCount: MAX_SURFACE_WORKERS });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /gate "pane-cap"/);
	assert.deepEqual(provider.calls, []);
	assert.equal(MAX_SURFACE_WORKERS, 6);
});

test("async run env → headless (A1 force)", async () => {
	const provider = fakeProvider();
	const input = baseInput({ env: { ...HOST_ENV, PI_CREW_ASYNC_RUN: "1" } });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome);
	assert.deepEqual(provider.calls, []);
});

test("config mode off / role not visible → headless without creating panes", async () => {
	for (const config of [surfaceConfig("off"), surfaceConfig("tmux", ["planner"])]) {
		const provider = fakeProvider();
		const input = baseInput({ config });
		input.deps!.resolve!.providers!.tmux = provider;
		const outcome = await prepareSurfaceSpawn(input);
		assertHeadless(outcome);
		assert.deepEqual(provider.calls, []);
	}
});

test("provider createSurface throws → headless fallback, error captured internally", async () => {
	const provider = fakeProvider({ failCreate: new Error("split-window failed: no server") });
	const input = baseInput();
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /split-window failed/);
	assert.deepEqual(provider.closeCalls, [], "chưa có pane thì không có gì để đóng");
});

test("build failure AFTER createSurface closes the orphan pane immediately and falls back", async () => {
	launchScriptRegistry.clear();
	const provider = fakeProvider();
	const input = baseInput({ taskId: "../evil" });
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /taskId/i);
	assert.deepEqual(provider.closeCalls, [{ force: true }], "pane mồ côi phải bị đóng ngay");
	assert.equal(launchScriptRegistry.size, 0, "không đăng ký script lỗi vào registry");
});

test("pre-resolved provider is STILL gated by PI_CREW_ASYNC_RUN=1 (fail-closed §3)", async () => {
	const provider = fakeProvider();
	const input = baseInput({ env: { ...HOST_ENV, PI_CREW_ASYNC_RUN: "1" }, deps: { provider } });
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /null|gated|resolution/i);
	assert.deepEqual(provider.calls, [], "gate chạy cả trên đường pre-resolved");
});

test("pre-resolved provider is STILL gated by host depth > 0 (no pane-in-pane)", async () => {
	const provider = fakeProvider();
	const input = baseInput({ env: { ...HOST_ENV, PI_CREW_DEPTH: "3" }, deps: { provider } });
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /null|gated|resolution/i);
	assert.deepEqual(provider.calls, []);
});

test("provider lacking sendCommand → headless fallback + orphan pane closed", async () => {
	const provider = fakeProvider({ withoutSendCommand: true });
	const input = baseInput();
	input.deps!.resolve!.providers!.tmux = provider;
	const outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /sendCommand/i);
	assert.deepEqual(provider.closeCalls, [{ force: true }]);
});

test("pre-spawn sweep removes stale scripts (>60s) from the registry before building a new one", async () => {
	const stalePath = join(baseDir, "pi-crew-launch-stale-old.sh");
	const freshPath = join(baseDir, "pi-crew-launch-stale-fresh.sh");
	launchScriptRegistry.set(stalePath, 999); // quá cũ so với now=1e12
	launchScriptRegistry.set(freshPath, 1_000_000_000_000 - 1000);
	const provider = fakeProvider();
	const input = baseInput({ deps: { provider, now: () => 1_000_000_000_000 } });
	await prepareSurfaceSpawn(input);
	assert.ok(!launchScriptRegistry.has(stalePath), `entry quá TTL (${LAUNCH_SCRIPT_TTL_MS}ms) phải bị sweep trước spawn`);
	assert.ok(launchScriptRegistry.has(freshPath), "entry còn hạn phải được giữ");
	launchScriptRegistry.clear();
});

// ── Helpers thuần ────────────────────────────────────────────────────────

test("stripHeadlessModeArgs removes exactly the leading --mode json -p trio and is safe when absent", () => {
	assert.deepEqual(stripHeadlessModeArgs(["--mode", "json", "-p", "--model", "m"]), ["--model", "m"]);
	// Đã là surface variant → trả nguyên vẹn.
	assert.deepEqual(stripHeadlessModeArgs(["--model", "m"]), ["--model", "m"]);
	assert.deepEqual(stripHeadlessModeArgs([]), []);
	// Trio nằm giữa mảng (tương lai đổi thứ tự) vẫn được gỡ đúng cụm.
	assert.deepEqual(stripHeadlessModeArgs(["--no-session", "--mode", "json", "-p", "--model", "m"]), ["--no-session", "--model", "m"]);
});

test("readParentStartTime returns empty string when stat is unreadable; parses field 22 past weird comm", () => {
	assert.equal(
		readParentStartTime(123, () => undefined),
		"",
	);
	const statLine = "12345 (some weird comm name) S 1 12345 12345 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 9876543210 123456 184143184";
	assert.equal(
		readParentStartTime(123, () => statLine),
		"9876543210",
	);
	// comm chứa ")" cũng phải parse đúng (lastIndexOf, không split naive).
	const trickyStat = "99 ((nested)) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242424242 777 888";
	assert.equal(
		readParentStartTime(99, () => trickyStat),
		"4242424242",
	);
});

// ── Run-end sweep (spec §5.2: sweep khi run kết thúc) ────────────────────

test("sweepLaunchScriptsAtRunEnd removes stale entries and keeps fresh ones", async () => {
	const { sweepLaunchScriptsAtRunEnd } = await import("../../../../src/runtime/surface/surface-spawn.ts");
	const stale = join(baseDir, "pi-crew-launch-runend-old.sh");
	const fresh = join(baseDir, "pi-crew-launch-runend-new.sh");
	launchScriptRegistry.clear();
	launchScriptRegistry.set(stale, 1);
	launchScriptRegistry.set(fresh, 1_000_000_000_000 - 5000);
	const swept = sweepLaunchScriptsAtRunEnd(() => 1_000_000_000_000);
	assert.equal(swept, 1);
	assert.ok(!launchScriptRegistry.has(stale));
	assert.ok(launchScriptRegistry.has(fresh));
	launchScriptRegistry.clear();
});

test("source contract: finalizeRun sweeps the launch-script registry when a run ends", async () => {
	const source = await import("node:fs").then((fs) => fs.readFileSync(join(process.cwd(), "src/runtime/finalize-run.ts"), "utf8"));
	assert.match(
		source,
		/sweepLaunchScriptsAtRunEnd\(/,
		"finalizeRun phải gọi sweepLaunchScriptsAtRunEnd — không sweep thì script mồ côi sống sót qua TTL window ngắn",
	);
});

// ── Final fix I-1 — herdr race: pane chết TRƯỚC lần onExit đầu ───────────
// herdr subscription là edge-event: pane.split → pane chết trong gap ~10-50ms
// → event pane.closed KHÔNG BAO GIỜ tới. forceClose khi đó gọi pane.close trả
// `pane_not_found` mà closeSurface nuốt thành "thành công" — promise không còn
// đường resolve nào → run kẹt tới host Ctrl-C (tmux miễn nhiễm vì poll trạng
// thái). Contract mới: sau MỌI force-close, nếu onExit chưa bắn trong grace
// window thì resolve exit TỔNG HỢP (`synthetic: true`, reason "detached").

/** Outcome giả đã-boot cho waitForSurfaceExit. */
function spawnedOutcomeFor(provider: ReturnType<typeof fakeProvider>) {
	return {
		mode: "surface" as const,
		kind: provider.kind,
		paneId: provider.handle.id,
		handle: provider.handle,
		provider,
		scriptPath: "/tmp/irrelevant.sh",
		eventsPath: null,
	};
}

test("I-1: abort force-close with a silent pane resolves synthetic exit within the grace window", async () => {
	const provider = fakeProvider();
	// biome-ignore lint/suspicious/noEmptyBlockStatements: cố tình im lặng — KHÔNG BAO GIỜ bắn, đúng kịch bản herdr race
	provider.handle.onExit = () => {};
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 10);
	const started = Date.now();
	let hung = false;
	const info = await Promise.race([
		waitForSurfaceExit(spawnedOutcomeFor(provider), { signal: controller.signal, graceAfterForceCloseMs: 30 }).then((v) => ({ v })),
		new Promise<null>((resolve) =>
			setTimeout(() => {
				hung = true;
				resolve(null);
			}, 2000),
		),
	]);
	assert.ok(!hung, "waitForSurfaceExit phải tự thoát qua grace window thay vì treo vô hạn");
	if (!info) return;
	assert.equal(info.v.synthetic, true, "exit phải đánh dấu TỔNG HỢP — không có event thật nào");
	assert.equal(info.v.cancelledByAbort, true);
	assert.equal(info.v.reason, "detached");
	assert.ok(Date.now() - started < 1500, `grace (30ms) + abort (10ms) phải resolve nhanh, thấy ${Date.now() - started}ms`);
});

test("I-1: deadline force-close on a silent pane also resolves via the same fallback", async () => {
	const provider = fakeProvider({ withoutSendCommand: false });
	// biome-ignore lint/suspicious/noEmptyBlockStatements: cố tình im lặng — pane không bao giờ bắn exit
	provider.handle.onExit = () => {};
	let hung = false;
	const info = await Promise.race([
		waitForSurfaceExit(spawnedOutcomeFor(provider), { deadlineMs: 20, graceAfterForceCloseMs: 30 }).then((v) => ({ v })),
		new Promise<null>((resolve) =>
			setTimeout(() => {
				hung = true;
				resolve(null);
			}, 2000),
		),
	]);
	assert.ok(!hung);
	if (!info) return;
	assert.equal(info.v.timedOut, true);
	assert.equal(info.v.synthetic, true, "deadline path đi chung grace fallback");
});

test("I-1: real onExit arriving after force-close still wins over the synthetic fallback", async () => {
	const provider = fakeProvider();
	let realExitCb: ((reason: SurfaceExitReason) => void) | null = null;
	provider.handle.onExit = (cb) => {
		realExitCb = cb;
	};
	const controller = new AbortController();
	const pending = waitForSurfaceExit(spawnedOutcomeFor(provider), { signal: controller.signal, graceAfterForceCloseMs: 10_000 });
	setTimeout(() => {
		controller.abort();
		// onExit THẬT đến sau force-close nhưng vẫn trong grace window.
		queueMicrotask(() => realExitCb?.("pane-closed"));
	}, 5);
	const info = await Promise.race([pending, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000))]);
	assert.notEqual(info, "hung");
	assert.ok(info !== "hung");
	assert.equal(info.synthetic, undefined, "exit THẬT thắng — không được gắn cờ tổng hợp");
	assert.equal(info.reason, "pane-closed");
});

// ── FINDING-3 (report 10tier 2026-08-27): outcome headless phải mang LÝ DO  ──
// gate chi tiết để child-pi emit worker.surface_gate_blocked — phân biệt
// "gate chặn" với "mux probe fail thật" (attempted).

test("gate rejection đi theo outcome headless: resolve path + pre-resolved hard gate, KHÔNG attempted", async () => {
	// resolve path — depth gate (không pre-resolved provider)
	let input = baseInput({ env: { ...HOST_ENV, PI_CREW_DEPTH: "2" } });
	input.deps!.resolve!.providers!.tmux = fakeProvider();
	let outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /depth/);
	assert.equal(outcome.gateRejected?.gate, "depth", JSON.stringify(outcome.gateRejected));
	assert.equal(outcome.attempted, undefined, "gate chặn KHÔNG phải spawn-fail — không đếm lockout");

	// pre-resolved provider + async hard gate → gateRejected từ lớp guard 1
	input = baseInput({ env: { ...HOST_ENV, PI_CREW_ASYNC_RUN: "1" }, deps: { provider: fakeProvider() } });
	outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome);
	assert.equal(outcome.gateRejected?.gate, "async-run", JSON.stringify(outcome.gateRejected));
	assert.equal(outcome.gateRejected?.env.asyncRun, true);

	// mux thật fail SAU khi resolve (createSurface throw) → attempted, KHÔNG gateRejected
	input = baseInput();
	input.deps!.resolve!.providers!.tmux = fakeProvider({ failCreate: new Error("split failed") });
	outcome = await prepareSurfaceSpawn(input);
	assertHeadless(outcome, /split failed/);
	assert.equal(outcome.attempted, true);
	assert.equal(outcome.gateRejected, undefined, "spawn-fail thật không phải gate — để counter lockout xử lý");

	// thành công surface → không gateRejected (type đã đảm bảo field chỉ ở
	// nhánh headless; cast để vẫn pin runtime)
	input = baseInput();
	input.deps!.resolve!.providers!.tmux = fakeProvider();
	outcome = await prepareSurfaceSpawn(input);
	if (outcome.mode !== "surface") throw new Error(`expected surface, got ${outcome.mode}`);
	assert.equal((outcome as { gateRejected?: unknown }).gateRejected, undefined);
});
