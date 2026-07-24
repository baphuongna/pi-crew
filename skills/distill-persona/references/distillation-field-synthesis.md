# Distillation-Field Synthesis — topic distillation of the 3 source projects

> **Dogfooding artifact**: the `distill-persona` skill applied to its own source material. Topic flavor (extraction-framework §5): distill the *field* of "agent-skill distillation" from the 3 source projects, not one persona.
>
> **Sources** (P1 = `nuwa-skill` the engine; P2 = `awesome-human-distillation` index+autocuration; P3 = `awesome-persona-distill-skills` index+submission-automation).
> **Phase 1 (research)**: already done — `source/{nuwa-skill,awesome-human-distillation,awesome-persona-distill-skills}-FINDINGS.md` + reviews + the F2' experiment.
> **Method**: Phase 2 triple-verification (cross-*source* recurrence ≥2 projects + generative + exclusive) on every candidate claim.

---

## Phase 2 — Triple-verification table

Candidate claims drawn from the 3 projects, tested (✅=passes, ⚠️=partial, ❌=fails → demote/discard).

| # | Candidate claim | Cross-source (≥2 projects) | Generative | Exclusive | Verdict |
|---|---|---|---|---|---|
| C1 | "Distill HOW they think, not WHAT they said" | ✅ P1 core principle + P2/P3 definitions ("expressive style, decision frameworks, interaction patterns") | ✅ predicts a good skill captures models not quotes | ✅ defining distinction of distillation | **MODEL** |
| C2 | "Distillation = research→extract→validate→generate pipeline" | ✅ P1 6-phase; P2/P3 link projects following it | ✅ | ✅ | **MODEL** |
| C3 | "Honest boundaries mandatory, not optional" | ✅ P1 honest-limits+edge-honesty; P2/P3 ethical guardrails in definitions | ✅ | ✅ | **MODEL** |
| C4 | "Distill → awesome-list → auto-curation = dissemination flywheel" | ✅ **P2 AND P3 both build issue→PR→merge pipelines**; P1 feeds both | ✅ predicts a mature practice needs an indexing/dissemination layer | ✅ | **MODEL — NEW** ★ |
| C5 | "Target taxonomy: self → relationships → public-figures → fields" | ✅ P3 5 categories + P2 6 relationship categories + P1 person-vs-topic | ✅ predicts what's distillable | ✅ | **MODEL — NEW** ★ |
| C6 | "Quality is gated, not assumed" | ✅ P1 fidelity-scorecard+triple-verification; P2/P3 submission quality gates + consistency checks | ✅ | ✅ | **MODEL** |
| C7 | "Self-contained portability (copy dir → runs)" | ✅ P1; P2/P3 skills are standalone repos | ✅ | ✅ | **MODEL** |
| C8 | "Ethics spectrum: commemorative ↔ consent-violating" | ✅ P3 commemorative category + guardrails; P2 satire (anti-distill, vengeful-ghost) + "just vibing"; P1 consent rules for living private figures | ✅ predicts which distillations need consent flags | ✅ | **MODEL — NEW** ★ |
| C9 | "Expression DNA is quantifiable" | ⚠️ P1 only (prose stylometry); P2/P3 don't quantify | ✅ | ❌ not cross-source | demote → **P1-specific heuristic** |
| C10 | "Triple-verification (cross-domain+generative+exclusive)" | ⚠️ P1 only formalizes it; P2/P3 don't | ✅ | ⚠️ | keep as **P1 method** (already in skill) |
| C11 | "Anti-distillation is a legitimate stance" | ✅ P2 (anti-distill, vengeful-ghost entries); P1 anti-patterns; the "don't over-distill" tension | ✅ | ✅ | **heuristic / anti-pattern** |
| C12 | "Source blacklists (Zhihu/WeChat) are universal" | ❌ P1 only; overfit to Chinese context (review F11) | — | ❌ | **discard as universal** (keep scoped) |
| C13 | "Published fidelity scores are reproducible" | ❌ **F2' experiment refuted** (published 94-97 → blind 67-76 across 3 skills) | — | — | **discard — anti-model** |

→ **3 genuinely-NEW models** (C4, C5, C8) not yet in `distill-persona`. The rest were already captured when the skill was built from P1. ★ marks the new ones to integrate (Phase 3 below).

---

## Phase 2 — Confirmed field mental models (the distillation of the 3 projects)

### M1 — HOW they think, not WHAT they said *(C1, already in skill)*
The defining act of distillation. Evidence: P1 "捕捉的是HOW they think，不是WHAT they said"; P2/P3 definitions ("extract expressive style, decision frameworks, interaction patterns from traces"). Application: when building any skill, ask "am I capturing the reasoning framework or compiling quotes?" Limitation: "HOW they think" is hard to verify without generative tests (→ M6).

### M2 — Research → Extract → Validate → Generate *(C2, already in skill)*
Distillation is a pipeline, not a prompt. Evidence: P1's 6 phases; both lists index projects that follow this shape. Application: never shortcut to generation; the validate phase (M6) is what separates a skill from a chatbot-prompt. Limitation: the pipeline cost is real (M-cost-tier).

### M3 — Honest boundaries are mandatory *(C3, already in skill)*
Evidence: P1 honest-limits + edge-honesty (fidelity dim); P2/P3 build guardrails into their definitions ("not equivalent to complete reconstruction of a real individual"). Application: ≥3 limits + staleness date in every skill. Limitation: declaring limits ≠ enforcing them on novel questions (the F2' finding).

### M4 — Quality is gated, not assumed *(C6, already in skill)*
Evidence: P1 triple-verification + dual-agent fidelity; P2/P3 submission gates + bilingual-consistency CI checks. Application: every distilled skill passes an independent gate before use. Limitation: gates can be gamed by easy test questions (F2' — require framework-answerable novel edges).

### M5 — Self-contained portability *(C7, already in skill)*
Evidence: P1 "copy the skill dir → it runs"; both lists' skills are standalone repos. Application: bundle all research/template/scripts inside the skill dir; never external deps. Limitation: the *engine* itself isn't always portable (review F9 — nuwa's engine reads its own references/ at runtime).

---

## Phase 2 — NEW models to integrate (★ the cross-project synthesis surfaces these)

### M-NEW1 — Dissemination flywheel *(C4)* ★
**One-line**: a mature distillation practice is a 3-layer flywheel — **engine (distill) → index (awesome-list) → auto-curation (issue→PR→merge)** — not just the engine.
**Evidence (cross-source ≥2)**: P2 ships `auto_add_skills.py` + `check_links.py` + `sort_by_stars.py` on cron (issue → LLM-translate → insert → commit → close); P3 ships `submission-automation.mjs` + `create-approved-submission-pr.yml` + `merge-approved-submission-pr.yml` (label → auto-PR → validate → merge, CodeQL-gated). Both wrap P1's engine as the value-generating core. Neither is just a static list.
**Application**: distilling a skill is step 1; getting it discovered, quality-checked, and distributed is steps 2-3. A distillation skill that ignores dissemination is half a practice.
**Limitation**: the flywheel is overkill for personal/single skills; it earns its cost only at registry scale. (Anti-pattern: building auto-merge CI before you have 10 skills.)

### M-NEW2 — Target taxonomy: self → relationships → public-figures → fields *(C5)* ★
**One-line**: distillation targets form a spectrum with sharply different source-availability, ethics, and methods.
**Evidence**: P3's 5 categories (self-distillation+meta-tools / workplace-academic / intimate-family-memory / public-figures-methodology / spiritual-specialized); P2's 6 relationship categories (self, boss, colleague, intimate, deceased, public); P1's person-vs-topic axis.
**The spectrum**:
| Tier | Target | Source availability | Ethics bar | Method |
|------|--------|--------------------|-----------|--------|
| self | yourself | you provide corpus | self-distortion risk | local-corpus mode |
| close | boss/colleague/ex/relative | limited, private | **consent required** | user-corpus, flag boundaries |
| commemorative | deceased/absent loved one | archival | grief-sensitivity | preserve contradictions |
| public-figure | Munger/Karpathy/… | abundant public | accuracy + recency | full 6-stream |
| field | a domain (perf, investing) | multi-source | consensus-vs-divergence | topic-skill variant |
**Application**: route the distillation by target tier — source strategy, ethics flags, and method all change. A "distill your boss" skill must hit a consent gate a "distill Munger" skill doesn't.
**Limitation**: tiers blur (a public figure you personally knew; a field dominated by one person). Use the tier to set *defaults*, not hard walls.

### M-NEW3 — Ethics spectrum: commemorative ↔ consent-violating *(C8)* ★
**One-line**: distillation ranges from a *memorial act* (preserving a lost person's way of thinking) to a *consent violation* (cloning a living non-consenting individual) — the same technique, opposite moral weight.
**Evidence**: P3 has a dedicated "commemorative" category + guardrails ("not equivalent to complete reconstruction"); P2 embraces the satirical/critical end (`anti-distill`, `vengeful-ghost-skill`, "just vibing, not defecting"); P1 sets consent rules (living private individuals need user-provided corpus + consent reminder).
**Application**: every distillation declares its ethics tier on the spectrum. Commemorative → lead with consent-of-estate/family; close-living → lead with subject consent; public-figure → lead with accuracy/recency. Anti-distill satire is a *legitimate* stance (C11), not a defect — it pressure-tests the practice.
**Limitation**: the line between "methodology lens" (distilling Munger's thinking) and "persona impersonation" (pretending to BE Munger) is where most ethical slip happens; the skill must keep the former, flag the latter.

### Heuristics (from cross-project patterns)
- **H1 — Lead with consent for living subjects** (P1 rule + P2/P3 implicit). Distilling a living non-public person requires their material AND a consent flag.
- **H2 — Anti-distill is a feature** (C11). Preserve skepticism entries; they catch over-reach.
- **H3 — Separate "conventions (descriptive)" from "principles (normative)"** (from the software review, but generalizes): a distillation reports what the subject does, doesn't endorse it.

### Anti-models (cross-project failures to avoid)
- **A1 — Trusting published fidelity scores** (C13, refuted by F2'): treat 9X/100 as upper bound; re-score independently with framework-answerable edges.
- **A2 — Universal source blacklists** (C12): Zhihu/WeChat bans are Chinese-context quality heuristics, not universal law.
- **A3 — Engine-without-dissemination** (inverse of M-NEW1): a perfect distillation engine with no indexing/curation layer stays invisible.

### Honest boundaries of THIS synthesis
- n=3 projects, all from the same 2025-2026 "persona distillation" meme-wave (Chinese-dev-community origin) → field models may be wave-specific, not timeless.
- The synthesis is biased toward nuwa (P1) because it's the only engine; the 2 lists are indexes, so "method" claims lean on P1.
- M-NEW1/2/3 are descriptive of *this ecosystem's practice*, not yet validated as universal distillation principles (would need cross-ecosystem evidence — e.g. ML knowledge-distillation literature, expert-system rule-capture history).

---

## Phase 3 — Integration into distill-persona

The 3 NEW models (M-NEW1/2/3) fold into `distill-persona/SKILL.md` as a new **"## Field models (from the source projects)"** section + this file as `references/distillation-field-synthesis.md`. The already-captured models (M1-M5) need no change. See the SKILL.md edit.

## Phase 4 — Fidelity self-check (adapted)
`distill-persona` is a *methodology* skill, not a persona — the persona fidelity scorecard (stance/style/edge-honesty) doesn't cleanly apply. Adapted check:
- ✅ Every NEW model passes triple-verification (cross-source ≥2, cited above).
- ✅ Honest boundaries of the synthesis itself are declared (wave-specificity, P1-bias, descriptive-not-universal).
- ✅ The anti-model A1 (don't trust published scores) is consistent with the skill's existing F2' gate.
- ⚠️ Full validation would need applying M-NEW2 (taxonomy) to a distillation outside this meme-wave (e.g. distilling an ML-researcher's methodology from arXiv, not X/podcasts) to test whether the models generalize. Deferred.
