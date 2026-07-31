import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

test("parallel-research dynamically fans out Source/pi-* projects into shard tasks", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dynamic-fanout-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		for (const name of ["pi-a", "pi-b", "pi-c", "pi-d", "pi-e", "not-pi"])
			fs.mkdirSync(path.join(cwd, "Source", name), { recursive: true });
		const run = await handleTeamTool(
			{
				action: "run",
				team: "parallel-research",
				config: { runtime: { mode: "scaffold" } },
				goal: "Äá»c sÃ¢u cÃ¡c source pi-* trong Source/",
			},
			{ cwd },
		);
		assert.equal(run.isError, false);
		const loaded = loadRunManifestById(cwd, run.details.runId!);
		assert.ok(loaded);
		const shardTasks = loaded.tasks.filter((task) => task.stepId?.startsWith("explore-shard-"));
		assert.equal(shardTasks.length >= 4, true);
		assert.equal(
			shardTasks.every((task) => task.dependsOn.length === 0),
			true,
		);
		assert.equal(loaded.tasks.filter((task) => task.status === "completed" && task.role === "explorer").length >= 4, true);
		assert.equal(
			loaded.tasks.some((task) => task.stepId === "synthesize" && task.dependsOn.length === shardTasks.length),
			true,
		);
	} finally {
		// Retry cleanup: the run may leave behind files written asynchronously
		// (manifest-cache flush, snapshot writes) that race the recursive delete,
		// causing transient ENOTEMPTY/EBUSY on busy CI runners.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
				break;
			} catch (err) {
				if (attempt === 4 || !/ENOTEMPTY|EBUSY|EPERM/.test(String((err as NodeJS.ErrnoException).code ?? ""))) {
					console.error(`[parallel-research-dynamic test] cleanup failed after ${attempt + 1} attempts:`, err);
					break;
				}
				// brief backoff then retry
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	}
});
