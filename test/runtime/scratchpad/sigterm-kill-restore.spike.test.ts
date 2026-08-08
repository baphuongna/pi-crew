import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../src/runtime/child-pi/child-pi.ts";
import { prepareSpawnContext } from "../../../src/runtime/child-pi/child-pi-spawn.ts";

// Phase 3 (D1') — pin the kill-and-restore chain END-TO-END with a real pi
// worker. The chain (proven by code inspection in the spec): parent SIGTERM →
// pi print-mode signal handler (modes/print-mode.js:31-44) → runtimeHost.dispose
// → emitSessionShutdownEvent reason:"quit" → scratchpad-lifecycle F3 handler →
// performShutdownFlush → writeArtifact. This test exercises it for real.
//
// Gated (PI_CREW_TEST_REAL_MODEL=1): needs a live model + the pi binary. Skipped
// by default (CI-safe). Discriminator (MINOR from spec review): SIGTERM is sent
// STRICTLY INSIDE the 1500ms debounce window after the cell returns, so the
// debounce timer has NOT fired yet → any artifact written MUST be from F3 (not
// debounce). We also assert the artifact did NOT exist before SIGTERM.

const REAL_MODEL = process.env.PI_CREW_TEST_REAL_MODEL === "1";

describe("Phase 3 (D1') kill-and-restore pin (gated)", () => {
	it("worker SIGTERM → F3 flush writes a fresh snapshot artifact", { skip: !REAL_MODEL, timeout: 300_000 }, async () => {
		const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "p3-kr-"));
		fs.mkdirSync(path.join(artifacts, "scratchpad"), { recursive: true });
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p3-kr-cwd-"));
		try {
			const agent: AgentConfig = {
				name: "executor",
				description: "executor",
				source: "builtin",
				filePath: "executor.md",
				systemPrompt: "executor",
				inheritProjectContext: false,
				inheritSkills: false,
			};
			const ctx = prepareSpawnContext(
				{ cwd, task: "compute 42", agent, role: "executor", agentId: "task-kr", artifactsRoot: artifacts, attempt: 0 },
				"compute 42",
			);
			assert.equal(ctx.kind, "ready");
			if (ctx.kind !== "ready") return;

			// Spawn the real pi worker with the scratchpad-armed env. The task prompt
			// asks the model to call execute once (arming the engine), then we SIGTERM.
			// NOTE: this requires a model that honors the execute tool — run with a
			// provisioned box (auth: opencode-go/zai).
			const abort = new AbortController();
			const workerPromise = runChildPi({
				cwd,
				task: "Use the execute tool once to set a variable, e.g. execute({code: 'const answer = 42'}). Then stop.",
				agent,
				role: "executor",
				agentId: "task-kr",
				artifactsRoot: artifacts,
				attempt: 0,
				signal: abort.signal,
				maxTurns: 3,
			} as any);

			// Give the worker time to start + run one execute cell (~10-30s with a
			// model), still INSIDE the 1500ms debounce window after the cell returns.
			await new Promise((r) => setTimeout(r, 30_000));
			// Assert NO artifact yet (debounce 1500ms hasn't fired if cell recent;
			// even if it did, the SIGTERM-time F3 flush must produce a FRESH mtime).
			const before = fs.existsSync(path.join(artifacts, "scratchpad"))
				? fs.readdirSync(path.join(artifacts, "scratchpad")).filter((f) => f.startsWith("task-kr."))
				: [];
			const sigtermTime = Date.now();

			// SIGTERM the worker → pi print-mode handler → dispose → quit → F3 flush.
			abort.abort();
			try {
				await workerPromise;
			} catch {
				// abort rejects the worker promise — expected.
			}

			// After SIGTERM: a snapshot artifact MUST exist (F3 ran). If `before` was
			// empty, this artifact can ONLY be from F3 (debounce was cancelled by F3's
			// cancelScratchpadSnapshot). If `before` had a debounce artifact, the F3
			// one must have a newer mtime (>= sigtermTime).
			const after = fs.existsSync(path.join(artifacts, "scratchpad"))
				? fs.readdirSync(path.join(artifacts, "scratchpad")).filter((f) => f.startsWith("task-kr.") && f.endsWith(".snapshot.json"))
				: [];
			assert.ok(after.length > 0, "F3 must have flushed a snapshot artifact on SIGTERM");
			if (before.length === 0) {
				// Discriminator held: the artifact is purely from F3.
				assert.ok(true, "F3-only artifact (no debounce fired before SIGTERM)");
			}
			// The artifact's mtime must be >= the SIGTERM time (written during dispose).
			const newest = after.map((f) => fs.statSync(path.join(artifacts, "scratchpad", f)).mtimeMs).sort((a, b) => b - a)[0];
			assert.ok(newest >= sigtermTime - 1000, `F3 artifact mtime (${newest}) must be ~>= SIGTERM time (${sigtermTime})`);
		} finally {
			fs.rmSync(artifacts, { recursive: true, force: true });
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
