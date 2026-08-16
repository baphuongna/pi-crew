/**
 * Re-export shim (Phase 2.1 — commands.ts god-file decomposition).
 *
 * The command registration logic moved to `src/extension/registration/commands/`
 * (index.ts wiring + run.ts / status.ts / manage.ts / dashboard.ts handlers +
 * shared.ts cross-category helpers). This file stays as the public entry path so
 * existing import sites keep resolving without changes:
 *
 *   • `registerTeamCommands`           — command-registration.ts:15 (static),
 *                                        commands-handler.test.ts:30,
 *                                        registration-commands-coverage.test.ts:3
 *   • `__test__setHandleTeamTool`      — commands-handler.test.ts:30 (STEP 1.9a seam)
 *   • `openTeamSettingsOverlay`        — crew-shortcuts.ts:54 (LAZY dynamic import)
 *   • `openTeamDashboard`              — crew-shortcuts.ts:65 (LAZY dynamic import)
 *   • `RegisterTeamCommandsDeps` (type)
 */
export * from "./commands/index.ts";
