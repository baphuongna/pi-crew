import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDisplayActiveRun } from "../runtime/process-status.ts";
import { listRuns } from "./run-index.ts";
import { readCrewAgents } from "../runtime/crew-agent-records.ts";

export function notifyActiveRuns(ctx: ExtensionContext): void {
	const active = listRuns(ctx.cwd)
		.filter((run) => {
			if (run.status !== "queued" && run.status !== "planning" && run.status !== "running") return false;
			// Use the same display filter as the widget/powerbar — runs without
			// real agent evidence (e.g. integration test fixtures) must not appear.
			const agents = readCrewAgents(run);
			return isDisplayActiveRun(run, agents);
		})
		.slice(0, 5);
	if (active.length === 0) return;
	ctx.ui.notify(`pi-crew active runs: ${active.map((run) => `${run.runId} [${run.status}]`).join(", ")}`, "info");
}
