import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = { name: "default", description: "default", source: "builtin", filePath: "default.team.md", roles: [{ name: "planner", agent: "planner" }] };
const workflow: WorkflowConfig = { name: "default", description: "default", source: "builtin", filePath: "default.workflow.md", steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }] };

function firstText(result: Awaited<ReturnType<typeof handleTeamTool>>): string {
	const first = result.content?.[0];
	return first && "text" in first ? String(first.text) : "";
}

test("async restart recovery status marks dead background pid failed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-async-restart-"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "dead async recovery" });
		const logPath = path.join(created.manifest.stateRoot, "background.log");
		fs.writeFileSync(logPath, "dead async fixture\n", "utf-8");
		saveRunManifest({ ...created.manifest, status: "running", async: { pid: 999_999_999, logPath, spawnedAt: new Date(Date.now() - 60_000).toISOString() } });
		const status = await handleTeamTool({ action: "status", runId: created.manifest.runId }, { cwd });
		assert.match(firstText(status), /Status: failed/);
		const loaded = loadRunManifestById(cwd, created.manifest.runId)!;
		assert.equal(loaded.manifest.status, "failed");
		assert.equal(readEvents(loaded.manifest.eventsPath).some((event) => event.type === "async.stale"), true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
