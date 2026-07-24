# R1-D — awesome-persona tests (5 files, 23 invariants)

Swept submission-automation.test, check-repository-consistency.test, create-submission-pr-workflow.test, check-links.test, bun-migration.test. Tests reveal operational quality gates more honestly than docs.

## NEW MODEL — M-F7: structural invariants ARE the quality gate at index scale ★
At registry scale (200+ entries, bilingual), "quality" shifts from content-review to structure-enforcement — the invariants only CI can check ARE the gate.

**8 standout invariants** (impossible to verify by hand at scale):
- **I7 bilingual URL parity per category** — zh & en READMEs must list identical URL sets in each of 5 sections. (The strongest; only a machine enforces this at 200+ entries.)
- **I8 deterministic sort by repo-slug** — the only language-agnostic key (display names differ per language, can't sort by them).
- **I9 no duplicate URLs across all sections**.
- **I3 bilingual atomicity** — one submission = matched entry in BOTH languages; can't add to one only.
- **I6 terminal-punctuation auto-normalized** (silent style enforcement docs don't mention).
- **I11 governance-keyword embedding** — README itself must contain "approved" + "issue 表单" as proof-of-process (no doc states this rule).
- **I13 reverse-invariant regression guard** — merge workflow `doesNotMatch(getCombinedStatusForRef)` + polls `listForRef` 24× — locks in a REMOVED anti-pattern (GitHub combined-status API was tried & failed).
- **I23 docs-match-toolchain** — if CI runs bun, docs must say bun (doc↔code consistency).

## How M-F7 differs
- **M4** = engine's fidelity gate (content quality: triple-verification, scorecards).
- **M-F1** = pipeline architecture (engine→index→auto-curation).
- **M-F7** = what "quality" MEANS at the index layer: structural coherence (sorted, deduped, bilingual-parity, punctuation-normalized, governance-keyworded), NOT content. Necessary-not-sufficient (a coherent index can still hold bad distillations; complements M4/M-F4).

## Application (for building distillation registries)
1. Encode invariants as CI checks, not doc rules (docs aspirational, CI enforcement).
2. Language-agnostic identity/sort keys (repo slug).
3. Submissions atomic across all language variants.
4. `doesNotMatch` regression guards for known-failed approaches.
5. Embed governance-proof keywords in docs and test for their presence.
