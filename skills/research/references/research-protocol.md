# Research Protocol — deep-dive notes

> Extended notes on the 6-phase research flow. Read this for the detailed Step 2 sub-steps; the SKILL.md is the executor.

---

## Phase 0 — Entry routing

Decide before any research:
- **Flavor**: field (topic) — the field of agentic deep-research skills
- **Sub-domain decomposition**: 4 sources split (one per source) + 1 cross-source synthesis
- **Cost tier**: standard (4 sources, mid-sized)
- **Recency bar**: HB-3 — all 4 sources are shallow clones; HEAD may have moved

Defaults (override with explicit user confirmation):
- Topology = single-agent (fan out only when justified)
- Iteration mode = declared per sub-question (M#2)
- Validator stack = schema + citations + sources + emit-summary

---

## Phase 1 — Research (the 6-phase field sweep)

### 1.1 — The 4 sources

| Source | Why it's here | Failure mode if missed |
|--------|----------------|--------------------------|
| Deep-Research (Weizhena) | The 6-phase research flow + items×fields + JSON validator | Lose the structured-output DNA |
| x-research (rohunvora) | Cost transparency + query refinement + delete-stale | Lose the cost-discipline DNA |
| pi-autoresearch (davebcn87) | State-on-disk + LOOP FOREVER + hooks + compaction | Lose the pi-native DNA |
| Geek (parent in ClaudeSkills) | Rigor + citations + sources + tensions + handoff | Lose the rigor DNA |

### 1.2 — The 3-sweep mode

| Sweep | What you do | What you record |
|-------|-------------|------------------|
| R0 (gestalt) | Each source: open every file; mark COVERED/UNCOVERED/UNREADABLE | COVERED entries with `file:line` contribution |
| R1 (verify) | V1–V5 on every claim; chase citations to actual line content | V5 corrections: count, length, misattribution, drift |
| R2 (synthesize) | Cross-source; map disagreements | 5 inner tensions with evidence each side |
| R3 (gate) | 3-empty-rounds verification | Gate fires; field surface exhausted |

### 1.3 — The 3-empty-rounds gate

The bar is **nothing-new**, not less-new. Re-confirmation of a known point ≠ new.

```bash
# After each sweep, count:
# - new models (V1–V5 pass, not redundant)
# - new heuristics (V1–V5 pass, not redundant)
# - new anti-patterns (V1–V5 pass, not redundant)
# - new tensions (V1–V5 pass, not redundant)
# - new boundaries (V3 + V5 pass)
# 0 new × 3 consecutive rounds → gate fires
```

---

## Phase 2 — Triple-verification

For every claim:

1. **Cross-source recurrence** — appears in ≥2 unrelated sources? (structural, not anecdotal)
2. **Generative** — predicts a stance on a NEW question never publicly addressed?
3. **Exclusive** — *the field's*, not what any smart person would say?

Pass → MODEL. Fail → demote to heuristic / anti-pattern / discard.

---

## Phase 2.6 — V1–V5 extraction verification

| V | Question | What it catches |
|---|----------|------------------|
| V1 | Is this a method/principle, or a persona-content quirk? | Catch vibes-as-DNA |
| V2 | Is this redundant with an existing claim? | Catch double-counting |
| V3 | Does it change a real decision? | Catch windmill-tilting |
| V4 | Is it the simplest form? | Catch over-elaboration |
| V5 | Is every constant/function-name/file:line grep-verified? | Catch hallucinations |

V5 is the most important. A misattributed citation = a hallucinated model.

---

## Phase 3 — Build

> Build the rigor mechanisms INTO the runtime, not in a static doc.

| Asset | What it does |
|-------|--------------|
| `SKILL.md` | The executive summary + Agentic Protocol |
| `references/verified-models.md` | The V1–V5 audit trail |
| `references/source-inventory.md` | The per-source citation table |
| `references/anti-patterns.md` | The extended anti-pattern catalog |
| `scripts/verify_citations.py` | The citation gate (Step 2 wire) |
| `scripts/source_evaluator.py` | The source 3D filter (Step 2 wire) |
| `scripts/code_dna.py` | The 12-axis grid measurement (Step 2 wire) |
| `scripts/emit_run_summary.py` | The run summary emitter (Step 4 wire) |
| `scripts/validate-skill-structure.mjs` | The structural gate (Phase 4 wire) |
| `EXCAVATION-CHECKLIST.md` | The Phase 1 protocol |
| `DISTILLATION-PROCESS-CHECKLIST.md` | The whole-pipeline tracker |
| `FIDELITY.md` | The Phase 4 fidelity report |

### Validation contract

Before any ship:
1. `node skills/distill-persona/scripts/validate-skill-structure.mjs skills/research/` → all-green
2. `python3 skills/research/scripts/verify_citations.py --self-test` → exit 0
3. `python3 skills/research/scripts/source_evaluator.py --self-test` → exit 0
4. `python3 skills/research/scripts/emit_run_summary.py --self-test` → exit 0
5. `python3 skills/research/scripts/code_dna.py --self-test` → exit 0

If any fails → iterate Phase 2 → 3.

---

## Phase 4 — Fidelity

### 4.1 — The 5-dim rubric (100 pts)

```
Fidelity = 0.30 * field-consistency
        + 0.20 * research-DNA distinctiveness
        + 0.20 * edge-honesty  (gate: <14 = NO-SHIP)
        + 0.15 * source-transparency
        + 0.15 * structural-completeness
```

### 4.2 — The 5 test questions

| # | Type | Question |
|---|------|----------|
| Q1 | Field consensus | "What is the universal pre-flight rule before any research run?" |
| Q2 | Field divergence | "What does 'iteration' mean in research?" |
| Q3 | Anti-pattern | "What is the anti-pattern for cite-from-memory?" |
| Q4 | Framework-answerable novel edge | "Should I use RAG or fine-tuning for a 1M-token corpus?" |
| Q5 | Style sample | Read 3 paragraphs; recognize the field? |

### 4.3 — Single-agent caveat

LLM self-eval accuracy is 46.4% (SkillLens). The single-agent self-score is an **upper bound**. Independent dual-agent scoring is required for ≥85/100.

---

## Phase 5–6 — Registry routing (optional)

Skipped for single skills. Apply at registry scale (200+ entries).

---

## Honors / failure mode catalog

| Failure mode | What it looks like | How to detect |
|--------------|---------------------|-----------------|
| Skim-hallucination | Conventions cited but no grep hit | V5 grep verification |
| Quirk-as-principle | Quirk bloat (3 examples of "X did Y") | Exclusivity test (V5) |
| Recency erasure | Skill presents current-only view | Timeline stream |
| Orphaned scripts | Scripts in a tools table never invoked | F13 wire-up check |
| Single-source monoculture | One perspective dominates | Topic-source diversity |
| Cost hidden | User can't decide to continue | Per-call cost column |
| Tension papered over | Out-of-scope disagreements | 3-probe tension test |
| Validator orphaned | Validators exist but never run | Grep Agentic Protocol for script names |
| Mono-mode confusion | Skill switches breadth↔depth silently | iteration_modes column in code_dna |
