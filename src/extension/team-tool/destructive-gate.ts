/**
 * Permission gate logic for destructive team actions (delete/forget/prune/cleanup).
 *
 * Extracted from register.ts `pi.on("tool_call")` handler into a pure function
 * so the gate logic is unit-testable in isolation (the handler itself is hard
 * to test because it's an async event listener on the Pi extension API).
 *
 * Returns `undefined` when the action is ALLOWED, or a block `reason` string
 * when it should be blocked. The handler wraps this and emits the `{block, reason}`
 * shape Pi expects.
 *
 * Rules (in order):
 *  1. Non-team / non-destructive actions → allowed (caller pre-filters, but safe).
 *  2. `cleanup`/`prune` with `dryRun=true` → ALWAYS allowed (a preview writes
 *     nothing, so gating it would block users from previewing what the action
 *     would do — this was a UX bug: team action=cleanup dryRun=true returned
 *     "requires confirm=true" even though it changed no files; prune gained a
 *     true dryRun preview in the prune-honor-dryRun fix).
 *  3. `confirm=true` on the input → allowed (explicit user intent).
 *  4. `delete` with `force=true` → allowed (force bypasses reference checks).
 *  5. Otherwise → blocked with a reason telling the user what to pass.
 */

import { getCrewEnv } from "../../config/env-vars.ts";
import { currentCrewDepth } from "../../runtime/model/pi-args.ts";

export const DESTRUCTIVE_TEAM_ACTIONS = new Set([
	"delete",
	"forget",
	"prune",
	"cleanup",
	"workflow-create",
	"workflow-save",
	"workflow-delete",
]);

export interface TeamToolInputLike {
	action?: unknown;
	confirm?: unknown;
	force?: unknown;
	dryRun?: unknown;
}

/**
 * Decide whether a destructive team action should be blocked.
 * @returns block reason string, or `undefined` to allow.
 */
export function shouldBlockDestructiveTeamAction(action: string | undefined, input: TeamToolInputLike): string | undefined {
	if (!action || !DESTRUCTIVE_TEAM_ACTIONS.has(action)) return undefined;
	// dryRun is a PREVIEW (no writes) — never needs confirm. Only allow the
	// bypass for actions whose handlers actually honor dryRun as non-destructive:
	//   - cleanup (handleProjectCleanup/handleUserCleanup branch on dryRun)
	//   - prune   (pruneFinishedRuns skips deletion/worktree-cleanup/audit when
	//              dryRun; handlePrune bypasses confirm)
	// forget/delete have no dryRun path (they always mutate), so they stay gated.
	if ((action === "cleanup" || action === "prune") && input.dryRun === true) return undefined;
	if (input.confirm === true) return undefined;
	const forceBypassesReferenceChecks = action === "delete" && input.force === true;
	if (forceBypassesReferenceChecks) return undefined;
	return `Destructive action '${action}' requires confirm=true${action === "delete" ? " (or force=true to bypass reference checks)" : ""}.`;
}

// ---------------------------------------------------------------------------
// Root-session gate (merged from root-gate.ts — Wave-3; lazy-import budget)
// ---------------------------------------------------------------------------
/**
 * Root-session gate for user-tier persistent team actions (Wave-3).
 *
 * Deep-audit findings R2-M-B1, R3-SEC-1, R5-M-B1, R5-M-B2 (pi-crew-deep-review
 * 2026-10-16): eight team-tool entry points could persist state OUTSIDE the
 * current workspace — user-tier config (`~/.pi/agent/pi-crew.json`), user-tier
 * agents/teams/workflows (`~/.pi/agent/{agents,teams,workflows}/`), the
 * project scheduler, autonomous goal loops, and the Pi UI theme — from ANY
 * caller with the `team` tool, including nested workers and repo-planted
 * parity sessions. A worker that persists there survives the task and
 * affects every future pi session (attack chains A/D/E).
 *
 * OWNER-DECIDED policy (Wave-3): gate on WORKER ORIGIN — actions initiated
 * from a NON-ROOT session (PI_CREW_KIND=subagent or crew depth > 0) are
 * rejected when they would write outside the project tier; project-scope
 * writes stay worker-reachable (project-tier agent files already get SEC-1
 * extension stripping).
 *
 * Gated matrix (non-root sessions only):
 *   - `schedule`  — ALL mutations (add is the default subAction; reads use
 *                   `scheduled`, a different action).
 *   - `goal`      — `start` (any), plus ANY subAction carrying force:true.
 *   - `config`    — mutations whose resolved scope is `user` (project allowed).
 *   - `settings`  — `set`/`unset` at scope `user` (project allowed);
 *                   `theme` always (it always writes the user tier).
 *   - `autonomy`  — mutations (the autonomous patch always writes user tier).
 *   - `create` /  — when resolved scope is `user` (create defaults to user;
 *   - `update`     update is gated at the resolved resource's scope — see
 *                   the post-`resolveMutable` call in management.ts).
 *   - `delete`    — user tier only at the facade (config.scope); handleDelete
 *                   re-gates on the RESOLVED resource tier (management.ts)
 *                   because `resolveMutable` pools user+project when no scope
 *                   is given (w5a: the delete sibling of the update gate).
 *   - `cleanup`   — top-level `scope: "user"` only (handleCleanup routes on
 *                   that carrier); runId/project cleanup stay project-tier.
 *   - `init`      — unless the resolved config scope is project/none
 *                   (config.configScope/config.scope carriers, mirroring
 *                   dispatch/manage.ts); the default is `global`, which
 *                   writes `~/.pi/agent/pi-crew.json` (overwrite:true
 *                   replaces a customized config).
 *   - `workflow-` — ALWAYS (fix-wave 6, R11-S1): .dwf.ts scripts are
 *     `create`/    arbitrary code auto-loaded by every future session —
 *     `save`/      project tier included (`.crew/workflows/` is discovered
 *     `delete`     per-repo) and delete reaches the user tier. This is a
 *                  deliberate exception to "project stays worker-reachable".
 *                  workflow-get/list (reads) stay open.
 *   - `import` /  — at resolved scope `user` only (project/default open,
 *   - `export`      mirroring handleImport's project default).
 *
 * Scope source (fix-wave 6, R11-F1): the canonical carrier is `config.scope`
 * — the ONE key every scope-bearing handler reads. Top-level `params.scope`
 * is ignored by the gate (as it already is by the handlers) so divergent
 * carriers cannot smuggle a user-tier write past the gate.
 *
 * Reads (config/status/list, settings list/get, schedule `scheduled`) are
 * never gated. `dryRun` carriers do NOT exempt mutating actions from this
 * gate (w5a, rootGateDryRunPreviewExemptsMutatingHandlers): handleStart
 * (goal.ts) has no dryRun branch at all and handleCreate (management.ts)
 * honors only top-level `params.dryRun`, so a config-carrier "preview" of
 * `goal start` / `create` would mutate for real. Previews therefore traverse
 * the SAME matrix as execution — the schedule precedent ("previews of actions
 * without a dryRun contract are gated").
 */

/** Typed error so callers/tests can distinguish the gate from handler errors. */
export class RootSessionRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RootSessionRequiredError";
	}
}

/**
 * True when this process is the user's ROOT pi session (not a pi-crew worker:
 * PI_CREW_KIND !== "subagent" AND currentCrewDepth === 0). Mirrors the broker
 * credential gate in lifecycle-handlers.ts — the depth-gate pattern proven
 * in-repo (broker tests).
 */
export function isRootSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (getCrewEnv("PI_CREW_KIND", env) === "subagent") return false;
	try {
		return currentCrewDepth(env) === 0;
	} catch {
		return false;
	}
}

export type RootGateScope = "user" | "project";

/**
 * Core predicate: does this (action, subcommand, scope) combination require a
 * root session? Pure — callers resolve the subcommand/scope from their params
 * (see {@link rootGateBlockReason} for the raw-params resolver used by the
 * team-tool facade).
 *
 * @returns a {@link RootSessionRequiredError} when the action must be blocked
 * for non-root sessions, or `undefined` when allowed.
 */
export function assertRootOnlyAction(
	action: string,
	subcommand: string | undefined,
	scope: RootGateScope | undefined,
	env: NodeJS.ProcessEnv = process.env,
): RootSessionRequiredError | undefined {
	if (isRootSession(env)) return undefined;
	const detail = (what: string): RootSessionRequiredError =>
		new RootSessionRequiredError(
			`root-session required: team action '${action}'${subcommand ? ` (${subcommand})` : ""} ${what}. ` +
				"This session is a pi-crew worker (PI_CREW_KIND/subagent or depth>0); user-tier state persists beyond the task and is reserved for the user's root pi session. " +
				(what.includes("project")
					? ""
					: "Re-run with config: {scope: 'project'} for project-local effects, or from the root session."),
		);
	switch (action) {
		case "schedule":
			// ALL mutations; reads go through the separate `scheduled` action.
			return detail("creates/modifies persistent scheduled jobs");
		case "goal":
			if (subcommand === "start") return detail("starts a persistent autonomous goal loop");
			if (subcommand === "force") return detail("bypasses goal-ownership via force:true (stop/resume/clear/pause)");
			// other goal ops (status/pause/stop without force) stay open.
			return undefined;
		case "config":
			if (scope === "user") return detail("writes user-scope config (all future sessions)");
			return undefined;
		case "settings":
			// `theme` always writes the user tier; set/unset gated at user scope.
			if (subcommand === "theme") return detail("switches the user-tier Pi UI theme");
			if ((subcommand === "set" || subcommand === "unset") && scope === "user")
				return detail("writes user-scope settings (all future sessions)");
			return undefined;
		case "autonomy":
			// The autonomous patch ALWAYS writes the user tier.
			return detail("writes the user-tier autonomy config (all future sessions)");
		case "create":
			if (scope === "user") return detail("plants a user-tier resource loaded by every future session");
			return undefined;
		case "update":
			if (scope === "user") return detail("rewrites a user-tier resource loaded by every future session");
			return undefined;
		case "delete":
			// w5a (rootGateActionMatrixOmitsDeleteCleanupInit): delete shares
			// update's resource resolution (resolveMutable pools user+project when
			// no scope is given) but previously fell through the switch default —
			// a worker could unlink user-tier agents/teams/workflows. Gate the
			// config-carrier user scope HERE (pre-filter, like update) and the
			// RESOLVED resource tier in handleDelete (management.ts), where the
			// matched file's tier is finally known.
			if (scope === "user") return detail("deletes a user-tier resource loaded by every future session");
			return undefined;
		case "cleanup":
			// Only the scope=user branch (handleUserCleanup) destroys user-tier
			// state: the whole userCrewRoot() run-history/artifacts tree plus the
			// global config with force:true. runId cleanup and project cleanup stay
			// project-tier and worker-reachable (Wave-3 policy).
			if (scope === "user") return detail("removes the user-tier pi-crew state directory and global config");
			return undefined;
		case "init":
			// configScope defaults to 'global' (dispatch/manage.ts) -> writes
			// ~/.pi/agent/pi-crew.json; overwrite:true replaces a customized config.
			// The facade resolves init's config scope from its own carriers
			// (config.configScope OR config.scope, mirroring the dispatch union) —
			// global (the default) is user-tier and gated; project/none stay
			// worker-reachable.
			if (scope !== "project") return detail("writes/replaces the global pi-crew config (all future sessions)");
			return undefined;
		case "workflow-create":
		case "workflow-save":
			// R11-S1 (fix-wave 6 M1-3): a .dwf.ts is arbitrary code auto-loaded by
			// every future session in the discovery dirs — project tier included
			// (`.crew/workflows/` of this repo). Unconditional for workers, like
			// autonomy: no worker-reachable scope (confirm:true is caller-
			// controlled and thus no barrier).
			return detail("writes a dynamic-workflow .dwf.ts script auto-loaded by future sessions (arbitrary-code surface)");
		case "workflow-delete":
			// The target's tier is resolved from the named workflow at delete time
			// (not from params) and includes the user tier — fail closed for workers.
			return detail("deletes a persistent dynamic-workflow file (user tier included)");
		case "import":
			if (scope === "user") return detail("imports a run bundle into user-scope state (all future sessions)");
			return undefined;
		case "export":
			if (scope === "user") return detail("writes a user-scope run export (all future sessions)");
			return undefined;
		default:
			return undefined;
	}
}

export interface RootGateParamsLike {
	action?: unknown;
	/** Top-level scope override ("user" | "project" | "both"). */
	scope?: unknown;
	/** Top-level force (goal ops). */
	force?: unknown;
	/** Top-level subAction (schedule/goal). */
	subAction?: unknown;
	/** Advisory-only dryRun preview flag. */
	dryRun?: unknown;
	/** Destructive-gate confirm flag — caller-controlled, so the root-gate
	 * deliberately does NOT treat it as a bypass (R11-S1 pin). */
	confirm?: unknown;
	config?: unknown;
}

function configRecord(config: unknown): Record<string, unknown> {
	return config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
}

/**
 * R11-F1 (fix-wave 6, M1-2): the canonical scope carrier is `config.scope` —
 * the same key every scope-bearing handler reads (create/settings/config in
 * their dispatch paths, import and workflow-create in their handlers). The
 * previous `params.scope ?? config.scope` read let a divergent
 * `{scope: "project", config: {scope: "user"}}` payload pass the gate while
 * the handler wrote the user tier. Handlers ignore top-level `scope`, so the
 * gate must too. Per-action defaults mirror each handler's own default when
 * the carrier is absent: import/export default `project` (handleImport),
 * everything else defaults `user` (fail-closed, like create/settings/config).
 */
function resolveScopeParam(params: RootGateParamsLike, action?: string): RootGateScope {
	const fromConfig = configRecord(params.config).scope;
	if (fromConfig === "project") return "project";
	if (fromConfig === "user") return "user";
	return action === "import" || action === "export" ? "project" : "user";
}

/**
 * w5a (rootGateActionMatrixOmitsDeleteCleanupInit): `init` resolves its config
 * scope from config.configScope OR config.scope with UNION semantics
 * (dispatch/manage.ts: either carrier "project" → project; either carrier
 * "none" → none; anything else, including an absent carrier, → "global").
 * Only the "global" outcome writes the user tier (~/.pi/agent/pi-crew.json),
 * so project AND none map to the worker-reachable bucket here. Note
 * `configScope` must NOT participate in the shared {@link resolveScopeParam}:
 * create/settings/config ignore it and default to user, so a configScope:
 * 'project' fallback there would OPEN the gate on a user-tier write.
 */
function resolveInitConfigScope(params: RootGateParamsLike): RootGateScope {
	const cfg = configRecord(params.config);
	const projectScope = cfg.configScope === "project" || cfg.scope === "project";
	const noneScope = cfg.configScope === "none" || cfg.scope === "none";
	return projectScope || noneScope ? "project" : "user";
}

/**
 * Facade resolver: derive (subcommand, scope) from raw team-tool params for
 * the gated actions and decide whether a NON-ROOT session must be blocked.
 * R11-F1: scope resolves from `config.scope` only (canonical carrier — see
 * {@link resolveScopeParam}); top-level `scope` never influences the gate.
 * `update` is special: its effective write scope is the matched resource's
 * scope, unknown until `resolveMutable` — the facade blocks explicit
 * `scope:"user"` and management.ts gates the resolved case. `delete` mirrors
 * that split (facade pre-filter + handleDelete resolved-tier gate).
 * `cleanup` routes on TOP-LEVEL `params.scope` (lifecycle-actions.ts), and
 * `init` on config.configScope/config.scope (dispatch/manage.ts) — both
 * carriers are read here so the gate matches each handler exactly.
 *
 * @returns block reason string, or `undefined` to allow.
 */
export function rootGateBlockReason(params: RootGateParamsLike, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const action = typeof params.action === "string" ? params.action : undefined;
	if (!action) return undefined;
	const cfg = configRecord(params.config);
	const rawSub =
		(typeof params.subAction === "string" ? params.subAction : undefined) ??
		(typeof cfg.subAction === "string" ? cfg.subAction : undefined);
	const subcommand = typeof rawSub === "string" ? rawSub.toLowerCase() : undefined;
	// w5a: cleanup reads the TOP-LEVEL scope carrier (handleCleanup routes on
	// params.scope; config.scope is a carrier key it ignores) and init reads
	// config.configScope/config.scope (dispatch/manage.ts). Everything else
	// keeps the R11-F1 canonical config.scope resolver.
	const scope =
		action === "cleanup"
			? params.scope === "user"
				? "user"
				: "project"
			: action === "init"
				? resolveInitConfigScope(params)
				: resolveScopeParam(params, action);
	const force = params.force === true || cfg.force === true;

	// w5a (rootGateDryRunPreviewExemptsMutatingHandlers): dryRun carriers do
	// NOT exempt mutating actions here. handleStart (goal.ts) has NO dryRun
	// branch — it persists state and spawns the detached runner regardless —
	// and handleCreate (management.ts) honors only top-level params.dryRun, so
	// a config-carrier "preview" wrote the user tier for real. Previews of
	// mutating actions traverse the SAME matrix as execution (schedule
	// precedent); unrecognized carrier shapes therefore fail closed.

	// goal: gate `start` and any force:true op; status/pause/read-only stay open.
	if (action === "goal") {
		if (force) return assertRootOnlyAction("goal", "force", scope, env)?.message;
		// Gate `start` unconditionally (schedule precedent: previews of actions
		// without a dryRun contract are gated).
		if (subcommand === "start") return assertRootOnlyAction("goal", "start", scope, env)?.message;
		return undefined;
	}
	// schedule: every subAction path mutates (add is the default); previews of
	// create carry no dryRun contract in handle-schedule — gate all.
	if (action === "schedule") {
		return assertRootOnlyAction("schedule", subcommand, scope, env)?.message;
	}
	// config: gate only the WRITE path. Carrier keys (scope/unset/subAction/
	// dryRun/confirm/force/args) are dropped by the config schema
	// (configPatchFromConfig → parseConfig), so a payload of ONLY carrier keys
	// can never change the file — a read. Unknown junk keys stay
	// write-classified (fail-closed). `args` was missing from this list and
	// miscounted `config {args:"show"}` reads as writes (RT24-F1, live-caught
	// 2026-10-18). Note parseConfig injects defaults (runtime.*), so
	// patch-emptiness cannot be used here — see updateConfig skip-if-unchanged.
	if (action === "config") {
		const carrierKeys = new Set(["scope", "unset", "subAction", "dryRun", "confirm", "force", "args"]);
		const patchKeys = Object.keys(cfg).filter((k) => !carrierKeys.has(k) && cfg[k] !== undefined);
		const unset = Array.isArray(cfg.unset) ? cfg.unset.length > 0 : cfg.unset !== undefined;
		const isWrite = patchKeys.length > 0 || unset;
		if (!isWrite) return undefined;
	}
	// autonomy: gate only the WRITE path (patch keys present). Same carrier
	// reasoning as config — `args`/`subAction` are subcommand carriers, not
	// autonomous-config fields.
	if (action === "autonomy") {
		const carrierKeys = new Set(["subAction", "dryRun", "confirm", "args"]);
		const patchKeys = Object.keys(cfg).filter((k) => !carrierKeys.has(k) && cfg[k] !== undefined);
		if (patchKeys.length === 0) return undefined;
	}
	// settings: derive the subcommand from `config.args` ("set k v", "unset k",
	// "theme <name>", …). Non-mutating subcommands (list/get/json/scope/themes
	// browse) pass. The derived sub REPLACES the (undefined) subAction token.
	let effectiveSub = subcommand;
	if (action === "settings") {
		const args = typeof cfg.args === "string" ? cfg.args.trim() : "";
		const sub = args === "theme" || args.startsWith("theme ") ? "theme" : (args.split(/\s+/)[0] ?? "");
		if (sub !== "set" && sub !== "unset" && sub !== "theme") return undefined;
		effectiveSub = sub;
	}
	// goal force:true (top-level or config) is its own gated token.
	if (action === "goal" && force) effectiveSub = "force";
	// create/update/config/settings/autonomy below share scope gating.
	// create: NO preview exemption — handleCreate honors only top-level
	// params.dryRun (management.ts), so a config-carrier "preview" writes the
	// user tier for real (w5a).
	const reason = assertRootOnlyAction(action, effectiveSub, scope, env);
	return reason?.message;
}
