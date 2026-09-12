import { loadRunManifestById } from "../../state/stores/state-store.ts";

/** F1 (2026-09-12 live battery): release the sync foreground waiter with the
 *  parked question. Without this push, the only entity that can answer (the
 *  leader LLM) stays suspended inside its own `team` tool call until the
 *  response watchdog kills the parked worker (evidence: team_20260912014448 —
 *  parked 01:46:01, response_timeout 01:56:01, tool call returned only after
 *  the failure; refuted-fix round 2 evidence: team_20260912053049).
 *
 *  resolveRunPromise is a no-op when no waiter is registered (async/detached
 *  runs poll instead). Best-effort by design: a failure here must not fail
 *  the park itself. Kept in its own module (LAZY-imported from the broker) so
 *  crew-broker.ts stays under the M4 2000-line gate and no static
 *  broker→run-tracker edge exists at module load (there is no cycle —
 *  run-tracker has no broker import). */
export async function pushWaitingToForegroundWaiter(params: {
	cwd: string | undefined;
	runId: string;
	taskId: string;
	questionId: string;
	question: string;
	deadline: number;
	options?: string[];
}): Promise<void> {
	try {
		// LAZY: run-tracker import kept lazy — see the module doc above.
		const { resolveRunPromise } = await import("../run-tracker.ts");
		const freshPark = loadRunManifestById(params.cwd ?? process.cwd(), params.runId);
		if (freshPark) {
			resolveRunPromise(params.runId, {
				manifest: freshPark.manifest,
				tasks: freshPark.tasks,
				waiting: {
					taskId: params.taskId,
					questionId: params.questionId,
					question: params.question,
					deadline: params.deadline,
					...(params.options ? { options: params.options } : {}),
				},
			});
		}
	} catch {
		/* best-effort push: a failure here must not fail the park itself */
	}
}
