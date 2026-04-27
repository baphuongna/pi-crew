import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { appendEvent } from "../state/event-log.ts";
import { loadRunManifestById, updateRunStatus } from "../state/state-store.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { loadConfig } from "../config/config.ts";
import { executeTeamRun } from "./team-runner.ts";

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

async function main(): Promise<void> {
	const cwd = argValue("--cwd");
	const runId = argValue("--run-id");
	if (!cwd || !runId) throw new Error("Usage: background-runner.ts --cwd <cwd> --run-id <runId>");

	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) throw new Error(`Run '${runId}' not found.`);
	let { manifest, tasks } = loaded;
	appendEvent(manifest.eventsPath, { type: "async.started", runId: manifest.runId, data: { pid: process.pid } });

	try {
		const team = allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === manifest.team);
		if (!team) throw new Error(`Team '${manifest.team}' not found.`);
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((candidate) => candidate.name === manifest.workflow);
		if (!workflow) throw new Error(`Workflow '${manifest.workflow ?? ""}' not found.`);
		const agents = allAgents(discoverAgents(cwd));
		const loadedConfig = loadConfig(cwd);
		const executeWorkers = loadedConfig.config.executeWorkers === true || process.env.PI_TEAMS_EXECUTE_WORKERS === "1";
		const result = await executeTeamRun({ manifest, tasks, team, workflow, agents, executeWorkers, limits: loadedConfig.config.limits });
		manifest = result.manifest;
		tasks = result.tasks;
		appendEvent(manifest.eventsPath, { type: "async.completed", runId: manifest.runId, data: { status: manifest.status, tasks: tasks.length } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		manifest = updateRunStatus(manifest, "failed", message);
		appendEvent(manifest.eventsPath, { type: "async.failed", runId: manifest.runId, message });
		process.exitCode = 1;
	}
}

await main();
