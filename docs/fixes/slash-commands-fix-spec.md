# Slash-commands fix spec (2026-09-17)

Source: read-only slash-command audit (43 commands, 4 registration paths).
Verdict baseline: ✅ 28 / ⚠️ 15 / ❌ 0. This spec fixes every ⚠️ that is a real
defect; design-level items are explicitly out of scope.

## Work items

| # | Item | Files (owner) | AC |
|---|---|---|---|
| W1 | `/team-respond` usage guard | `commands/run.ts` (E1) | Missing any of `<runId> <taskId\|--all> <message>` → notify `Usage: /team-respond <runId> <taskId|--all> <message>`, return before `handleTeamTool` (mirror `team-follow-up` pattern at run.ts:128-135). Empty-args call to `handleTeamTool({action:"respond"})` no longer happens from the command layer. |
| W2 | `/team-goal` metadata honest | `commands/run.ts` (E1) | `description` mentions the real sub-actions (`cancel`, `reset`); arg completion suggests them for arg 1. Behavior unchanged. |
| W3 | `/team-metrics` empty-hint | `commands/status.ts` (E2) | When the metrics output is empty, append a hint naming the likely cause (observability disabled) and the enable path (frontmatter `observability: true`). Non-empty output unchanged. |
| W4 | `/team-dashboard` headless feedback | `commands/dashboard.ts` (E2) | Headless invocation notifies (info) that the dashboard overlay needs a UI session instead of returning silently. `/team-mascot` stays a silent no-op (cosmetic, documented as such in its description). |
| W5 | Truncation marker + file pointer | `command-utils.ts` + `commands/status.ts` (E2) | `notifyCommandResult` appends `\n… [truncated]` whenever it clips (also under the existing `...`). `/team-events` output ends with the on-disk events log path when truncated, so the full log is reachable. Cap value stays 800. |
| W6 | `/skill-create` ESM-safe resolution | `commands/manage.ts` (E3) | Replace `require.resolve` + `__dirname` with `import.meta.url`-based resolution that works under strip-types AND the committed bundle. Unknown/missing template id → usage error listing available template ids. No behavior change for valid ids. |
| W7 | `/team-help` sync | `commands/help.ts` (E3) | Help text covers all 39 `team-*` commands registered by `registerTeamCommands` plus a one-line pointer to the 4 non-team commands (`/schedules`, `/crew-view`, `/crew-back`, `/team-vibes`, `/crew-brief`). No stale entries. |
| W8 | commands-reference.md truth sync | `docs/commands-reference.md` (E3) | Remove phantom `/team-cleanup`; fix `/team-respond` args, `/team-follow-up` description, `/team-invalidate` args; drop `speed`/`capacity` from `/team-vibes`; add the 4 missing commands. Locked by a new parity test (W9). |
| W9 | Docs↔code parity lock | new test (E3) | Test parses `docs/commands-reference.md` command column and asserts set-equality vs the registered command set (source of truth: the same enumeration the existing coverage test pins). Phantom or missing docs entries fail CI. |
| W10 | Handler tests for untested commands | new tests (E1/E2/E3) | E1: `team-respond` guard test. E2: metrics hint, dashboard headless notify, truncation marker tests. E3: `team-vibes` (on/off/status/bad-subcommand → usage error; `speed`/`capacity` rejected) + `skill-create` guard test. |

## Out of scope (recorded, not fixed here)

- Long-output viewer overlay for `team-events` / `team-api read-*` (design work; W5's pointer is the mitigation).
- Implementing `/team-vibes speed/capacity` (docs corrected instead; feature request if wanted).
- Removing `/team-cleanup-menu` alias (back-compat).
- Raising the 800-char cap.
- `/team-manager` 1000-char cap unification (marker from W5 covers it).

## Gates

`tsc --noEmit` · biome lint + format:check · new tests + existing registration
command tests · `test:critical` · full suite · bundle rebuild (committed dist
must match src). CHANGELOG `[Unreleased]` updated by the lead.

## Ownership (disjoint, no cross-edits)

- E1: `commands/run.ts`, new `team-respond-guard.test.ts`, `team-goal-metadata.test.ts`
- E2: `commands/status.ts`, `commands/dashboard.ts`, `command-utils.ts`, new `command-output-hints.test.ts`
- E3: `commands/manage.ts`, `commands/help.ts`, `docs/commands-reference.md`, new `skill-create-esm.test.ts`, `crew-vibes/team-vibes-command.test.ts`, `docs/commands-reference-parity.test.ts`
- Lead (not executors): spec, CHANGELOG, package/dist/bundle, final gates, commit.
