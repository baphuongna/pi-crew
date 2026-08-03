/**
 * Fix B — dependency-context tee recovery + hint (breaks the circular re-read).
 *
 * Previously `collectDependencyOutputContext` read upstream results via
 * `readIfSmall` (NO tee) while `sharedReads` used `readIfSmallWithTee` (WITH
 * tee + hint). So a downstream worker saw a truncation marker, re-read
 * `resultPath`, and got the SAME truncated text (circular). Now the dependency
 * path tees the full result and surfaces a "Full output (if you need the
 * missing middle): <path>" hint, exactly like sharedReads.
 *
 * Coupled with Fix A: the dependency result.txt is now RAW, so the tee captures
 * the full uncapped output and re-read recovers everything.
 *
 * @see src/runtime/task-output-context.ts collectDependencyOutputContext / renderDependencyOutputContext
 * @see research-findings/output-handling-deep-dive.md §D
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	collectDependencyOutputContext,
	MAX_RESULT_INLINE_BYTES,
	renderDependencyOutputContext,
} from "../../../../src/runtime/task-output-context.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { WorkflowStep } from "../../../../src/workflows/workflow-config.ts";

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		dir,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

function buildFixtures(dir: string, depResultChars: number) {
	const relResultPath = "results/dep-1.txt";
	const fullResultPath = path.join(dir, relResultPath);
	fs.mkdirSync(path.dirname(fullResultPath), { recursive: true });
	const rawResult = "X".repeat(depResultChars);
	fs.writeFileSync(fullResultPath, rawResult, "utf-8");

	const manifest = {
		artifactsRoot: dir,
		artifacts: [],
	} as unknown as TeamRunManifest;
	const depTask = {
		id: "dep-1",
		stepId: "dep-step",
		role: "explorer",
		status: "completed",
		resultArtifact: { path: relResultPath },
		dependsOn: [],
	} as unknown as TeamTaskState;
	const mainTask = {
		id: "t-1",
		dependsOn: ["dep-step"],
	} as unknown as TeamTaskState;
	const step = {} as unknown as WorkflowStep;
	return { manifest, depTask, mainTask, step, rawResult, fullResultPath };
}

test("dependency result > tee threshold (1.25× MAX_RESULT_INLINE_BYTES) tees the full output", () => {
	const { dir, cleanup } = makeTmpDir("fixb-large-");
	try {
		const chars = Math.ceil(MAX_RESULT_INLINE_BYTES * 1.25) + 100; // >40K → tee fires
		const { manifest, depTask, mainTask, step, rawResult } = buildFixtures(dir, chars);
		const ctx = collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step);
		assert.equal(ctx.dependencies.length, 1);
		const dep = ctx.dependencies[0]!;
		assert.ok(dep.fullOutputPath, "dependency entry must expose fullOutputPath when result is large");
		// The teed file must contain the FULL raw result (byte-equal).
		assert.ok(fs.existsSync(dep.fullOutputPath!), "tee file must exist on disk");
		assert.equal(fs.readFileSync(dep.fullOutputPath!, "utf-8"), rawResult, "tee file must equal the raw result");
	} finally {
		cleanup();
	}
});

test("renderDependencyOutputContext surfaces the recovery hint for dependencies (matches sharedReads wording)", () => {
	const { dir, cleanup } = makeTmpDir("fixb-hint-");
	try {
		const chars = MAX_RESULT_INLINE_BYTES * 2; // well above tee threshold
		const { manifest, depTask, mainTask, step } = buildFixtures(dir, chars);
		const ctx = collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step);
		const rendered = renderDependencyOutputContext(ctx);
		assert.match(
			rendered,
			/Full output \(if you need the missing middle\): .+/,
			"rendered dependency context must include the recovery-hint line",
		);
		// The head+tail inline summary is still present.
		assert.match(rendered, /## dep-1 \(explorer\)/);
	} finally {
		cleanup();
	}
});

test("small dependency result (< MAX_RESULT_INLINE_BYTES) does NOT tee and has no hint", () => {
	const { dir, cleanup } = makeTmpDir("fixb-small-");
	try {
		const chars = 500; // well below the 32K inline threshold
		const { manifest, depTask, mainTask, step, rawResult } = buildFixtures(dir, chars);
		const ctx = collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step);
		const dep = ctx.dependencies[0]!;
		assert.equal(dep.fullOutputPath, undefined, "small results must not tee");
		const rendered = renderDependencyOutputContext(ctx);
		assert.doesNotMatch(rendered, /Full output \(if you need the missing middle\)/, "small results must not emit a recovery hint");
		// Full content survives inline (no truncation).
		assert.ok(rendered.includes(rawResult));
	} finally {
		cleanup();
	}
});

test("re-reading the hinted path recovers the dropped middle (no circular re-read)", () => {
	const { dir, cleanup } = makeTmpDir("fixb-recover-");
	try {
		// A structured result where the "middle" carries a unique sentinel that
		// the 32K head+tail split would drop. The tee + hint must let a worker
		// read it back.
		const head = "HEAD".repeat(20_000);
		const sentinel = "===SENTINEL-IN-MIDDLE-DO-NOT-LOSE===";
		const tail = "TAIL".repeat(20_000);
		const full = `${head}\n${sentinel}\n${tail}`;
		const relResultPath = "results/dep-1.txt";
		const abs = path.join(dir, relResultPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, full, "utf-8");
		const manifest = {
			artifactsRoot: dir,
			artifacts: [],
		} as unknown as TeamRunManifest;
		const depTask = {
			id: "dep-1",
			stepId: "dep-step",
			role: "explorer",
			status: "completed",
			resultArtifact: { path: relResultPath },
			dependsOn: [],
		} as unknown as TeamTaskState;
		const mainTask = {
			id: "t-1",
			dependsOn: ["dep-step"],
		} as unknown as TeamTaskState;
		const step = {} as unknown as WorkflowStep;

		const ctx = collectDependencyOutputContext(manifest, [depTask, mainTask], mainTask, step);
		const dep = ctx.dependencies[0]!;
		assert.ok(dep.fullOutputPath);
		// The inline summary must NOT contain the sentinel (it is in the dropped middle).
		assert.ok(!dep.resultSummary.includes(sentinel), "sentinel should be in the dropped middle");
		// But the teed full output DOES contain it → a worker reading the hint recovers it.
		const recovered = fs.readFileSync(dep.fullOutputPath!, "utf-8");
		assert.ok(recovered.includes(sentinel), "tee full output must contain the dropped sentinel");
	} finally {
		cleanup();
	}
});
