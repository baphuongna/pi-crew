/**
 * handleApi — `team action="api"` dispatcher.
 *
 * The original 1222-line `if (operation === "…")` chain was split into
 * per-group modules under `./api/` (H3, improvement-plan-2026-08-10):
 *
 *   - api/read.ts           — read/inspect ops + pre-runId ops
 *   - api/plan-approval.ts  — approve-plan, cancel-plan
 *   - api/agent-control.ts  — steer/follow-up/stop/resume/interrupt/nudge
 *   - api/mailbox.ts        — read/validate/read-delivery/send/ack
 *   - api/heartbeat.ts      — write-heartbeat
 *   - api/task-claims.ts    — claim-task, release-task-claim, transition-task-status
 *
 * Each handler is a pure function receiving `ApiHandlerContext`
 * (cfg + loaded + result + paramRequired + params + ctx). This file keeps
 * only the request flow: config parse → pre-runId ops → runId guard →
 * dispatcher → unknown-op error.
 */
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { AGENT_CONTROL_OPERATIONS } from "./api/agent-control.ts";
import { HEARTBEAT_OPERATIONS } from "./api/heartbeat.ts";
import { MAILBOX_OPERATIONS } from "./api/mailbox.ts";
import { PLAN_APPROVAL_OPERATIONS } from "./api/plan-approval.ts";
import { PRE_RUNID_OPERATIONS, READ_OPERATIONS } from "./api/read.ts";
import { TASK_CLAIM_OPERATIONS } from "./api/task-claims.ts";
import { configRecord, result, type TeamContext } from "./context.ts";
import { paramRequired } from "./param-error.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

export { globMatch } from "../../utils/glob-match.ts";

/** Union of all post-load operation dispatchers. */
const API_OPERATIONS: Record<string, import("./api/handler-context.ts").ApiOperationHandler> = {
	...READ_OPERATIONS,
	...PLAN_APPROVAL_OPERATIONS,
	...AGENT_CONTROL_OPERATIONS,
	...MAILBOX_OPERATIONS,
	...HEARTBEAT_OPERATIONS,
	...TASK_CLAIM_OPERATIONS,
};

export async function handleApi(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const cfg = configRecord(params.config);
	const operation = typeof cfg.operation === "string" ? cfg.operation : "read-manifest";

	// Pre-runId operations (metrics-snapshot, inventory) — no loaded run needed.
	const preHandler = PRE_RUNID_OPERATIONS[operation];
	if (preHandler) {
		return preHandler({ cfg, result, paramRequired, params, ctx });
	}

	if (!params.runId)
		return result(paramRequired("api", "runId", "{ action: 'api', runId: 'team_...' }"), { action: "api", status: "error" }, true);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "api", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "api", status: "error" }, true);

	const handler = API_OPERATIONS[operation];
	if (handler) {
		return handler({ cfg, loaded, result, paramRequired, params, ctx });
	}

	// H4 (2026-08-10): list valid operations in the error so a typo (e.g.
	// "claim_task" with an underscore instead of "claim-task") is self-
	// correctable. The list derives from the dispatcher keys, so adding a
	// new operation cannot drift from the error message.
	const known = [...Object.keys(PRE_RUNID_OPERATIONS), ...Object.keys(API_OPERATIONS)];
	return result(
		`Unknown API operation: ${operation}\nValid operations: ${known.join(", ")}`,
		{ action: "api", status: "error", runId: loaded.manifest.runId },
		true,
	);
}
