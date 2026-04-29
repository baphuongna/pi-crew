import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { recommendTeam } from "../../src/extension/team-recommendation.ts";

test("routing metadata is parsed and used by recommendation", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-routing-meta-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew", "agents"), { recursive: true });
		fs.mkdirSync(path.join(cwd, ".crew", "teams"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".crew", "agents", "frontend.md"), "---\nname: frontend\ndescription: Frontend agent\ntriggers: react, css\nuseWhen: user interface work\ncost: cheap\ncategory: frontend\n---\nFrontend specialist\n", "utf-8");
		fs.writeFileSync(path.join(cwd, ".crew", "teams", "frontend.team.md"), "---\nname: frontend\ndescription: Frontend team\ndefaultWorkflow: default\ntriggers: react, ui\n---\n- executor: agent=frontend\n", "utf-8");
		const agents = allAgents(discoverAgents(cwd));
		const teams = allTeams(discoverTeams(cwd));
		assert.equal(agents.find((agent) => agent.name === "frontend")?.routing?.cost, "cheap");
		const recommendation = recommendTeam("build react ui polish", {}, { teams, agents });
		assert.equal(recommendation.team, "frontend");
		assert.match(recommendation.reasons.join("\n"), /routing metadata/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
