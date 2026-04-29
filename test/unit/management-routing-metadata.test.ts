import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

test("management create persists routing metadata", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-management-routing-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const name = `router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		const created = await handleTeamTool({ action: "create", resource: "agent", config: { scope: "project", name, description: "Router", triggers: ["route"], useWhen: ["routing work"], cost: "cheap", category: "routing", systemPrompt: "Route." } }, { cwd });
		assert.equal(created.isError, false);
		const content = fs.readFileSync(path.join(cwd, ".crew", "agents", `${name}.md`), "utf-8");
		assert.match(content, /triggers: route/);
		assert.match(content, /cost: cheap/);
		assert.match(content, /category: routing/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
