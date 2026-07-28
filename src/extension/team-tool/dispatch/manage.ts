/**
 * API-5 facade dispatch — Manage domain router.
 *
 * Actions: create, update, delete, init, config, validate, autonomy, settings,
 * workflow-create, workflow-get, workflow-list, workflow-save, workflow-delete,
 * import, imports, export.
 *
 * Inline cases (init, autonomy, config, validate) are moved verbatim from the
 * former handleTeamTool switch.
 */
import { loadConfig, updateAutonomousConfig, updateConfig } from "../../../config/config.ts";
import type { TeamToolParamsValue } from "../../../schema/team-tool-schema.ts";
import { formatActionSuggestion } from "../../action-suggestions.ts";
import { handleCreate, handleDelete, handleUpdate } from "../../management.ts";
import { initializeProject } from "../../project-init.ts";
import type { PiTeamsToolResult } from "../../tool-result.ts";
import { formatValidationReport, validateResources } from "../../validate-resources.ts";
import { autonomousPatchFromConfig, configPatchFromConfig, formatAutonomyStatus } from "../config-patch.ts";
import { configRecord, result, type TeamContext } from "../context.ts";
import { handleSettings } from "../handle-settings.ts";
import { handleExport, handleImport, handleImports } from "../lifecycle-actions.ts";
import {
	handleWorkflowCreate,
	handleWorkflowDelete,
	handleWorkflowGet,
	handleWorkflowList,
	handleWorkflowSave,
} from "../workflow-manage.ts";

export async function handleManageDomain(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	switch (params.action) {
		case "init": {
			const cfg = configRecord(params.config);
			const ignoreMethod =
				typeof cfg.ignoreMethod === "string" && (cfg.ignoreMethod === "gitignore" || cfg.ignoreMethod === "exclude")
					? cfg.ignoreMethod
					: undefined;
			const initialized = initializeProject(ctx.cwd, {
				copyBuiltins: cfg.copyBuiltins === true,
				overwrite: cfg.overwrite === true,
				configScope:
					cfg.configScope === "project" || cfg.scope === "project"
						? "project"
						: cfg.configScope === "none" || cfg.scope === "none"
							? "none"
							: "global",
				ignoreMethod,
			});
			return result(
				[
					"Initialized pi-crew project layout.",
					"Directories:",
					...(initialized.createdDirs.length ? initialized.createdDirs.map((dir) => `- created ${dir}`) : ["- already existed"]),
					"Copied builtin files:",
					...(initialized.copiedFiles.length ? initialized.copiedFiles.map((file) => `- ${file}`) : ["- (none)"]),
					...(initialized.skippedFiles.length
						? ["Skipped existing files:", ...initialized.skippedFiles.map((file) => `- ${file}`)]
						: []),
					`Config: ${initialized.configPath || "(none)"} (${initialized.configScope}${initialized.configCreated ? "; created" : initialized.configSkipped ? "; already existed" : "; unchanged"})`,
					`Ignore: ${initialized.gitignorePath} (${initialized.gitignoreUpdated ? "updated" : "already configured"})`,
				].join("\n"),
				{ action: "init", status: "ok" },
			);
		}
		case "autonomy": {
			const patch = autonomousPatchFromConfig(params.config);
			const shouldUpdate = Object.values(patch).some((value) => value !== undefined);
			if (!shouldUpdate) {
				const loaded = loadConfig(ctx.cwd);
				return result(
					formatAutonomyStatus(loaded.config.autonomous, loaded.path, false),
					{
						action: "autonomy",
						status: loaded.error ? "error" : "ok",
					},
					Boolean(loaded.error),
				);
			}
			try {
				const saved = updateAutonomousConfig(patch);
				return result(formatAutonomyStatus(saved.config.autonomous, saved.path, true), { action: "autonomy", status: "ok" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return result(message, { action: "autonomy", status: "error" }, true);
			}
		}
		case "config": {
			const patch = configPatchFromConfig(params.config);
			const cfg = configRecord(params.config);
			const unsetPaths = Array.isArray(cfg.unset)
				? cfg.unset.filter((entry): entry is string => typeof entry === "string")
				: typeof cfg.unset === "string"
					? [cfg.unset]
					: [];
			const shouldUpdate = Object.values(patch).some((value) => value !== undefined) || unsetPaths.length > 0;
			if (shouldUpdate) {
				try {
					const saved = updateConfig(patch, {
						cwd: ctx.cwd,
						scope: cfg.scope === "project" ? "project" : "user",
						unsetPaths,
					});
					return result(
						["Updated pi-crew config.", `Path: ${saved.path}`, "Effective config:", JSON.stringify(saved.config, null, 2)].join(
							"\n",
						),
						{ action: "config", status: "ok" },
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return result(message, { action: "config", status: "error" }, true);
				}
			}
			const loaded = loadConfig(ctx.cwd);
			const lines = [
				"pi-crew config:",
				`Path: ${loaded.path}`,
				`Status: ${loaded.error ? `error: ${loaded.error}` : "ok"}`,
				"Effective config:",
				JSON.stringify(loaded.config, null, 2),
				"Schema: package export ./schema.json",
			];
			return result(lines.join("\n"), { action: "config", status: loaded.error ? "error" : "ok" }, Boolean(loaded.error));
		}
		case "validate": {
			const report = validateResources(ctx.cwd);
			const hasErrors = report.issues.some((issue) => issue.level === "error");
			return result(formatValidationReport(report), { action: "validate", status: hasErrors ? "error" : "ok" }, hasErrors);
		}
		case "export":
			return handleExport(params, ctx);
		case "import":
			return handleImport(params, ctx);
		case "imports":
			return handleImports(params, ctx);
		case "settings":
			return handleSettings(params, ctx);
		case "create":
			return handleCreate(params, ctx);
		case "update":
			return handleUpdate(params, ctx);
		case "delete":
			return handleDelete(params, ctx);
		case "workflow-create":
			return handleWorkflowCreate(params, ctx);
		case "workflow-get":
			return handleWorkflowGet(params, ctx);
		case "workflow-list":
			return handleWorkflowList(params, ctx);
		case "workflow-save":
			return handleWorkflowSave(params, ctx);
		case "workflow-delete":
			return handleWorkflowDelete(params, ctx);
		default:
			return result(
				`Unhandled manage-domain action: ${params.action}${formatActionSuggestion(String(params.action ?? ""))}`,
				{ action: "unknown", status: "error" },
				true,
			);
	}
}
