import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

test("agent rename can update team role references", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rename-test-"));
	fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew", "teams"), { recursive: true });
	try {
		const agentPath = path.join(cwd, ".crew", "agents", "worker.md");
		const teamPath = path.join(cwd, ".crew", "teams", "ref-team.team.md");
		fs.writeFileSync(agentPath, "---\nname: worker\ndescription: Worker\n---\n\nDo work.\n", "utf-8");
		fs.writeFileSync(teamPath, "---\nname: ref-team\ndescription: Ref team\ndefaultWorkflow: default\n---\n\n- worker: agent=worker\n", "utf-8");

		const updated = await handleTeamTool({
			action: "update",
			resource: "agent",
			agent: "worker",
			scope: "project",
			updateReferences: true,
			config: { name: "Better Worker" },
		}, { cwd });

		assert.equal(updated.isError, false);
		assert.equal(fs.existsSync(agentPath), false);
		assert.equal(fs.existsSync(path.join(cwd, ".crew", "agents", "better-worker.md")), true);
		assert.match(fs.readFileSync(teamPath, "utf-8"), /agent=better-worker/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
