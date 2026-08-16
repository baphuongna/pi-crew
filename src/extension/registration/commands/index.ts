import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { printTimings, time } from "../../../utils/timings.ts";
import { registerDashboardCommands } from "./dashboard.ts";
import { registerManageCommands } from "./manage.ts";
import { registerRunCommands } from "./run.ts";
import type { RegisterTeamCommandsDeps } from "./shared.ts";
import { setTeamCommandsDeps } from "./shared.ts";
import { registerStatusCommands } from "./status.ts";

/**
 * Register every pi-crew slash command on the ExtensionAPI.
 *
 * Phase 2.1 split: the former monolith `src/extension/registration/commands.ts`
 * is now a re-export shim over this directory. Registration wiring lives here;
 * the command handlers live in run.ts / status.ts / manage.ts / dashboard.ts,
 * and cross-category module state + helpers (handleTeamTool, the UI cache,
 * the overlays) live in shared.ts.
 */
export function registerTeamCommands(pi: ExtensionAPI, deps: RegisterTeamCommandsDeps): void {
	setTeamCommandsDeps(deps);
	registerStatusCommands(pi, deps);
	registerRunCommands(pi, deps);
	registerManageCommands(pi, deps);
	registerDashboardCommands(pi, deps);
	time("register.commands");
	printTimings();
}

export type { RegisterTeamCommandsDeps } from "./shared.ts";
// Re-export the shared seam + overlay entry points (and the deps type) so the
// original `./commands.ts` path keeps resolving every named export consumers
// rely on: __test__setHandleTeamTool (commands-handler.test.ts),
// openTeamSettingsOverlay + openTeamDashboard (crew-shortcuts.ts LAZY dynamic
// imports), RegisterTeamCommandsDeps (type).
export { __test__setHandleTeamTool, openTeamDashboard, openTeamSettingsOverlay } from "./shared.ts";
