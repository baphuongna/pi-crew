# Archived Documents

This directory contains historical one-off reports and reviews that were
moved out of the main `docs/` directory as part of the **L3 (docs sprawl
cleanup)** in the v0.9.17 cleanup plan.

**Criterion (per plan §11 L3 circle-back):** "exclude any file referenced by
AGENTS.md or README." Each file here has been verified to have NO source-of-
truth reference in the project — these are point-in-time audits, reviews,
test-round logs, and followup reports that were used once and superseded.

## What is archived (22 files)

### v0.5.x audit-fix plans (9 files)
Spans the v0.5.5 → v0.5.17 release cycle of bug audits. Each was a point-in-time
list of fixes for that release; all fixes were shipped and the audit is now
historical.

- `pi-crew-v0.5.5-audit-fix-plan.md`
- `pi-crew-v0.5.9-audit-fix-plan.md`
- `pi-crew-v0.5.10-audit-fix-plan.md`
- `pi-crew-v0.5.11-audit-fix-plan.md`
- `pi-crew-v0.5.12-audit-fix-plan.md`
- `pi-crew-v0.5.13-audit-fix-plan.md`
- `pi-crew-v0.5.14-audit-fix-plan.md`
- `pi-crew-v0.5.16-audit-fix-plan.md`
- `pi-crew-v0.5.17-audit-fix-plan.md`

### Round-series test logs (6 files)
The iterative test result logs from `pi-crew-test-roundN` rounds. v0.9.17 has
a new test matrix (`docs/TEST_MATRIX.md`) which supersedes these.

- `pi-crew-test-final.md`
- `pi-crew-test-results.md`
- `pi-crew-test-round2.md`
- `pi-crew-test-round4.md`
- `pi-crew-test-round5.md`
- `pi-crew-test-round6.md`

### Review-round followups (2 files)
Sequential review rounds from May 2026.

- `followup-review-round3-2026-05-12.md`
- `followup-review-round4-2026-05-13.md`

### Single-investigation reports (5 files)
One-off reports retained for historical reference only.

- `pi-crew-bugs.md` — early-stage bug inventory (May 2026)
- `pi-mono-opportunities.md` — cross-project opportunity scan
- `pi-mono-review.md` — cross-project review
- `pi-subagent4-comparison.md` — subagent-4 comparison
- `pi-subagents3-deep-analysis.md` — subagents-3 deep analysis

## How to recover a file

Files in this directory are still tracked by git (history preserved). To
restore:

```bash
git mv docs/archive/FILE.md docs/
# edit docs/README.md or other references if needed
git commit -m "docs: restore FILE.md from archive"
```

## Why these were archived

`docs/` had grown to ~77 markdown files. Many were one-off reports created
during specific development cycles that:

- had no source-of-truth reference (not linked from README, AGENTS.md, or
  any code file's header comment),
- were superseded by current docs (e.g. `TEST_MATRIX.md`),
- were point-in-time audits that produced code changes already shipped.

This directory keeps them available for git-history archaeology without
cluttering the active docs surface.

## What is NOT archived (still in `docs/`)

- `architecture.md`, `actions-reference.md`, `commands-reference.md`,
  `dynamic-workflows.md` — referenced from `README.md`
- `decisions/` (ADR-style 0001-0008) — referenced from `AGENTS.md`
- `FEATURE_INTAKE.md`, `HARNESS.md`, `HARNESS_BACKLOG.md`, `TEST_MATRIX.md`,
  `troubleshooting.md`, `usage.md`, `goals.md`, `live-mailbox-runtime.md`,
  `runtime-flow.md`, `resource-formats.md`, `publishing.md`,
  `migration-v0.4-v0.5.md` — active project docs
- `bugs/`, `fixes/`, `distillation/`, `product/`, `stories/`, `skills/`,
  `templates/`, `superpowers/`, `perf/`, `patterns/` — themed subdirs
- `next-upgrade-roadmap.md` — referenced from `README.md`
- `REVIEW-FINDINGS-2026-06` (file) — current cleanup plan reference
