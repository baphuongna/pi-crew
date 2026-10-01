/**
 * SDD-3 W-C WI-2 (G11) — resume must preserve runKind and dispatch to the
 * matching engine.
 *
 * Verified gap (pi-crew-upgrade-plan-2026-09-29 §2 G11): the DWF resume ENGINE
 * exists (dwf-runner.ts checkpoint hydration, background-runner runKind
 * short-circuit, run.ts:390-435 dispatch branch) but handleResume had NO
 * runKind branch — resuming a dynamic-workflow run went through the static
 * executeTeamRun path, where the synthetic `dwf-*` team fails team-lookup
 * ("Team not found") and the run is unresumable. Same for `goal-*` teams of
 * goal-loop runs.
 *
 * Red-first evidence: on pre-fix HEAD the dynamic-workflow resume failed with
 * "Team 'dwf-…' not found" (isError) and the goal-loop resume failed with
 * "Team 'goal-…' not found" instead of an engine-level error.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
const realTmp = fs.realpathSync(os.tmpdir());

// These tests resume PROJECT-sourced .dwf.ts scripts, which the F-01 trust gate
// denies unless PI_CREW_TRUST_PROJECT_DWF=1 (mirrors dwf-setresult.test.ts).
const prevTrust = process.env.PI_CREW_TRUST_PROJECT_DWF;
process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
test.after(() => {
	if (prevTrust === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	else process.env.PI_CREW_TRUST_PROJECT_DWF = prevTrust;
});

/** Isolate PI_TEAMS_HOME (TEAMS??CREW mirror winner) so the resume path's
 * registerActiveRun/unregisterActiveRun never touch the real user registry. */
function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-kind-home-"));
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function rmCwd(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`resume-runkind teardown: unable to remove ${cwd}: ${String(error)}`);
				break;
			}
		}
	}
}

/** Craft a CRASHED special-kind run (mirrors run.ts creation shapes): a
 * dynamic-workflow manifest with its synthetic dwf-* team, or a goal-loop
 * manifest with its synthetic goal-* team. Returns the runId. */
function seedSpecialKindRun(cwd: string, runKind: "dynamic-workflow" | "goal-loop"): string {
	const created = createRunManifest({
		cwd,
		team: {
			name: "placeholder",
			description: "",
			source: "project",
			filePath: "<test>",
			roles: [{ name: "worker", agent: "executor" }],
		},
		goal: "resume keeps runKind",
		runKind,
	});
	// No static workflow steps were given, so tasks stay [] like real DWF runs.
	const syntheticTeam =
		runKind === "dynamic-workflow" ? `dwf-${created.manifest.runId.slice(-12)}` : `goal-${created.manifest.runId.slice(-12)}`;
	const manifest: TeamRunManifest = {
		...created.manifest,
		team: syntheticTeam,
		workflow: runKind === "dynamic-workflow" ? "runkind-echo" : "goal-loop",
		status: "failed",
		summary: "simulated crash for resume test",
		updatedAt: new Date().toISOString(),
	};
	saveRunManifest(manifest);
	return manifest.runId;
}

test("G11: resume of a dynamic-workflow run dispatches the DWF engine and preserves runKind", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-dwf-"));
		fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
		try {
			// Project-sourced dynamic workflow whose script just reports a result.
			const artifactPath = path.join(cwd, "dwf-resume-result.txt");
			fs.writeFileSync(artifactPath, "dwf resume ok\n");
			fs.writeFileSync(
				path.join(cwd, ".crew", "workflows", "runkind-echo.dwf.ts"),
				`export default async function run(ctx) {\n\tctx.setResult(${JSON.stringify(artifactPath)});\n}\n`,
			);

			const runId = seedSpecialKindRun(cwd, "dynamic-workflow");

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-resumer" });
			assert.equal(
				resumed.isError,
				false,
				`resume of a dynamic-workflow run must dispatch the DWF engine, not fail team-lookup: ${textFromToolResult(resumed)}`,
			);

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after, "manifest must exist after resume");
			assert.equal(after.manifest.runKind, "dynamic-workflow", "resumed run must KEEP its original runKind");
			assert.equal(after.manifest.status, "completed", "DWF engine must complete the resumed run");

			// The DWF engine ran (dwf.started event), not the static executeTeamRun.
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			assert.match(events, /"type":"dwf\.started"/, "events must show the DWF runner started");
		} finally {
			rmCwd(cwd);
		}
	});
});

test("G11: resume of a goal-loop run without goal state gives an engine-level error, not team-lookup", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-goal-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = seedSpecialKindRun(cwd, "goal-loop");

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-resumer" });
			assert.equal(resumed.isError, true, "resume without goal state must fail");
			const text = textFromToolResult(resumed);
			assert.doesNotMatch(text, /Team 'goal-/, "must NOT fail with the static team-lookup error");
			assert.match(text, /GoalLoopState|goal-loop/i, "error must name the missing goal-loop state/engine");
		} finally {
			rmCwd(cwd);
		}
	});
});
