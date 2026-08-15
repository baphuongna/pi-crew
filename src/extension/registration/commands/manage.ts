import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../../state/atomic-write.ts";
import { getBuiltinTemplates, instantiateTemplate, listTemplates } from "../../../skills/skill-templates.ts";
import { suggestRunIds } from "../../command-completions.ts";
import { handleTeamManagerCommand } from "../../team-manager-command.ts";
import { commandText, notifyCommandResult, parseScalar, pushUnset, setNestedConfig } from "../command-utils.ts";
import { handleTeamTool, openTeamSettingsOverlay, teamCommandContext } from "./shared.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";

export function registerManageCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {

	pi.registerCommand("team-prune", {
		description: "Prune old finished pi-crew runs, keeping the newest N",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const keepToken = tokens.find((token) => token.startsWith("--keep="));
			const keep = keepToken ? Number.parseInt(keepToken.slice("--keep=".length), 10) : undefined;
			const result = await handleTeamTool(
				{
					action: "prune",
					keep,
					confirm: tokens.includes("--confirm"),
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-forget", {
		description: "Forget a pi-crew run by deleting its state and artifacts",
		getArgumentCompletions: (argumentPrefix: string) => suggestRunIds(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const runId = tokens.find((token) => !token.startsWith("--"));
			const result = await handleTeamTool(
				{
					action: "forget",
					runId,
					force: tokens.includes("--force"),
					confirm: tokens.includes("--confirm"),
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-settings", {
		description: "View or update pi-crew settings: interactive UI or [list|get <key>|set <key> <value>|unset <key>|path|scope]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (ctx.hasUI && !args.trim()) {
				await openTeamSettingsOverlay(ctx);
				return;
			}
			const result = await handleTeamTool({ action: "settings", config: { args: args.trim() } }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
			// Live-switch hook: when the text subcommand 'theme <name>' succeeds,
			// also apply the theme live via ctx.ui.setTheme() (no restart). The
			// handler above only writes to settings.json.
			const trimmed = args.trim();
			if (trimmed.startsWith("theme ")) {
				const themeName = trimmed.slice(6).trim();
				if (themeName && typeof ctx.ui.setTheme === "function") {
					const res = ctx.ui.setTheme(themeName);
					if (res.success) ctx.ui.notify(`Theme: ${themeName} (applied live)`, "info");
					else ctx.ui.notify(`Saved but live-switch failed: ${res.error ?? "unknown"}. Restart Pi.`, "warning");
				}
			}
		},
	});

	pi.registerCommand("team-manager", {
		description: "Open the pi-crew interactive menu (list/run/status/cleanup/manage resources/doctor)",
		handler: handleTeamManagerCommand,
	});
	// Backward-compat alias: this command was originally registered as "team-cleanup"
	// (the interactive menu predates the runId-targeted cleanup action). Keep both so

	pi.registerCommand("team-cleanup-menu", {
		description: "Alias for /team-manager (pi-crew interactive menu)",
		handler: handleTeamManagerCommand,
	});

	pi.registerCommand("team-init", {
		description: "Initialize pi-crew layout and global config. Use --project-config to write .pi/pi-crew.json.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const configScope =
				tokens.includes("--project-config") || tokens.includes("--project")
					? "project"
					: tokens.includes("--no-config")
						? "none"
						: "global";
			const result = await handleTeamTool(
				{
					action: "init",
					config: {
						copyBuiltins: tokens.includes("--copy-builtins"),
						overwrite: tokens.includes("--overwrite"),
						configScope,
					},
				},
				teamCommandContext(ctx),
			);
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-autonomy", {
		description: "Show or toggle pi-crew autonomous delegation policy: status|on|off",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const mode = tokens[0]?.toLowerCase();
			const config =
				mode === "on"
					? {
							profile: "suggested",
							enabled: true,
							injectPolicy: true,
						}
					: mode === "off"
						? { profile: "manual", enabled: false }
						: mode === "manual" || mode === "suggested" || mode === "assisted" || mode === "aggressive"
							? {
									profile: mode,
									enabled: mode !== "manual",
									injectPolicy: mode !== "manual",
								}
							: {
									preferAsyncForLongTasks: tokens.includes("--prefer-async") ? true : undefined,
									allowWorktreeSuggestion: tokens.includes("--no-worktree-suggest") ? false : undefined,
								};
			const result = await handleTeamTool({ action: "autonomy", config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("team-config", {
		description: "Show or update pi-crew config. Use key=value [--project] to update.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				const result = await handleTeamTool({ action: "config" }, teamCommandContext(ctx));
				await notifyCommandResult(ctx, commandText(result));
				return;
			}
			const config: Record<string, unknown> = {
				scope: tokens.includes("--project") ? "project" : "user",
			};
			for (const token of tokens) {
				if (token.startsWith("--unset=")) {
					pushUnset(config, token.slice("--unset=".length));
					continue;
				}
				if (!token.includes("=")) continue;
				const [key, ...rest] = token.split("=");
				if (!key) continue;
				const raw = rest.join("=");
				if (raw === "unset" || raw === "null") pushUnset(config, key);
				else setNestedConfig(config, key, parseScalar(raw));
			}
			const result = await handleTeamTool({ action: "config", config }, teamCommandContext(ctx));
			await notifyCommandResult(ctx, commandText(result));
		},
	});

	pi.registerCommand("skill-list", {
		description: "List available builtin skill templates. Use --json for machine-readable output.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const asJson = args.trim().split(/\s+/).includes("--json");
			const templates = listTemplates();
			if (asJson) {
				await notifyCommandResult(ctx, JSON.stringify(templates, null, 2));
			} else {
				const lines = ["Available builtin skill templates:", ""];
				for (const t of templates) {
					lines.push(`  ${t.id.padEnd(20)} ${t.description}`);
					lines.push(
						`    Variables: ${t.variables.map((v) => (v.required ? "[required] " : "[optional] ") + v.name).join(", ")}`,
					);
				}
				lines.push("");
				lines.push("Create a skill: /skill-create <template-id> --var key=value [--var ...]");
				await notifyCommandResult(ctx, lines.join("\n"));
			}
		},
	});

	pi.registerCommand("skill-create", {
		description: "Create a skill from a builtin template: <template-id> [--var key=value...] [--project]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// LAZY: load withSessionId only when needed for skill-create command
			const { withSessionId } = await import("../../team-tool/context.ts");
			const sessionId = withSessionId(ctx);
			const cwd =
				(
					ctx as unknown as {
						workspaceFolder?: { uri: { fsPath: string } };
					}
				).workspaceFolder?.uri?.fsPath ?? process.cwd();
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const useProject = tokens.includes("--project");
			const varEntries = tokens
				.filter((t) => t.startsWith("--var=") || t.startsWith("--var "))
				.map((t): [string, string] => {
					const s = t.replace(/^--var(?:\s+|=)/, "");
					const idx = s.indexOf("=");
					return idx === -1 ? [s, ""] : [s.slice(0, idx), s.slice(idx + 1)];
				});
			const templateId = tokens.find((t) => !t.startsWith("--") && !t.includes("="));
			if (!templateId) {
				await notifyCommandResult(
					ctx,
					"Usage: /skill-create <template-id> [--var key=value...] [--project]\nRun /skill-list to see available templates.",
				);
				return;
			}
			const template = getBuiltinTemplates().find((t) => t.id === templateId);
			if (!template) {
				await notifyCommandResult(ctx, `Unknown template '${templateId}'. Run /skill-list to see available templates.`);
				return;
			}
			const variables: Record<string, string> = {};
			const errors: string[] = [];
			for (const v of template.variables) {
				const entry = varEntries.find(([k]) => k === v.name);
				if (!entry) {
					if (v.required) errors.push(`Missing required variable: ${v.name} (${v.description})`);
					else if (v.defaultValue !== undefined) variables[v.name] = v.defaultValue;
					continue;
				}
				const [, value] = entry;
				if (v.options && !v.options.includes(value)) {
					errors.push(`Invalid value '${value}' for '${v.name}'. Allowed: ${v.options.join(", ")}`);
					continue;
				}
				variables[v.name] = value;
			}
			if (errors.length > 0) {
				await notifyCommandResult(ctx, errors.join("\n"));
				return;
			}
			let instantiated: { filename: string; content: string };
			try {
				instantiated = instantiateTemplate(template, variables);
			} catch (error) {
				await notifyCommandResult(ctx, error instanceof Error ? error.message : String(error));
				return;
			}
			const skillsDir = path.resolve(
				cwd,
				useProject
					? "skills"
					: path.join(
							path.dirname(
								require.resolve("../../../../package.json", {
									paths: [__dirname],
								}),
							),
							"skills",
						),
			);
			const skillDir = path.join(skillsDir, template.id);
			const skillPath = path.join(skillDir, "SKILL.md");
			try {
				fs.mkdirSync(skillDir, { recursive: true });
				atomicWriteFile(skillPath, instantiated.content);
				await notifyCommandResult(
					ctx,
					`Created skill '${template.id}' at:\n${skillPath}\n\n${instantiated.content.slice(0, 200)}...`,
				);
			} catch (error) {
				await notifyCommandResult(ctx, `Failed to write skill: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerCommand("crew-brief", {
		description: "Toggle brief tool output mode: on | off | status",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// LAZY: defer dynamic import of ../../ui/tool-renderers/brief-mode.ts to its call site. Multi-line form breaks scripts/check-lazy-imports.mjs (which does `lines[lineNum - 2]`), so keep destructuring + await import on one line and place this LAZY marker directly above.
			const { isBrief, setBrief, BRIEF_ENTRY_TYPE, makeBriefEntry } = await import("../../../ui/tool-renderers/brief-mode.ts");
			const trimmed = args.trim();

			if (trimmed === "on") {
				setBrief(true);
				pi.appendEntry(BRIEF_ENTRY_TYPE, { enabled: true });
				ctx.ui.notify("Brief mode: on — tool output will show compact summaries", "info");
				return;
			}
			if (trimmed === "off") {
				setBrief(false);
				pi.appendEntry(BRIEF_ENTRY_TYPE, { enabled: false });
				ctx.ui.notify("Brief mode: off — full tool output restored", "info");
				return;
			}
			// status (default)
			ctx.ui.notify(`Brief mode: ${isBrief() ? "on" : "off"}`, "info");
		},
	});
}
