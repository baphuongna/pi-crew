/**
 * b8 — artifact + worktree ops benchmark.
 *
 * Measures artifact persistence via src/state/stores/artifact-store.ts
 * (writeArtifact — the per-task deliverable path):
 *   - write 1/10/100 artifacts (atomic temp-file + rename + hash)
 *   - read-back + hash verification
 *   - cleanupOldArtifacts scan cost
 *
 * WORKTREE OPS: git-worktree based runs (workspaceMode: "worktree") require a
 * live git repo + branch topology. In an isolated bench that is not feasible
 * without fabricating repo state, so worktree ops are recorded as a
 * `limitation` with `worktree: "skipped"` — the suite still passes.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b8-artifact-worktree.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { cleanupOldArtifacts, hashArtifactContent, writeArtifact } from "../src/state/stores/artifact-store.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b8-"));

function makeContent(i: number): string {
	const payload = {
		taskId: `task-${i}`,
		result: `analysis result ${i}`,
		details: "x".repeat(2000),
		producedAt: new Date().toISOString(),
	};
	return JSON.stringify(payload);
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function main(): void {
	const rssBefore = process.memoryUsage().rss;
	const cases: Record<string, unknown> = {};

	for (const count of [1, 10, 100]) {
		const artifactsRoot = path.join(tmpRoot, `art-${count}`);
		fs.mkdirSync(artifactsRoot, { recursive: true });

		// Write batch.
		const w0 = performance.now();
		const descriptors = [];
		for (let i = 0; i < count; i++) {
			descriptors.push(
				writeArtifact(artifactsRoot, {
					kind: "text",
					relativePath: `tasks/task-${i}/result.txt`,
					content: makeContent(i),
					producer: `task-${i}`,
				}),
			);
		}
		const writeMs = performance.now() - w0;

		// Read-back + verify hash.
		const r0 = performance.now();
		for (let i = 0; i < count; i++) {
			const filePath = path.join(artifactsRoot, `tasks/task-${i}/result.txt`);
			const content = fs.readFileSync(filePath, "utf-8");
			hashArtifactContent(content);
		}
		const readMs = performance.now() - r0;

		// Cleanup scan (maxAgeDays tiny → everything expired, exercises prune).
		writeArtifact(artifactsRoot, { kind: "text", relativePath: ".last-cleanup", content: String(Date.now()), producer: "bench" });
		const c0 = performance.now();
		cleanupOldArtifacts(artifactsRoot, { maxAgeDays: 0, scanGraceMs: 0 });
		const cleanupMs = performance.now() - c0;

		const totalBytes = descriptors.reduce((acc, d) => acc + (d.sizeBytes ?? 0), 0);
		cases[`n${count}`] = {
			writeMs: round(writeMs),
			readMs: round(readMs),
			cleanupMs: round(cleanupMs),
			artifactsPerSec: round(count / (writeMs / 1000)),
			totalBytes,
		};
		console.log(`b8 n=${count}: write=${round(writeMs)}ms read=${round(readMs)}ms cleanup=${round(cleanupMs)}ms (${totalBytes}B)`);
	}

	const result = {
		name: "b8.artifact-worktree",
		unit: "ms",
		sizes: [1, 10, 100],
		cases,
		worktree: {
			skipped: true,
			limitation: "worktree ops require a live git repo + branch topology; not feasible in isolated bench",
		},
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
	};
	console.log(JSON.stringify(result));
}

try {
	main();
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
