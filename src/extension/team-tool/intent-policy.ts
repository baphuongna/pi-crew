import type { PiTeamsConfig } from "../../config/config.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { configRecord, result } from "./context.ts";

export type DestructiveIntentAction = "cancel" | "cleanup" | "delete" | "forget" | "prune";

const DESTRUCTIVE_ACTION_LABELS: Record<DestructiveIntentAction, string> = {
	cancel: "cancel",
	cleanup: "forced cleanup",
	delete: "delete",
	forget: "forget",
	prune: "prune",
};

export function intentFromConfig(config: unknown): string | undefined {
	const cfg = configRecord(config);
	const rawIntent = cfg.intent ?? cfg._intent;
	if (typeof rawIntent !== "string") return undefined;
	const intent = rawIntent.replace(/\s+/g, " ").trim();
	return intent ? intent.slice(0, 500) : undefined;
}

export function shouldRequireIntent(config: PiTeamsConfig | undefined): boolean {
	return config?.policy?.requireIntentForDestructiveActions === true;
}

export function enforceDestructiveIntent(
	action: DestructiveIntentAction,
	params: TeamToolParamsValue,
	config: PiTeamsConfig | undefined,
): PiTeamsToolResult | undefined {
	if (!shouldRequireIntent(config)) return undefined;
	// DI-4: The cleanup bypass for non-forced cleanup is INTENTIONAL — do NOT
	// "fix" this into a regression. Non-forced cleanup (`cleanup` without
	// `force: true`) only removes STALE artifacts and preserves dirty worktrees
	// (see cleanupRunWorktrees: dirty worktrees are snapshotted + preserved
	// unless force=true, and project-level cleanup only removes the AGENTS.md
	// guidance block without touching `.crew/`). The destructive path (forced
	// cleanup) still requires intent. Requiring intent for the non-forced,
	// stale-only path would break routine maintenance flows (e.g. periodic
	// stale-artifact reaping) that must not need a per-call intent.
	if (action === "cleanup" && params.force !== true) return undefined;
	if (intentFromConfig(params.config)) return undefined;
	const label = DESTRUCTIVE_ACTION_LABELS[action];
	return result(
		`Destructive action '${label}' requires config.intent when policy.requireIntentForDestructiveActions is enabled.`,
		{
			action: action === "delete" ? "management" : action,
			status: "error",
		},
		true,
	);
}
