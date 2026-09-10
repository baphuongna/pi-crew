#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.PI_TEAMS_HOME?.trim() || os.homedir();
const agentDir = path.join(home, ".pi", "agent");
const configPath = path.join(agentDir, "pi-crew.json");
const legacyConfigPath = path.join(agentDir, "extensions", "pi-crew", "config.json");

/**
 * Default config written to `~/.pi/agent/pi-crew.json` on fresh installs.
 *
 * WI-1b.2 (G17): this object is intentionally an embedded literal — install.mjs
 * runs under bare `node` as the `pi-crew` bin (engines floor is >=22.0.0; .ts
 * imports would require >=22.18 or `--experimental-strip-types`, which the npm
 * bin shim cannot pass). Runtime jiti/esbuild loading was rejected as a
 * postinstall failure surface; build-time codegen would need package.json /
 * prepack wiring. Instead, drift is enforced by
 * `test/unit/install-defaults-sync.test.ts`, which derives the source of truth
 * from `src/config/defaults.ts` (DEFAULT_UI) and
 * `src/config/config-validation.ts` (effectiveAutonomousConfig) and goes red
 * the moment this literal diverges (mutation-demo verified).
 *
 * Keys mirror the curated subset in `src/extension/project-init.ts`
 * (DEFAULT_PI_CREW_CONFIG) — deliberately non-invasive: runtime/limits use
 * pi-crew internal defaults and are not pinned here.
 */
export const defaultConfig = {
  autonomous: {
    enabled: true,
    injectPolicy: true,
    preferAsyncForLongTasks: false,
    allowWorktreeSuggestion: true
  },
  agents: {
    overrides: {
      explorer: { model: false, thinking: "off" },
      writer: { model: false, thinking: "off" },
      planner: { model: false, thinking: "medium" },
      analyst: { model: false, thinking: "off" },
      critic: { model: false, thinking: "low" },
      executor: { model: false, thinking: "medium" },
      reviewer: { model: false, thinking: "off" },
      "security-reviewer": { model: false, thinking: "medium" },
      "test-engineer": { model: false, thinking: "low" },
      verifier: { model: false, thinking: "off" }
    }
  },
  ui: {
    // G17 drift fix (2026-09): was "aboveEditor" while DEFAULT_UI.widgetPlacement
    // is "bottom" — fresh installs were pinning a stale default into user config.
    widgetPlacement: "bottom",
    widgetMaxLines: 8,
    powerbar: true,
    dashboardPlacement: "center",
    dashboardWidth: 72,
    dashboardLiveRefreshMs: 1000,
    autoOpenDashboard: false,
    autoOpenDashboardForForegroundRuns: false,
    showModel: true,
    showTokens: true,
    showTools: true
  }
};

/**
 * Postinstall / bin behavior: create the agent dir, migrate or write the
 * default global config, and print install + uninstall guidance.
 * Kept side-effect-for-side-effect identical to the pre-refactor top-level
 * script (WI-1b.2 refactor only moved it behind a main-guard).
 */
export function main() {
  fs.mkdirSync(agentDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(legacyConfigPath)) {
      fs.copyFileSync(legacyConfigPath, configPath);
      console.log(`Migrated pi-crew global config to: ${configPath}`);
    } else {
      fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf-8");
      console.log(`Created default pi-crew global config: ${configPath}`);
    }
  } else {
    console.log(`pi-crew global config already exists: ${configPath}`);
  }

  console.log("\nInstall the published package in Pi with:");
  console.log("  pi install npm:pi-crew");
  console.log("\nFor local development from a cloned repo:");
  console.log("  pi install .");
  console.log("\nChild workers are enabled by default. For dry runs, set runtime.mode=scaffold or executeWorkers=false.");
  console.log("To force-disable or force-enable workers in a shell, use PI_TEAMS_EXECUTE_WORKERS=0/1.");

  // Side-effects warning (Issue #35): be upfront about what pi-crew writes and
  // how to fully uninstall it. Nothing runs on install/registration itself; the
  // writes below only happen when you explicitly invoke `team action=init`.
  console.log("\n--- What pi-crew writes (and how to undo it) ---");
  console.log("pi-crew itself writes nothing on install. The following only happens when you");
  console.log("explicitly run `team action=init` in a project:");
  console.log("  - A `.crew/` runtime state dir is created in the project (run history + artifacts).");
  console.log("  - With --copy-builtins: bundled agents/teams/workflows are copied into the project.");
  console.log("This install also created the global config above (`~/.pi/agent/pi-crew.json`).");
  console.log("Note: pi-crew v0.8.14+ no longer injects a guidance block into AGENTS.md on init");
  console.log("      (it was redundant — the `team` tool self-describes via tool registration).");
  console.log("      Versions <0.8.14 did inject one; `team action=cleanup` removes it.");
  console.log("\nFull uninstall (in order):");
  console.log("  team action=cleanup dryRun=true       # preview what would be removed (project)");
  console.log("  team action=cleanup                    # remove the AGENTS.md guidance block");
  console.log("  team action=cleanup force=true         # also remove the .crew/ project state dir");
  console.log("  team action=cleanup scope=user         # remove pi-crew user-scope junk");
  console.log("                                          #   (~/.pi/agent/extensions/pi-crew/ + test .bak files)");
  console.log("  team action=cleanup scope=user force=true  # also remove ~/.pi/agent/pi-crew.json");
  console.log("  pi uninstall npm:pi-crew               # remove the package itself");
  console.log("See the README 'Uninstall' section for details.");
}

/**
 * Main-guard: run main() only when this file is executed directly
 * (`node install.mjs` or via the npm `pi-crew` bin shim), never when imported
 * as a module (e.g. by test/unit/install-defaults-sync.test.ts).
 * realpathSync both sides: import.meta.url is the realpath (Node resolves
 * symlinks by default), while argv[1] may be a symlinked bin path — e.g. the
 * dev-install layout where node_modules/pi-crew symlinks into a source clone.
 */
function invokedDirectly() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
