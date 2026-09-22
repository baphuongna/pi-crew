import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportRunBundle } from "../../../src/extension/run-export.ts";

/**
 * US-022 (2026-09-22) verify-close:
 *  (a) `exportedAt` is now injectable → two exports of the same run are
 *      byte-identical (it sits INSIDE the hashed payload, so a wall-clock
 *      stamp also drifted the sha256 and the markdown `Exported:` line).
 *  (b) the markdown gained a `## Cost` section + inline per-task model and
 *      duration (data already present, previously unrendered).
 *
 * Mutation: drop the `now` param → case (a) goes RED.
 */

const PINNED = new Date("2026-09-15T09:00:00.000Z");

function fixture(cwd: string): { manifest: never; tasks: never[] } {
	const stateRoot = path.join(cwd, ".crew", "state", "runs", "team_us022_demo");
	const artifactsRoot = path.join(cwd, ".crew", "artifacts", "team_us022_demo");
	fs.mkdirSync(stateRoot, { recursive: true });
	fs.mkdirSync(artifactsRoot, { recursive: true });
	const eventsPath = path.join(stateRoot, "events.jsonl");
	fs.writeFileSync(eventsPath, "");
	const manifest = {
		schemaVersion: 1,
		runId: "team_us022_demo",
		status: "completed",
		team: "implementation",
		workflow: "implementation",
		goal: "US-022 determinism probe",
		createdAt: PINNED.toISOString(),
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath,
		artifacts: [],
	} as never;
	const tasks = [
		{
			id: "t1",
			role: "executor",
			agent: "executor",
			status: "completed",
			dependsOn: [],
			cwd,
			model: "anthropic/claude-sonnet-4.5",
			startedAt: PINNED.toISOString(),
			finishedAt: new Date(PINNED.getTime() + 65_000).toISOString(),
			usage: { input: 12_000, output: 4_100, cost: 0.031 },
		},
	] as never[];
	return { manifest, tasks };
}

test("US-022(a): two exports with the same pinned clock are byte-identical", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us022-"));
	try {
		const { manifest, tasks } = fixture(cwd);
		const a = exportRunBundle(manifest, tasks, () => PINNED);
		const first = fs.readFileSync(a.jsonPath, "utf-8");
		const aMd = fs.readFileSync(a.markdownPath, "utf-8");
		const b = exportRunBundle(manifest, tasks, () => PINNED);
		const second = fs.readFileSync(b.jsonPath, "utf-8");
		const bMd = fs.readFileSync(b.markdownPath, "utf-8");
		assert.equal(first, second, "pinned-clock exports must be byte-identical (JSON)");
		assert.equal(aMd, bMd, "pinned-clock exports must be byte-identical (markdown)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-022(b): markdown carries Cost + inline model/duration", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us022-"));
	try {
		const { manifest, tasks } = fixture(cwd);
		const { markdownPath } = exportRunBundle(manifest, tasks, () => PINNED);
		const md = fs.readFileSync(markdownPath, "utf-8");
		assert.ok(md.includes("## Cost"), "markdown must have a Cost section");
		assert.ok(md.includes("tokens:"), "Cost section must show tokens");
		assert.ok(md.includes("cost:"), "Cost section must show cost");
		assert.ok(md.includes("<anthropic/claude-sonnet-4.5>"), "task line must show the model");
		assert.ok(md.includes("[1m5s]"), "task line must show the duration");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
