/**
 * HB-004 smoke #5: full DWF workflow end-to-end (round-12..18 features).
 *
 * Loads a real .dwf.ts via jiti (same path as production) and runs it through
 * runDynamicWorkflow. The script exercises every DWF feature added across
 * rounds 12-18: phase, log, args, budget, pipeline, agent, setResult.
 * Asserts on the resulting events.jsonl.
 *
 * The schema + systemPrompt agent path is covered separately by
 * agent-schema.smoke.ts (this workflow uses a plain agent to keep the tmp-cwd
 * script free of external imports — node_modules can't be resolved from /tmp).
 */
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { SMOKE_ENABLED, SKIP_REASON } from "./_helpers.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const thisFile = fileURLToPath(import.meta.url);

// Workflow script written to the tmp cwd. Must be deterministic (round-13) and
// import NOTHING external (node_modules can't be resolved from /tmp).
const WORKFLOW_SOURCE = [
	'import * as fs from "node:fs";',
	'import * as path from "node:path";',
	'import * as os from "node:os";',
	"",
	"export default async function (ctx) {",
	'\tctx.phase("Setup");',
	'\tctx.log({ event: "start", args: ctx.args(), runId: ctx.runId });',
	'\tctx.log("budget: total=" + ctx.budget.total + " spent=" + ctx.budget.spent());',
	"",
	'\tctx.phase("Work");',
	'\tconst r = await ctx.agent({',
	'\t\trole: "executor",',
	'\t\tprompt: "Reply with exactly: SMOKE-OK",',
	'\t\tmaxTurns: 2,',
	"\t});",
	'\tctx.log({ event: "agent-done", ok: r.ok, hasText: !!r.text });',
	"",
	'\tctx.phase("Pipeline");',
	'\tconst piped = await ctx.pipeline(["a", "b"], (x) => "u:" + x, (x) => x + "!");',
	'\tctx.log({ event: "pipeline-done", result: piped });',
	"",
	'\tconst outDir = path.join(os.tmpdir(), "dwf-smoke-e2e");',
	'\tfs.mkdirSync(outDir, { recursive: true });',
	'\tconst outPath = path.join(outDir, ctx.runId + ".md");',
	'\tfs.writeFileSync(outPath, "smoke-result\\n");',
	'\tctx.setResult(outPath, { smoke: true });',
	"}",
].join("\n");

interface DwfEvent {
	type: string;
	data?: { phase?: string; message?: string };
}

function readEvents(eventsPath: string): DwfEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DwfEvent);
}

test("smoke: full DWF workflow (phase/log/args/budget/pipeline/agent/setResult) end-to-end", { skip: SMOKE_ENABLED ? false : SKIP_REASON }, async () => {
	const jitiMod = require(path.join(repoRoot, "node_modules/jiti/lib/jiti.cjs"));
	const createJiti = jitiMod.default ?? jitiMod;
	const jiti = createJiti(thisFile);
	const dwfMod = (await jiti.import(path.join(repoRoot, "src/runtime/dynamic-workflow-runner.ts") as string)) as {
		default?: { runDynamicWorkflow: (input: unknown) => Promise<{ manifest: { status: string; summary: string } }> };
	};
	const { runDynamicWorkflow } = dwfMod.default ?? (dwfMod as unknown as { runDynamicWorkflow: (input: unknown) => Promise<{ manifest: { status: string; summary: string } }> });

	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-smoke-dwf-"));
	try {
		fs.mkdirSync(path.join(tmpCwd, ".crew", "workflows"), { recursive: true });
		const dwfPath = path.join(tmpCwd, ".crew", "workflows", "smoke-e2e.dwf.ts");
		fs.writeFileSync(dwfPath, WORKFLOW_SOURCE);

		const runId = "team_smoke_dwf_" + Date.now();
		const stateRoot = path.join(tmpCwd, "state");
		fs.mkdirSync(stateRoot, { recursive: true });
		const eventsPath = path.join(stateRoot, "events.jsonl");
		fs.writeFileSync(eventsPath, "");

		const manifest = {
			schemaVersion: 1,
			runId,
			team: "smoke-team",
			workflow: "smoke-e2e",
			goal: "smoke test all DWF features",
			status: "running" as const,
			workspaceMode: "single" as const,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: tmpCwd,
			stateRoot,
			artifactsRoot: path.join(tmpCwd, "artifacts"),
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath,
			artifacts: [],
		};
		const workflow = {
			name: "smoke-e2e",
			description: "smoke",
			source: "project" as const,
			filePath: dwfPath,
			steps: [],
			runtime: "dynamic" as const,
			dynamicScript: dwfPath,
		};
		const team = {
			name: "smoke-team",
			description: "smoke",
			source: "dynamic" as const,
			filePath: "<smoke>",
			roles: [{ name: "worker", agent: "executor" }],
			workspaceMode: "single" as const,
		};

		const result = await runDynamicWorkflow({
			manifest,
			workflow,
			team,
			signal: AbortSignal.timeout(120_000),
		});

		// The workflow completed cleanly.
		assert.equal(result.manifest.status, "completed", `workflow should complete; summary: ${result.manifest.summary.slice(0, 200)}`);

		// And emitted the expected DWF event sequence.
		const events = readEvents(eventsPath);
		const types = events.map((e) => e.type);
		assert.ok(types.includes("dwf.started"), "missing dwf.started");
		assert.ok(types.includes("dwf.completed"), "missing dwf.completed");
		assert.ok(types.filter((t) => t === "dwf.phase_started").length >= 3, "expected >=3 phase_started (Setup/Work/Pipeline)");
		assert.ok(types.filter((t) => t === "dwf.phase_completed").length >= 3, "expected >=3 phase_completed");
		assert.ok(types.filter((t) => t === "dwf.log").length >= 4, "expected >=4 dwf.log events (start, budget, agent-done, pipeline-done)");
		assert.ok(
			!types.includes("dwf.failed"),
			`workflow failed; events: ${JSON.stringify(events.filter((e) => e.type === "dwf.failed"))}`,
		);
	} finally {
		try {
			fs.rmSync(tmpCwd, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});
