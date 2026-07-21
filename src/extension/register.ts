/**
 * pi-crew extension entry point.
 *
 * Single import surface Pi calls during extension load: `registerPiTeams(pi)`.
 * Delegates to focused modules under `./registration/`:
 *   • registration-types        — shared RegistrationContext
 *   • context-builder           — buildRegistrationContext (state init)
 *   • subagent-manager-setup    — SubagentManager + callbacks
 *   • foreground-run-controller — start/abort/openLiveSidebar
 *   • runtime-cleanup           — cleanupRuntime + cleanupSwitch
 *   • lazy-configurers          — notifications/observability/delivery
 *   • lifecycle-handlers        — session_start/shutdown/before_switch
 *   • hook-registration         — tool_call/tool_result/resources_discover
 *   • tool-registration         — registerTeamTool + registerSubagentTools
 *   • command-registration      — registerTeamCommands
 *   • crash-recovery-cache      — lazy importCrashRecovery
 *   • wire-cross-extension      — RPC handle + global registry install
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.ts";
import { primePeerDep } from "../runtime/peer-dep.ts";
import { startRuntimeWarmup } from "../runtime/runtime-warmup.ts";
import { deployBundledThemes } from "../ui/deploy-bundled-themes.ts";
import { resetTimings, time } from "../utils/timings.ts";
import { registerAutonomousPolicy } from "./autonomous-policy.ts";
import { registerContextStatusInjection } from "./context-status-injection.ts";
import { registerCleanupHandler } from "./crew-cleanup.ts";
import { registerCrewInputRouter } from "./crew-input-router.ts";
import { registerCrewShortcuts } from "./crew-shortcuts.ts";
import { registerCrewVibes } from "./crew-vibes/index.ts";
import { registerKnowledgeInjection } from "./knowledge-injection.ts";
import { registerCrewMessageRenderers } from "./message-renderers.ts";
import { registerPiCommands } from "./registration/command-registration.ts";
import { buildRegistrationContext } from "./registration/context-builder.ts";
import { importCrashRecovery, purgeStaleActiveRunIndexSyncIfLoaded } from "./registration/crash-recovery-cache.ts";
import { installForegroundRunController } from "./registration/foreground-run-controller.ts";
import { installPiHooks } from "./registration/hook-registration.ts";
import { installLazyConfigurers } from "./registration/lazy-configurers.ts";
import { installCrewBrokerLifecycleController, installSessionLifecycleHandlers } from "./registration/lifecycle-handlers.ts";
import { installRuntimeCleanup } from "./registration/runtime-cleanup.ts";
import { __test__subagentSpawnParams } from "./registration/subagent-helpers.ts";
import { installSubagentManager } from "./registration/subagent-manager-setup.ts";
import { registerPiTools } from "./registration/tool-registration.ts";
import { installCrossExtensionWiring } from "./registration/wire-cross-extension.ts";

export { __test__subagentSpawnParams };

/**
 * Pi extension entry point. See module-level docstring for the full pipeline.
 */
export function registerPiTeams(pi: ExtensionAPI): void {
	resetTimings();
	time("register:start");

	startRuntimeWarmup();
	primePeerDep().catch(() => {});
	deployBundledThemes();

	const ctx = buildRegistrationContext(pi);
	ctx.importCrashRecovery = importCrashRecovery;
	ctx.purgeStaleActiveRunIndexSyncIfLoaded = purgeStaleActiveRunIndexSyncIfLoaded;
	installRuntimeCleanup(pi, ctx);
	installForegroundRunController(pi, ctx);
	installSubagentManager(pi, ctx);
	installLazyConfigurers(pi, ctx);
	installCrossExtensionWiring(pi, ctx);

	time("register.policy");
	registerAutonomousPolicy(pi);
	registerKnowledgeInjection(pi);

	registerPiTools(pi, ctx);
	registerPiCommands(pi, ctx);
	installPiHooks(pi, ctx);
	installSessionLifecycleHandlers(pi, ctx);
	// Phase 0 inter-pi broker: install the lifecycle controller immediately
	// after the session handlers. The controller's gate (broker.enabled AND
	// root-session only) decides whether anything is actually done; for
	// subagents or when the flag is off, it returns a no-op controller.
	ctx.brokerController = installCrewBrokerLifecycleController(pi, ctx);

	registerCleanupHandler(pi);
	registerCompactionGuard(pi, {
		foregroundControllers: ctx.foregroundControllers,
		foregroundTeamRunControllers: ctx.foregroundTeamRunControllers,
	});

	if (process.env.CREW_RESILIENT_EDIT === "1") {
		// LAZY: resilient-edit only loads when the opt-in env var is set.
		import("../runtime/resilient-edit.ts")
			.then(({ wrapEditWithResilientReplace }) => wrapEditWithResilientReplace(pi))
			.catch(() => {
				/* non-critical */
			});
	}

	registerCrewMessageRenderers(pi);
	registerCrewInputRouter(pi);
	registerCrewShortcuts(pi);
	registerContextStatusInjection(pi, {
		enabled: loadConfig(process.cwd()).config.reliability?.ambientStatusInjection !== false,
	});

	try {
		registerCrewVibes(pi);
	} catch (err) {
		console.warn("[pi-crew] crew-vibes initialization failed:", err instanceof Error ? err.message : err);
	}
}

// Bottom-of-file import: keeps compaction-guard out of the top-level
// import surface to avoid pulling its heavy transitive deps.
import { registerCompactionGuard } from "./registration/compaction-guard.ts";
