import type {
	ConfigValidationResult,
	PiTeamsConfig,
} from "./types.ts";

function projectOverrideWarning(projectPath: string, dottedPath: string): string {
	return `${projectPath}: project-level sensitive config '${dottedPath}' is ignored; set it in user config to trust it explicitly`;
}

export function sanitizeProjectConfig(projectPath: string, userConfig: PiTeamsConfig, config: PiTeamsConfig): ConfigValidationResult {
	const sanitized: PiTeamsConfig = { ...config };
	const warnings: string[] = [];
	const dropTopLevel = (key: keyof PiTeamsConfig): void => {
		if (config[key] === undefined) return;
		delete sanitized[key];
		warnings.push(projectOverrideWarning(projectPath, String(key)));
	};
	dropTopLevel("executeWorkers");
	dropTopLevel("asyncByDefault");
	dropTopLevel("requireCleanWorktreeLeader");
	if (config.runtime) {
		const runtime = { ...config.runtime };
		for (const key of [
			"mode",
			"preferLiveSession",
			"allowChildProcessFallback",
			"inheritContext",
			"isolationPolicy",
			"agentExtensions",
		] as const) {
			if (runtime[key] !== undefined) {
				delete runtime[key];
				warnings.push(projectOverrideWarning(projectPath, `runtime.${key}`));
			}
		}
		if (runtime.requirePlanApproval === false) {
			delete runtime.requirePlanApproval;
			warnings.push(projectOverrideWarning(projectPath, "runtime.requirePlanApproval"));
		}
		sanitized.runtime = Object.values(runtime).some((entry) => entry !== undefined) ? runtime : undefined;
	}
	if (config.autonomous) {
		const autonomous = { ...config.autonomous };
		for (const key of ["profile", "enabled", "injectPolicy", "preferAsyncForLongTasks", "allowWorktreeSuggestion"] as const) {
			if (autonomous[key] !== undefined) {
				delete autonomous[key];
				warnings.push(projectOverrideWarning(projectPath, `autonomous.${key}`));
			}
		}
		sanitized.autonomous = Object.values(autonomous).some((entry) => entry !== undefined) ? autonomous : undefined;
	}
	if (config.worktree?.setupHook !== undefined) {
		sanitized.worktree = { ...config.worktree, setupHook: undefined };
		if (!Object.values(sanitized.worktree).some((entry) => entry !== undefined)) sanitized.worktree = undefined;
		warnings.push(projectOverrideWarning(projectPath, "worktree.setupHook"));
	}
	if (config.otlp?.headers !== undefined) {
		sanitized.otlp = { ...config.otlp, headers: undefined };
		if (!Object.values(sanitized.otlp).some((entry) => entry !== undefined)) sanitized.otlp = undefined;
		warnings.push(projectOverrideWarning(projectPath, "otlp.headers"));
	}
	// FIX: Block project config from setting otlp.endpoint — it controls where
	// OTLP headers (potentially containing credentials) are sent.
	if (config.otlp?.endpoint !== undefined) {
		if (!sanitized.otlp) sanitized.otlp = { ...config.otlp, endpoint: undefined };
		else sanitized.otlp = { ...sanitized.otlp, endpoint: undefined };
		if (!Object.values(sanitized.otlp).some((entry) => entry !== undefined)) sanitized.otlp = undefined;
		warnings.push(projectOverrideWarning(projectPath, "otlp.endpoint"));
	}
	if (config.agents?.disableBuiltins !== undefined || config.agents?.overrides !== undefined) {
		const agents = { ...config.agents };
		if (agents.disableBuiltins !== undefined) {
			delete agents.disableBuiltins;
			warnings.push(projectOverrideWarning(projectPath, "agents.disableBuiltins"));
		}
		if (agents.overrides !== undefined) {
			delete agents.overrides;
			warnings.push(projectOverrideWarning(projectPath, "agents.overrides"));
		}
		sanitized.agents = Object.values(agents).some((entry) => entry !== undefined) ? agents : undefined;
	}
	if (config.tools?.enableSteer !== undefined || config.tools?.terminateOnForeground !== undefined) {
		const tools = { ...config.tools };
		if (tools.enableSteer !== undefined) {
			delete tools.enableSteer;
			warnings.push(projectOverrideWarning(projectPath, "tools.enableSteer"));
		}
		if (tools.terminateOnForeground !== undefined) {
			delete tools.terminateOnForeground;
			warnings.push(projectOverrideWarning(projectPath, "tools.terminateOnForeground"));
		}
		sanitized.tools = Object.values(tools).some((entry) => entry !== undefined) ? tools : undefined;
	}
	return { config: sanitized, warnings };
}

/** @internal — direct-test seam for Phase 2.2 extraction target (refactor-plan step 1.9c). */
export const __test__sanitizeProjectConfig = sanitizeProjectConfig;
