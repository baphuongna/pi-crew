// D1 (R3-3 — pin project-trust, decided 2026-10-04): worker spawns carry
// `--no-approve` unconditionally so trust no longer depends on the ambient
// ~/.pi/agent/trust.json store. The command-line override applies FIRST in
// pi's trust resolution; project trust never gates tool write capability
// (security.md:33); context files (AGENTS.md) load regardless of trust
// (security.md:57 — probe-verified /tmp/pi-r3impl probe2). Surface TUI spawns
// strip the flag to keep the interactive trust prompt available.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";
import type {
	SurfaceExitReason,
	SurfaceHandle,
	SurfaceProvider,
	SurfaceSpawnOpts,
} from "../../../../src/runtime/surface/surface-provider.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

test("D1: worker spawn argv pins --no-approve (deterministic, ambient-store-free)", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent(), env: {} });
	assert.ok(args.includes("--no-approve"), "--no-approve must be pinned on every worker spawn");
});

/** Minimal fake surface provider — capture the command booted into the pane. */
function captureProvider(): { provider: SurfaceProvider; sent: string[] } {
	const sent: string[] = [];
	const handle: SurfaceHandle = {
		id: "%d1",
		kind: "tmux",
		onExit: (cb: (reason: SurfaceExitReason) => void) => {
			// resolve at next tick — pane "exits" immediately after boot
			setTimeout(() => cb("pane-closed"), 10);
		},
		dispose: () => {
			/* fake pane needs no teardown */
		},
	};
	const provider: SurfaceProvider = {
		kind: "tmux",
		detect: () => ({ ok: true, kind: "tmux" }),
		async createSurface(_id: string, _opts: SurfaceSpawnOpts) {
			return handle;
		},
		async sendCommand(_h: SurfaceHandle, text: string) {
			sent.push(text);
		},
		async closeSurface() {
			/* fake pane closes itself */
		},
		attach: () => null,
		readScreen: async () => "",
	};
	return { provider, sent };
}

test("D1: surface TUI spawn strips --no-approve (interactive trust prompt stays)", async () => {
	const workRoot = mkdtempSync(join(tmpdir(), "d1-surface-"));
	const launchDir = mkdtempSync(join(tmpdir(), "d1-launch-"));
	const eventsPath = join(workRoot, "state", "runs", "run_d1", "events.jsonl");
	try {
		// seed worker.completed so the pane-exit classify resolves "completed"
		mkdirSync(join(eventsPath, ".."), { recursive: true });
		appendFileSync(
			eventsPath,
			`${JSON.stringify({ type: "worker.completed", runId: "run_d1", taskId: "01_d1", data: { result: "done", stopReason: "stop" } })}\n`,
			"utf8",
		);
		const { provider, sent } = captureProvider();
		const result = await runChildPi({
			cwd: workRoot,
			task: "Say hello then stop.",
			agent: agent({ source: "builtin" }),
			runId: "run_d1",
			agentId: "01_d1",
			eventsPath,
			surface: { providers: { tmux: provider }, baseDir: launchDir },
		} as Parameters<typeof runChildPi>[0]);
		assert.ok(result.surface, "fixture must take the surface branch");
		const sentMatch = /^bash '(.+)'; exit$/.exec(sent[0] ?? "");
		assert.ok(sentMatch, `pane command shape: ${sent[0]}`);
		const script = readFileSync(sentMatch[1] as string, "utf8");
		assert.ok(!script.includes("--no-approve"), "surface pane command must NOT carry --no-approve");
		// D5 (R3-19): same strip covers --no-extensions — the default-hermetic
		// worker argv carries it, but a pane keeps the ambient interactive stack.
		assert.ok(!script.includes("--no-extensions"), "surface pane command must NOT carry --no-extensions");
		// Positive control: surface panes pin --tui-mode regular (P0-1) — proves
		// the captured script IS the pane pi command, just without the flag.
		assert.ok(script.includes("--tui-mode"), "sanity: the launch script carries the surface pi command");
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
		rmSync(launchDir, { recursive: true, force: true });
	}
});
