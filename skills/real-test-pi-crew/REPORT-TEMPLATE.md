# real-test-pi-crew — Run Report

<!--
TEMPLATE — copy this file to docs/real-test/reports/real-test-<YYYY-MM-DD>-<slug>.md
and fill it in DURING the run (not from memory afterward). Every tier gets a
row with concrete evidence (counts, md5, runIds, wall-clock). If a tier was
skipped or incomplete, say so explicitly — do NOT claim "pass" without evidence.
This artifact exists so past runs are verifiable (see SKILL.md "Output report").
-->

**Date**: YYYY-MM-DD
**Trigger**: <what prompted this real-test — e.g. "post subagent-model-routing merge 4148540e", "pre-release v0.9.X">
**Repo HEAD**: `<sha>`
**Bundle md5 (disk)**: `<md5>`
**Pi version**: <from `pi --version` or doctor>
**Run by**: <agent/user>

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅/❌/⏭️ | `<pass>/<tests>` pass, `<dur>` |
| 2 3-path kill-switch | ✅/❌/⏭️ | default + `PI_CREW_BROKER=0` + `=1` all `<n>/<n>` |
| 3 typecheck + bundle | ✅/❌/⏭️ | tsc exit 0; bundle `<KB>` KB, md5 `<md5>` |
| 4 bundle md5 sync | ✅/❌/⏭️ | disk = loaded = `<md5>` (or: user must restart) |
| 5 tmux TUI probe | ✅/❌/⏭️ | `<which slash command reached the screen>` |
| 6 pty probe | ✅/❌/⏭️ | `<keys reached handleInput / diag lines>` |
| 7 smoke team run | ✅/❌/⏭️ | runId `<id>`, `<n>/<n>` tasks, verifier `<dur>` (<300s) |
| 8 final md5 sync | ✅/❌/⏭️ | disk = session = `<md5>` |
| 9a read-only battery | ✅/❌/⏭️ | list/recommend/health/doctor/status/events/summary/get/explain/worktrees — `<n>/10` |
| 9b spawn paths | ✅/❌/⏭️ | sync / async / chain / Agent / crew_agent — `<n>/5` |
| 9c lifecycle | ✅/❌/⏭️ | status-details/cache/checkpoint/steer/retry/resume + live cancel — which ran |
| 9d destructive | ✅/❌/⏭️ | forget/cleanup/prune — which ran (note data-protection skips) |
| 9e admin | ✅/❌/⏭️ | team/workflow CRUD round-trip |
| 9f background | ✅/❌/⏭️ | auto-summarize/anchor/schedule register+remove |

Legend: ✅ pass with evidence · ❌ fail (root cause below) · ⏭️ skipped (justify why)

## Findings (bugs / quirks / non-blocking notes)
- <finding 1 — file:line, severity, issue link if filed>
- <finding 2>

## What was NOT run + why
- <e.g. "prune — protects user run data; handler proven via forget">
- <e.g. "live mid-run steer race — async tool call blocks; live cancel implicitly verified via …">

## Restart needed?
- [ ] No — session already on the new bundle
- [ ] Yes — user must `/quit` + reopen; md5 before/after: `<old>` → `<new>`

## Verdict
<one line: e.g. "All required tiers pass; feature safe to ship. Issue #NN tracks <quirk>.">
