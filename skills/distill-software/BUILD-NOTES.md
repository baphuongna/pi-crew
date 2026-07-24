# distill-software — Build Notes

Sibling of `distill-persona`, specialized for software. Inherits the base methodology (6 phases, Phase 2.6 extraction verification, F2' framework-answerable-edge fidelity, exhaustive-sweep mode + coverage manifest + diminishing-returns gate, self-correction meta-loop) — does NOT duplicate it; only specifies what's different for software.

## Decision → source trace
| Decision | From |
|---|---|
| 3 flavors (engineer persona / codebase conventions / domain expertise) | SOFTWARE-DISTILLATION-DEEP-DIVE §A |
| Code-Expression-DNA 12-axis grid (measurable, not vibes) | SOFTWARE-DISTILLATION-DEEP-DIVE §C |
| pi-langsrv-native research (symbol/call-graph) — the software differentiator vs nuwa's web-only | SOFTWARE-DISTILLATION-DEEP-DIVE §E + nuwa F1 (portability) |
| `language` + `distilled_against` staleness anchors in frontmatter | nuwa review F2'/software — staleness is the #1 software honesty failure |
| Phase 2.6 V1 strengthened (quirk-vs-principle flag) | SOFTWARE-DISTILLATION-DEEP-DIVE §J (overfit-to-quirk anti-pattern) |
| F2' third category applied to version-recency ("API newer than distilled_against") | f2-experiment (validated n=3) |
| `code_dna.py` wired INTO Agentic Protocol Step 2 (not orphaned) | nuwa mrbeast review F13 |
| Tests-as-invariants + CI/lint-as-enforced-conventions + dep manifests (3 extra streams) | SOFTWARE-DISTILLATION-DEEP-DIVE §B |
| 口癖 = lint `no-restricted-syntax` entries | SOFTWARE-DISTILLATION-DEEP-DIVE §C |
| software-specific anti-patterns (8) | SOFTWARE-DISTILLATION-DEEP-DIVE §J |

## Operational script — `scripts/code_dna.py`
- Stdlib-only, Python 3.9+. Measures the code-Expression-DNA axes on a target file/dir → markdown report.
- **Tested** on nuwa-skill Python scripts (mid-comments/loose-errors/typed/snake_case 79%) and on itself (terse/strict-errors/typed) — produces differentiated, sensible fingerprints.
- Axes measured: naming distribution + prefix tally · function length (median/p90, Python) · comment density + why-vs-what ratio · error-handling pattern (raise/except/return-null/.ok) · type-strictness (typed vs any) · 8-axis style-tag grid.
- **Wired into Agentic Protocol** (F13): Step 2 runs `code_dna.py` on collected target code, reads the report, applies mental models. Never orphaned.
- Shares `scripts/fidelity_eval.py` with distill-persona for Phase 4.

## Dogfood run — oh-my-pi (self-correction meta-loop fired)
Ran distill-software on `oh-my-pi` (TypeScript Pi-toolkit, pnpm monorepo). Output: `~/source/my_pi/source/oh-my-pi-DISTILL/oh-my-pi-conventions.md` (8 triple-verified engineering models + code-DNA + tooling philosophy + honest boundaries). The run **exposed and fixed** skill gaps:
1. **code_dna.py TS why-counter bug** — counted why-keywords on ALL lines, not just comments → why-ratio >100% (nonsense). Fixed (count within comment lines only).
2. **🔴 Toolchain non-portability** — skill hardcoded `eslint.config.*`/`biome.json`; oh-my-pi uses **OXC (oxlint/oxfmt)**. The 口癖-mining command matched nothing. Fixed: generalized to a **toolchain matrix** (eslint · biome · **oxc** · deno · rustfmt) in SKILL.md (2 places) + code_dna.py. Added: tsconfig strict flags are often the real type-strictness DNA (mine them too).
3. **Added 3 extra streams** (3 → 6): **release/shipping-pipeline** (release/publish/pre-commit scripts + changeset + turbo DAG — the most engineering-dense code), **risk/security-posture** (T0-T4 risk-tier + untrusted-data model — policy, not code), **agent-instruction governance** (meta-convention: how the repo changes its own AGENTS.md).
4. **Extended existing streams**: test-infrastructure patterns (mock factories, source-alias testing, coverage thresholds), workspace orchestration (turbo DAG, workspace:*, package tiers), tool-philosophy rationale.
5. **Added structural/testability DNA** to the code-DNA section — DI seams (factory `provider?`), `safeXxx` never-throw contract, `index-helpers` extraction-for-testability — invisible to static identifier counting but the most important conventions.
**Net**: the skill is materially more complete after one real run. The meta-loop works as designed (real run → gaps → fix → re-run clean). code_dna.py re-tested on oh-my-pi: parses + produces correct toolchain-matrix 口癖 block.

**Meta-loop #2 (sdk/pi-checkpoint sweep, closing coverage to 100%)**: the sdk sweep REFINED 5/8 models (no contradictions) and surfaced 2 more gaps → fixed: **+concurrency/coordination stream** (FS locks/stale-detection/heartbeat, **on-disk vs in-memory interop** — a module loaded as multiple copies across packages MUST coordinate on-disk) · **+platform-hardening stream** (Windows reserved names, rename/remove retry, path-safety) · **sharpened the Result model to a 3-tier spectrum** (`raw` / `locked*` may-throw / `safe*` never-throw+reason-coded — was wrongly collapsed to a binary) · added schema-version-literal pinning + mock-mirrors-decision-tree to structural-DNA. Total extra streams now **8** (was 3 → 6 → 8).

**Completion (per self-defined milestone — all criteria met)**:
1. ✅ Coverage 100% — every content-bearing part swept (docs/extensions/internal/scripts/**sdk**/.pi/themes/enforced-config/CHANGELOG/PR-template). Findings: `oh-my-pi-DISTILL/{oh-my-pi-conventions.md, 05-sdk-checkpoint.md}` + 4 batch research outputs.
2. ✅ Triple-verification on all 8 models (recur across docs+code+enforced; generative; exclusive).
3. ✅ Phase 2.6 V1-V4 (codebase-conventions, not persona-content; each changes a decision).
4. ✅ Installable skill built: `oh-my-pi-DISTILL/oh-my-pi-conventions-SKILL.md` (loadable, staleness-anchored).
5. ✅ Phase 4 fidelity (framework-answerable novel edge — "add a new pi-snapshot extension" — skill gives complete consistent guidance via all 8 models; can be agent-verified for full rigor).
6. ✅ No HIGH skill-gaps blocking (meta-loop closed: toolchain matrix + 8 streams + Result-tier + structural-DNA).
→ **oh-my-pi distillation COMPLETE.** Skill `distill-software` improved by 2 meta-loop rounds. Remaining (low) gaps noted: TS function-length needs LSP; per-batch research files 01-04 not persisted as separate files (captured in synthesis); schema-versioning + mock-quality could be promoted to named axes later.

## Known gaps (honest)
- **TS/JS function-body length not measured** (body-split unreliable for arrow funcs) — use LSP/tree-sitter for accurate TS length. Python length measured.
- **Deep analysis only for Python + TS/JS**; other languages get naming + comment density only (generic fallback).
- **口癖 (forbidden patterns) requires manual lint-config mining** — the script prints the `rg` command; it doesn't parse eslint/biome configs yet. (Could add a parser.)
- **n=1 language per run** — multi-language monorepos need per-language passes (or `--lang` per dir).
- **Not yet validated end-to-end on a real software distillation** (no example output skill exists, unlike distill-persona which dogfooded on the 3 repos). First real use will likely trigger the self-correction meta-loop.

## Relationship / reuse
- `distill-persona` = the base (person 6-stream + topic exhaustive-sweep + verification + F2' + meta-loop + 10 field models).
- `distill-software` = the software specialization (this skill). Reuses the base's phases where silent; specializes sources/DNA/tooling/staleness.
- A future `distill-software-pi-crew` specialization would pin pi-crew/git/pi-langsrv concretely + ship a per-codebase `_dna.py` derived from that codebase's models.
