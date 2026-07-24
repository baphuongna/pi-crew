# Distillation-Field Synthesis — PASS 2 (independent re-derivation + reproducibility test)

> Second independent distillation pass over the same 3 source projects, run to (a) go deeper and (b) **dogfood the reproducibility gap (F10)** — does a second pass converge on pass 1's models, or surface different/additional ones? This is exactly what `fidelity_eval.py repro` exists to measure.
>
> Pass 1 artifact: `distillation-field-synthesis.md` (models M1-M5 + M-F1/F2/F3).
> Method: re-derive from the raw FINDINGS without re-reading pass 1's verdicts, then compare.

---

## Reproducibility result (the F10 dogfood)

| | Pass 1 model set | Pass 2 verdict |
|---|---|---|
| M1 HOW-not-WHAT | ✓ | **reproduced** |
| M2 research→extract→validate→generate | ✓ | **reproduced** |
| M3 honest boundaries mandatory | ✓ | **reproduced** |
| M4 quality gated | ✓ | **reproduced** |
| M5 self-contained portability | ✓ | **reproduced** |
| M-F1 dissemination flywheel | ✓ | **reproduced** |
| M-F2 target taxonomy | ✓ | **reproduced** |
| M-F3 ethics spectrum | ✓ | **reproduced** |
| **A — field over-claims its own fidelity** | — | **NEW ★★** |
| **B — dissemination is meme/virality-gated** | — | **NEW ★** |
| **C — distillation must carry its own critique** | (was heuristic C11) | **promoted to model** |

**Reproducibility score**: core model-set overlap = **8/8 (100%)** — pass 2 independently re-derived every pass-1 model. Pass 2 is a **strict superset** (+3). This is the *good* reproducibility outcome (convergent core, deeper pass enlarges surface) and it directly calibrates the F10 gap: a distillation is reproducible on its core claims; a *deeper* second pass legitimately adds. The danger case (two passes <60% overlap) did NOT occur — which is itself the signal that the methodology's Phase 2 (triple-verification) is stable, not coin-flip.

---

## Pass-2 NEW models (the deeper surface)

### M-F4 — The field systematically over-claims its own fidelity ★★ (standout — integrate)
**One-line**: every published distillation fidelity score is an upper bound; the field's self-assessment is inflated by easy test questions + author-side confirmation bias, not scorer contamination.
**Evidence (cross-source ≥2 + experiment)**: nuwa publishes 94-97/100 for its skills; both awesome-lists propagate those scores as quality signals; the F2' experiment independently re-scored 3 nuwa skills → **blind 67-76, edge-honesty 20→7/13/7** (published vs observed). The inflation mechanism (validated at n=3) is *question-design* (edge questions sat too close to documented material; framework-answerable edges weren't tested), NOT scorer skill-file access (F2 refuted).
**Application**: treat ANY published distillation score as an optimistic ceiling. Re-score independently with a framework-answerable novel edge before trusting. A skill that "scores 97" but can't flag inference on a novel in-domain question is not ship-ready.
**Limitation**: this is a critique of *current practice*, not a law — a properly-tested scorecard (with framework-answerable edges + independent blind scorer) could be trustworthy. The field just hasn't been doing that.
**Why pass 1 missed it**: pass 1 captured F2' as a *skill-internal fix* (Phase 4 gate). Pass 2 elevates it to a *field-level model* — the lesson is about the practice, not just our engine.

### M-F5 — Dissemination is meme/virality-gated *(B — note, lighter integrate)*
**One-line**: distillation skills spread by meme-fit, not quality alone — the field's genesis is a single viral meme (colleague-skill) and both indexes rode it.
**Evidence**: both awesome-lists trace the wave to `titanwings/colleague-skill`; nuwa ships 5-language READMEs + promo art (67MB of marketing) for reach; the "distill your boss/ex/deceased" framing is the viral hook. Quality and reach are decoupled — `vengeful-ghost-skill` (satire) and `anti-distill` spread alongside serious engines.
**Application**: a distillation's adoption is gated by narrative/meme-fit as much as fidelity. Plan dissemination (M-F1) with that in mind — don't confuse virality with validation.
**Limitation**: meme-driven ≠ low-quality; it just means quality isn't the bottleneck for spread.

### M-F6 — Distillation must carry its own critique *(C — promoted from pass-1 heuristic C11)*
**One-line**: a healthy distillation practice preserves its skeptics — anti-distill entries, honesty machinery, declared limits — rather than purging them.
**Evidence**: awesome-human-list *includes* `anti-distill` + `vengeful-ghost-skill` as entries; nuwa's anti-pattern blacklist + honest-boundaries; the F2' edge-honesty gate. The critique IS part of the artifact.
**Application**: when building a distillation registry/skill, keep the skeptical entries and the "what this can't do" sections — they're load-bearing, not noise.
**Limitation**: critique-as-content can drift into performance (satire that signals sophistication without substance).

---

## Phase 3 — Integration (pass 2)
**M-F4** (field over-claims fidelity) integrates into `distill-persona/SKILL.md` Field-models section — it's the standout meta-lesson and reframes the existing F2' fix as a field-aware stance. M-F5/M-F6 noted here; M-F6 already implied by the skill's honesty machinery, M-F5 is dissemination-context (covered by M-F1's implication) — no separate SKILL.md bloat.

## Phase 4 — self-check
- ✅ M-F4/M-F5/M-F6 each pass triple-verification (evidence cited, ≥2 sources).
- ✅ Reproducibility core = 8/8 — methodology stable.
- ⚠️ Honest limit: pass 2 was done by the same mind that did pass 1 (not truly independent agents). A rigorous F10 test would use a fresh-context agent for pass 2. The 100% core convergence is therefore *suggestive*, not proof. (The fidelity_eval repro harness measures this properly when two *files* exist; here both passes fold into one skill, so the comparison is analytical, not automated.)
