/**
 * tmux provider tests (spec §4)
 *
 * Mọi tmux call đi qua deps giả — không chạm binary thật. Các test verify
 * args chuẩn và THỨ TỰ call (spy) thay vì hành vi terminal thật; closeSurface
 * graceful verify escalation SIGTERM → 3s → kill-pane đúng thứ tự.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { SurfaceExitReason, SurfaceHandle, SurfaceProvider } from "../../../../src/runtime/surface/surface-provider.ts";
import { createTmuxProvider, type TmuxProviderDeps } from "../../../../src/runtime/surface/tmux-provider.ts";

/** Harness điều khiển fake tmux — nắm stdout theo args, spy mọi I/O. */
interface FakeHarness {
	deps: TmuxProviderDeps;
	calls: string[][];
	respond: (fn: (args: string[]) => string) => void;
	failWith: (err: Error) => void;
	sleeps: number[];
	kills: number[];
	clearedTimers: number[];
	scheduledMs: () => number | null;
	tick: () => void;
	env: Record<string, string | undefined>;
}

function makeFake(): FakeHarness {
	const calls: string[][] = [];
	let respondFn: (args: string[]) => string = () => "";
	let failure: Error | null = null;
	const sleeps: number[] = [];
	const kills: number[] = [];
	const clearedTimers: number[] = [];
	let tickFn: (() => void) | null = null;
	let scheduledIntervalMs: number | null = null;
	const env: Record<string, string | undefined> = {
		TMUX: "/tmp/tmux-1000/default,12345,0",
		TMUX_PANE: "%0",
	};
	const deps: TmuxProviderDeps = {
		tmux: (args) => {
			calls.push(args);
			if (failure) throw failure;
			return respondFn(args);
		},
		env,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		killTree: (pid) => {
			kills.push(pid);
		},
		hasCommand: () => true,
		schedule: (fn, ms) => {
			tickFn = fn;
			scheduledIntervalMs = ms;
			return {
				clear: () => {
					clearedTimers.push(ms);
					tickFn = null;
				},
			};
		},
	};
	return {
		deps,
		calls,
		respond: (fn) => {
			respondFn = fn;
		},
		failWith: (err) => {
			failure = err;
		},
		sleeps,
		kills,
		clearedTimers,
		scheduledMs: () => scheduledIntervalMs,
		tick: () => {
			tickFn?.();
		},
		env,
	};
}

/** list-panes đang hỏi pid hay pane_dead — element là format-string ghép. */
const pidQuery = (args: string[]): boolean => args.some((a) => a.includes("#{pane_pid}"));

/** Stdout mặc định: split trả %12; panes gồm cha %0 và con %12, pid 12345. */
function defaultRespond(h: FakeHarness): void {
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes" && pidQuery(args)) return "12345 %12\n4242 %0\n";
		if (args[0] === "list-panes") return "0 %12\n0 %0\n";
		return "";
	});
}

/** Spawn 1 pane qua provider thật của harness — trả provider để gọi tiếp. */
async function spawnPane(
	h: FakeHarness,
	opts?: { command?: string; title?: string },
): Promise<{ provider: SurfaceProvider; handle: SurfaceHandle }> {
	const provider = createTmuxProvider(h.deps);
	const handle = await provider.createSurface("t1", {
		cwd: "/tmp/wt",
		command: opts?.command ?? "bash /tmp/pi-crew-launch-t1.sh",
		title: opts?.title,
	});
	return { provider, handle };
}

test("createSurface: split từ $TMUX_PANE, set title, gửi command literal + Enter (đúng thứ tự)", async () => {
	const h = makeFake();
	defaultRespond(h);
	const { handle } = await spawnPane(h, { title: "crew:r1:t1" });
	assert.equal(handle.id, "%12");
	assert.equal(handle.kind, "tmux");
	assert.deepEqual(h.calls, [
		["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-t", "%0"],
		["select-pane", "-t", "%12", "-T", "crew:r1:t1"],
		["send-keys", "-t", "%12", "-l", "bash /tmp/pi-crew-launch-t1.sh"],
		["send-keys", "-t", "%12", "Enter"],
	]);
});

test("createSurface: không title → bỏ qua select-pane", async () => {
	const h = makeFake();
	defaultRespond(h);
	const { handle } = await spawnPane(h);
	assert.equal(handle.id, "%12");
	assert.deepEqual(h.calls, [
		["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-t", "%0"],
		["send-keys", "-t", "%12", "-l", "bash /tmp/pi-crew-launch-t1.sh"],
		["send-keys", "-t", "%12", "Enter"],
	]);
});

test("createSurface: TMUX_PANE thiếu → throw, không gọi tmux nào", async () => {
	const h = makeFake();
	defaultRespond(h);
	delete h.env.TMUX_PANE;
	const provider = createTmuxProvider(h.deps);
	await assert.rejects(() => provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" }), /TMUX_PANE/);
	assert.equal(h.calls.length, 0);
});

test("createSurface: split-window output không phải %N → throw", async () => {
	const h = makeFake();
	h.respond(() => "error: unknown command\n");
	const provider = createTmuxProvider(h.deps);
	await assert.rejects(() => provider.createSurface("t1", { cwd: "/tmp", command: "bash x.sh" }), /split-window/);
});

test("readScreen: capture-pane -p -t id -S -<lines>; default 50", async () => {
	const h = makeFake();
	defaultRespond(h);
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	h.respond(() => "screen content\n");
	const out = await provider.readScreen(handle);
	assert.equal(out, "screen content\n");
	assert.deepEqual(h.calls, [["capture-pane", "-p", "-t", "%12", "-S", "-50"]]);
	await provider.readScreen(handle, 5);
	assert.deepEqual(h.calls.at(-1), ["capture-pane", "-p", "-t", "%12", "-S", "-5"]);
});

test("readScreen/closeSurface: handle không phải tmux → throw", async () => {
	const h = makeFake();
	const provider = createTmuxProvider(h.deps);
	const alien: SurfaceHandle = { id: "w1:p3", kind: "herdr", onExit: () => undefined, dispose: () => undefined };
	await assert.rejects(() => provider.readScreen(alien), /tmux handle/);
	await assert.rejects(() => provider.closeSurface(alien), /tmux handle/);
});

test("closeSurface force: kill-pane ngay — không SIGTERM, không sleep", async () => {
	const h = makeFake();
	defaultRespond(h);
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	await provider.closeSurface(handle, { force: true });
	assert.deepEqual(h.calls, [["kill-pane", "-t", "%12"]]);
	assert.deepEqual(h.kills, []);
	assert.deepEqual(h.sleeps, []);
});

test("closeSurface graceful: SIGTERM pid → đợi 3s → pane vẫn sống → kill-pane (đúng thứ tự)", async () => {
	const h = makeFake();
	defaultRespond(h);
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	await provider.closeSurface(handle);
	// Thứ tự: alive-check → pid query → SIGTERM → sleep 3s → alive-check → kill-pane
	assert.deepEqual(h.calls, [
		["list-panes", "-F", "#{pane_dead} #{pane_id}"],
		["list-panes", "-F", "#{pane_pid} #{pane_id}"],
		["list-panes", "-F", "#{pane_dead} #{pane_id}"],
		["kill-pane", "-t", "%12"],
	]);
	assert.deepEqual(h.kills, [12345]);
	assert.deepEqual(h.sleeps, [3000]);
});

test("closeSurface graceful: pane chết trong lúc chờ → bỏ kill-pane", async () => {
	const h = makeFake();
	let dead = false;
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (pidQuery(args)) return "12345 %12\n";
		return dead ? "1 %12\n" : "0 %12\n";
	});
	const realSleep = h.deps.sleep as (ms: number) => Promise<void>;
	h.deps.sleep = async (ms) => {
		await realSleep(ms);
		dead = true;
	};
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	await provider.closeSurface(handle);
	assert.deepEqual(h.kills, [12345]);
	assert.deepEqual(h.sleeps, [3000]);
	assert.ok(!h.calls.some((c) => c[0] === "kill-pane"));
});

test("closeSurface graceful: pane đã đóng từ đầu → no-op idempotent", async () => {
	const h = makeFake();
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (pidQuery(args)) return "12345 %12\n";
		return "1 %12\n";
	});
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	await provider.closeSurface(handle);
	assert.deepEqual(h.calls, [["list-panes", "-F", "#{pane_dead} #{pane_id}"]]);
	assert.deepEqual(h.kills, []);
	assert.deepEqual(h.sleeps, []);
});

test("closeSurface graceful: không tìm được pid → force kill-pane ngay, không sleep", async () => {
	const h = makeFake();
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (pidQuery(args)) return "";
		return "0 %12\n";
	});
	const { provider, handle } = await spawnPane(h);
	h.calls.length = 0;
	await provider.closeSurface(handle);
	assert.deepEqual(h.kills, []);
	assert.deepEqual(h.sleeps, []);
	assert.deepEqual(h.calls.at(-1), ["kill-pane", "-t", "%12"]);
});

test("onExit: pane_dead=1 → 'pane-closed' đúng một lần; tick sau đó im lặng", async () => {
	const h = makeFake();
	let dead = false;
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes") return dead ? "1 %12\n" : "0 %12\n";
		return "";
	});
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	assert.equal(h.scheduledMs(), 2000);
	h.tick(); // pane còn sống
	assert.deepEqual(reasons, []);
	dead = true;
	h.tick();
	assert.deepEqual(reasons, ["pane-closed"]);
	h.tick(); // không bắn lần 2
	assert.deepEqual(reasons, ["pane-closed"]);
});

test("onExit: pane biến khỏi list-panes → 'pane-closed'", async () => {
	const h = makeFake();
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes") return "0 %0\n";
		return "";
	});
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	h.tick();
	assert.deepEqual(reasons, ["pane-closed"]);
});

test("onExit: tmux call throw (ENOENT) → 'mux-dead' cho mọi handle sống + dừng timer", async () => {
	const h = makeFake();
	let splitCount = 0;
	h.respond((args) => {
		if (args[0] === "split-window") {
			splitCount += 1;
			return splitCount === 1 ? "%12\n" : "%13\n";
		}
		if (args[0] === "list-panes") return "0 %12\n0 %13\n";
		return "";
	});
	const { provider, handle } = await spawnPane(h);
	const second = await provider.createSurface("t2", { cwd: "/tmp", command: "bash y.sh" });
	const r1: SurfaceExitReason[] = [];
	const r2: SurfaceExitReason[] = [];
	handle.onExit((r) => r1.push(r));
	second.onExit((r) => r2.push(r));
	h.failWith(new Error("spawn tmux ENOENT"));
	h.tick();
	assert.deepEqual(r1, ["mux-dead"]);
	assert.deepEqual(r2, ["mux-dead"]);
	assert.equal(h.clearedTimers.length, 1);
});

test("dispose: host chủ động dispose → 'detached'; poll sau đó không bắn 'pane-closed'", async () => {
	const h = makeFake();
	let dead = false;
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes") return dead ? "1 %12\n" : "0 %12\n";
		return "";
	});
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	handle.dispose();
	assert.deepEqual(reasons, ["detached"]);
	dead = true;
	h.tick();
	assert.deepEqual(reasons, ["detached"]);
	assert.equal(h.clearedTimers.length, 1);
});

test("dispose sau khi exit: không bắn thêm event nào", async () => {
	const h = makeFake();
	let dead = false;
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes") return dead ? "1 %12\n" : "0 %12\n";
		return "";
	});
	const { handle } = await spawnPane(h);
	const reasons: SurfaceExitReason[] = [];
	handle.onExit((r) => reasons.push(r));
	dead = true;
	h.tick();
	handle.dispose();
	assert.deepEqual(reasons, ["pane-closed"]);
});

test("onExit đăng ký sau exit → replay reason ngay lập tức", async () => {
	const h = makeFake();
	let dead = false;
	h.respond((args) => {
		if (args[0] === "split-window") return "%12\n";
		if (args[0] === "list-panes") return dead ? "1 %12\n" : "0 %12\n";
		return "";
	});
	const { handle } = await spawnPane(h);
	const first: SurfaceExitReason[] = [];
	handle.onExit((r) => first.push(r));
	dead = true;
	h.tick();
	const late: SurfaceExitReason[] = [];
	handle.onExit((r) => late.push(r));
	assert.deepEqual(late, ["pane-closed"]);
});

test("attach: pane sống → handle; không tồn tại/dead → null", () => {
	const h = makeFake();
	defaultRespond(h);
	const provider = createTmuxProvider(h.deps);
	const attached = provider.attach("%12");
	assert.equal(attached?.id, "%12");
	assert.equal(attached?.kind, "tmux");
	assert.deepEqual(h.calls, [["list-panes", "-F", "#{pane_dead} #{pane_id}"]]);
	assert.equal(provider.attach("%99"), null);
	h.respond((args) => (args[0] === "list-panes" ? "1 %12\n" : ""));
	assert.equal(provider.attach("%12"), null);
});

test("detect: TMUX + binary → ok; thiếu TMUX hoặc binary → !ok kèm reason", () => {
	const h = makeFake();
	const provider = createTmuxProvider(h.deps);
	assert.deepEqual(provider.detect(), { ok: true, kind: "tmux" });
	delete h.env.TMUX;
	const noEnv = provider.detect();
	assert.equal(noEnv.ok, false);
	assert.ok(noEnv.reason);
	h.env.TMUX = "/tmp/tmux-1000/default,12345,0";
	// hasCommand được capture lúc tạo provider — override trước khi tạo provider mới.
	const noBinProvider = createTmuxProvider({ ...h.deps, hasCommand: () => false });
	const noBin = noBinProvider.detect();
	assert.equal(noBin.ok, false);
	assert.ok(noBin.reason);
});
