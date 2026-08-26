/**
 * child-pi-surface.test.ts — nhánh spawn SURFACE trong pipeline runChildPi
 * (spec §13.1). Điểm wiring thật: sau prepareSpawnContext, TRƯỚC khi compose
 * SpawnOptions/spawn().
 *
 * Contract:
 * - Khi surface được quyết định (input.surface.providers hoặc config) và mọi
 *   bước thành công: KHÔNG spawn process stdio nào — thay vào đó pane được tạo,
 *   launch script được viết với env đầy đủ (trong đó PI_CREW_AGENT_EVENTS_PATH
 *   = <stateRoot>/agents/<taskId>/events.jsonl), rồi `bash <script>; exit`
 *   được gửi vào pane. runChildPi trả kết quả mang surface metadata.
 * - Pane exit = hết nguồn chờ → runChildPi resolve (không treo slot worker).
 * - Parent AbortSignal → closeSurface({force}) → resolve như cancelled.
 * - Không opt-in gì cả (config mặc định visibleAgents=[]) → đường headless cũ
 *   giữ nguyên 100%.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildPiLifecycleEvent, ChildPiRunResult } from "../../../../src/runtime/child-pi/child-pi.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import { __test_getTrackedTempDirs } from "../../../../src/runtime/model/pi-args.ts";
import type {
	SurfaceDetection,
	SurfaceExitReason,
	SurfaceHandle,
	SurfaceProvider,
	SurfaceSpawnOpts,
} from "../../../../src/runtime/surface/surface-provider.ts";

interface FakeSurface extends SurfaceProvider {
	sentCommands: string[];
	spawnOptsSeen: SurfaceSpawnOpts[];
	handle: SurfaceHandle;
	closeCalls: Array<{ force?: boolean }>;
	autoExitAfterSend: boolean;
	fireExit(reason: SurfaceExitReason): void;
}

function fakeSurfaceProvider(paneId = "%7"): FakeSurface {
	const sentCommands: string[] = [];
	const spawnOptsSeen: SurfaceSpawnOpts[] = [];
	const closeCalls: Array<{ force?: boolean }> = [];
	let exitCb: ((reason: SurfaceExitReason) => void) | null = null;
	let exited = false;
	let exitReason: SurfaceExitReason | null = null;
	let autoExitAfterSend = true;
	const fireExitOnce = (reason: SurfaceExitReason): void => {
		if (exited) return;
		exited = true;
		exitReason = reason;
		exitCb?.(reason);
	};
	const handle: SurfaceHandle = {
		id: paneId,
		kind: "tmux",
		onExit(cb) {
			exitCb = cb;
			// Replay như provider thật (tmux/herdr) — exit bắn trước khi subscribe
			// không bị mất.
			if (exited && exitReason) cb(exitReason);
		},
		// biome-ignore lint/suspicious/noEmptyBlockStatements: fixture không cần dọn gì
		dispose() {},
	};
	return {
		kind: "tmux",
		sentCommands,
		spawnOptsSeen,
		handle,
		closeCalls,
		get autoExitAfterSend() {
			return autoExitAfterSend;
		},
		set autoExitAfterSend(value: boolean) {
			autoExitAfterSend = value;
		},
		fireExit(reason: SurfaceExitReason) {
			fireExitOnce(reason);
		},
		detect(): SurfaceDetection {
			return { ok: true, kind: "tmux" };
		},
		async createSurface(_name: string, opts: SurfaceSpawnOpts) {
			spawnOptsSeen.push(opts);
			return handle;
		},
		async sendCommand(_handle, text) {
			sentCommands.push(text);
			if (autoExitAfterSend) queueMicrotask(() => fireExitOnce("pane-closed"));
		},
		async readScreen() {
			return "";
		},
		async closeSurface(_handle, opts) {
			closeCalls.push(opts ?? {});
			queueMicrotask(() => fireExitOnce("detached"));
		},
		attach() {
			return null;
		},
	};
}

/** Fixture worker spawn chuẩn: agent tối giản + run state trong temp dir. */
function makeRunInput(tmpRoot: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd: tmpRoot,
		task: "Say hello then stop.",
		agent: {
			name: "executor",
			description: "test executor",
			source: "builtin" as const,
			filePath: "/builtin/agents/executor.md",
			systemPrompt: "",
		},
		model: "glm-test-model",
		runId: "run_surface_1",
		agentId: "01_explore",
		eventsPath: join(tmpRoot, "state", "runs", "run_surface_1", "events.jsonl"),
		transcriptPath: join(tmpRoot, "transcripts", "01_explore.jsonl"),
		...overrides,
	};
}

test.before(() => {
	delete process.env.PI_CREW_ASYNC_RUN;
});

async function setup(): Promise<{ workRoot: string; launchDir: string }> {
	const workRoot = mkdtempSync(join(tmpdir(), "child-pi-surface-run-"));
	const launchDir = mkdtempSync(join(tmpdir(), "child-pi-surface-launch-"));
	return { workRoot, launchDir };
}

function cleanup(workRoot: string, launchDir: string): void {
	rmSync(workRoot, { recursive: true, force: true });
	rmSync(launchDir, { recursive: true, force: true });
}

test("runChildPi boots the worker in a pane via launch script — no stdio process spawned", async () => {
	const { workRoot, launchDir } = await setup();
	try {
		const provider = fakeSurfaceProvider();
		const lifecycle: ChildPiLifecycleEvent[] = [];
		let onSpawnPidSeen: number | undefined;
		const result = await runChildPi(
			makeRunInput(workRoot, {
				onSpawn: (pid: number) => {
					onSpawnPidSeen = pid;
				},
				onLifecycleEvent: (event: ChildPiLifecycleEvent) => lifecycle.push(event),
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);

		// Worker chạy trong pane — không pid process stdio nào được báo cáo.
		assert.equal(onSpawnPidSeen, undefined, "surface mode không spawn process nên không có pid");
		assert.deepEqual(provider.spawnOptsSeen, [{ cwd: workRoot }], "createSurface chỉ nhận cwd — command gửi riêng");

		// Command vào pane: `bash '<script>'; exit` (script tự xóa sau khi chạy).
		assert.equal(provider.sentCommands.length, 1);
		const sentMatch = /^bash '(.+)'; exit$/.exec(provider.sentCommands[0]);
		assert.ok(sentMatch, provider.sentCommands[0]);
		const scriptPath = sentMatch[1] as string;
		assert.match(scriptPath, /pi-crew-launch-01_explore-\d+\.sh$/);
		// Worker giả chưa chạy (provider fake) → script vẫn còn trên đĩa để soát nội dung.
		assert.ok(existsSync(scriptPath), "script phải nằm trên đĩa đúng path đã gửi");
		assert.equal(statSync(scriptPath).mode & 0o777, 0o600);
		const content = readFileSync(scriptPath, "utf8");
		// Env contract của spawn surface (spec §5.2/§13.1).
		assert.match(content, /export PI_CREW_SURFACE_PANE='%7'/);
		assert.match(content, /export PI_CREW_SURFACE='tmux'/);
		assert.match(content, /export PI_CREW_AUTO_EXIT='1'/);
		assert.match(content, /export PI_CREW_PARENT_PID='\d+'/);
		assert.match(
			content,
			new RegExp(
				`export PI_CREW_AGENT_EVENTS_PATH='${escapeRe(join(workRoot, "state", "runs", "run_surface_1", "agents", "01_explore", "events.jsonl"))}'`,
			),
			"T9 host tail file này — path phải khớp layout agents/{taskId}/events.jsonl",
		);
		assert.match(content, /export PI_CREW_KIND='subagent'/);
		assert.match(content, /export PI_CREW_DEPTH='1'/);
		// Prompt task đi bằng positional arg, KHÔNG qua --mode json -p.
		assert.ok(
			!/--mode\b/.test(
				content
					.split("\n")
					.filter((line) => line.includes("--model") || line.includes("Task:"))
					.join("\n"),
			),
			"TUI argv phải bỏ --mode json -p",
		);
		assert.match(content, /Task: Say hello then stop\./);

		// Kết quả có marker surface cho T9/T11 consume.
		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.surface, { kind: "tmux", paneId: "%7", scriptPath });
		// Lifecycle event mặt được host ghi vào run log (worker.surface_spawned).
		assert.ok(
			lifecycle.some((event) => event.type === "surface_spawned"),
			JSON.stringify(lifecycle.map((e) => e.type)),
		);
	} finally {
		cleanup(workRoot, launchDir);
	}
});

test("pane exit resolves runChildPi (no hang) — worker slot must be releasable", async () => {
	const { workRoot, launchDir } = await setup();
	try {
		const provider = fakeSurfaceProvider();
		// Không auto-exit: phải tự bắn sau khi sendCommand đã diễn ra.
		provider.autoExitAfterSend = false;
		const done = runChildPi(makeRunInput(workRoot, { surface: { providers: { tmux: provider }, baseDir: launchDir } }));
		await Promise.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		provider.fireExit("pane-closed");
		const result = await done;
		assert.equal(result.exitCode, 0);
	} finally {
		cleanup(workRoot, launchDir);
	}
});

test("parent AbortSignal force-closes the pane and resolves cancelled", async () => {
	const { workRoot, launchDir } = await setup();
	try {
		const controller = new AbortController();
		const provider = fakeSurfaceProvider();
		provider.autoExitAfterSend = false;
		const done = runChildPi(
			makeRunInput(workRoot, {
				signal: controller.signal,
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		controller.abort();
		const result = await done;
		assert.deepEqual(provider.closeCalls, [{ force: true }], "cancel phải force-close pane thay vì bỏ rơi nó");
		assert.equal(result.aborted, true);
		assert.equal(result.exitCode, null);
	} finally {
		cleanup(workRoot, launchDir);
	}
});

test("default config (nothing opted in) keeps the headless pipeline untouched", async () => {
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	try {
		const { workRoot, launchDir } = await setup();
		try {
			const provider = fakeSurfaceProvider();
			const result: ChildPiRunResult = await runChildPi(
				makeRunInput(workRoot, { surface: { providers: { tmux: provider }, baseDir: launchDir } }),
			);
			// Mock headless intercepts trước nhánh surface — chứng minh pipeline cũ
			// vẫn nguyên vẹn và KHÔNG pane nào bị tạo một cách âm thầm.
			assert.deepEqual(provider.spawnOptsSeen, []);
			assert.equal(result.stdout.length >= 0, true);
		} finally {
			cleanup(workRoot, launchDir);
		}
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		delete process.env.PI_CREW_ALLOW_MOCK;
	}
});

// ── Fix round 1 / F1 — tempDir phải dọn ngay khi pane kết thúc ───────────
// Fixture trước đây dùng systemPrompt:"" nên buildPiWorkerArgs không tạo
// tempDir → leak không thể hiện trong test. Với agent có systemPrompt thật,
// headless path dọn tempDir ở settle(); surface path cũng PHẢI dọn — nếu not,
// mỗi agent có systemPrompt rò rỉ một dir tới session_shutdown.

test("F1: systemPrompt temp dir is cleaned up as soon as the pane exits", async () => {
	const { workRoot, launchDir } = await setup();
	try {
		const before = new Set(__test_getTrackedTempDirs());
		const provider = fakeSurfaceProvider();
		const result = await runChildPi(
			makeRunInput(workRoot, {
				agent: makeAgentWithSystemPrompt(),
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);
		assert.ok(result.surface, "fixture này phải đi đúng nhánh surface");
		// Positive control: systemPrompt thật đã được chuyển thành --system-prompt
		// file → chứng minh buildPiWorkerArgs ĐÃ tạo tempDir trong run này.
		const sentMatch = /^bash '(.+)'; exit$/.exec(provider.sentCommands[0]);
		assert.ok(sentMatch, provider.sentCommands[0]);
		const content = readFileSync(sentMatch[1] as string, "utf8");
		assert.match(content, /--system-prompt/, "systemPrompt phải đi vào argv worker");
		const leaked = __test_getTrackedTempDirs().filter((dir) => !before.has(dir));
		assert.deepEqual(leaked, [], `tempDir của worker surface phải được dọn ngay sau pane exit, còn rò: ${leaked.join(", ")}`);
	} finally {
		cleanup(workRoot, launchDir);
	}
});

// ── Fix round 1 / F2 — deadline tối thiểu (parity timeout headless) ──────

test("F2: a wedged surface worker hits the response deadline and is force-closed", async () => {
	const { workRoot, launchDir } = await setup();
	try {
		const provider = fakeSurfaceProvider();
		provider.autoExitAfterSend = false; // worker treo vĩnh viễn
		let hungWithoutDeadline = false;
		const done = runChildPi(
			makeRunInput(workRoot, {
				responseTimeoutMs: 80,
				surface: { providers: { tmux: provider }, baseDir: launchDir },
			}),
		);
		const result = await Promise.race([
			done.then((value) => ({ value })),
			new Promise<null>((resolve) =>
				setTimeout(() => {
					hungWithoutDeadline = true;
					resolve(null);
				}, 4000),
			),
		]);
		assert.ok(!hungWithoutDeadline, "runChildPi phải resolve qua response deadline thay vì giữ slot vô hạn");
		if (!result || !("value" in result)) return;
		const res = result.value;
		assert.deepEqual(provider.closeCalls, [{ force: true }], "deadline đạt → phải force-close pane");
		assert.equal(res.exitCode, null);
		assert.equal(res.exitStatus?.timedOut, true, "result phải đánh dấu timedOut cho T11 classify degrade");
		assert.match(res.error ?? "", /(response timeout|no completion)/i);
	} finally {
		cleanup(workRoot, launchDir);
	}
});

/** Agent fixture có systemPrompt thật để kích hoạt đường tạo tempDir. */
function makeAgentWithSystemPrompt() {
	return {
		name: "executor",
		description: "test executor",
		source: "builtin" as const,
		filePath: "/builtin/agents/executor.md",
		systemPrompt: "# Executor\nYou are a hard-working executor agent.",
	};
}

function escapeRe(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
