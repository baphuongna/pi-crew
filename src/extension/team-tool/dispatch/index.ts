/**
 * API-5 facade dispatch — domain router registry.
 *
 * `domainForAction(action)` maps each of the 54 action strings to one of 5
 * domains. `handleTeamTool` (in team-tool.ts) calls this to pick the right
 * domain router, preserving the exact same public API and zero caller changes.
 *
 * 54→5 mapping:
 *   run     (9):  run, parallel, plan, orchestrate, resume, retry, wait, steer, goal
 *   status  (16): status, list, get, events, artifacts, summary, graph, search,
 *                 health, worktrees, checkpoint, cache, explain, onboard, recommend, help
 *   control (7):  cancel, invalidate, respond, cleanup, prune, forget, doctor
 *   manage  (16): create, update, delete, init, config, validate, autonomy, settings,
 *                 workflow-create/get/list/save/delete, import, imports, export
 *   automate(6):  schedule, scheduled, anchor, auto-summarize, auto_boomerang, api
 */
import type { TeamDomain } from "../../../schema/team-tool-schema.ts";
import { handleAutomateDomain } from "./automate.ts";
import { handleControlDomain } from "./control.ts";
import { handleManageDomain } from "./manage.ts";
import { handleRunDomain } from "./run.ts";
import { handleStatusDomain } from "./status.ts";

export { handleAutomateDomain, handleControlDomain, handleManageDomain, handleRunDomain, handleStatusDomain };

const ACTION_TO_DOMAIN: Record<string, TeamDomain> = {
	// run domain (9)
	run: "run",
	parallel: "run",
	plan: "run",
	orchestrate: "run",
	resume: "run",
	retry: "run",
	wait: "run",
	steer: "run",
	goal: "run",

	// status domain (16)
	status: "status",
	list: "status",
	get: "status",
	events: "status",
	artifacts: "status",
	summary: "status",
	graph: "status",
	search: "status",
	health: "status",
	worktrees: "status",
	checkpoint: "status",
	cache: "status",
	explain: "status",
	onboard: "status",
	recommend: "status",
	help: "status",

	// control domain (7)
	cancel: "control",
	invalidate: "control",
	respond: "control",
	cleanup: "control",
	prune: "control",
	forget: "control",
	doctor: "control",

	// manage domain (16)
	create: "manage",
	update: "manage",
	"delete": "manage",
	init: "manage",
	config: "manage",
	validate: "manage",
	autonomy: "manage",
	settings: "manage",
	"workflow-create": "manage",
	"workflow-get": "manage",
	"workflow-list": "manage",
	"workflow-save": "manage",
	"workflow-delete": "manage",
	import: "manage",
	imports: "manage",
	export: "manage",

	// automate domain (6)
	schedule: "automate",
	scheduled: "automate",
	anchor: "automate",
	"auto-summarize": "automate",
	auto_boomerang: "automate",
	api: "automate",
};

/** Map an action string to its domain. Returns undefined for unknown actions. */
export function domainForAction(action: string): TeamDomain | undefined {
	return ACTION_TO_DOMAIN[action];
}
