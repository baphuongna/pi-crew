# R1 Extraction Verification — V1-V4 audit (reject garbage; keep optimal+effective)

> Running the new Phase 2.6 gate on everything R1 extracted. Audit trail — every candidate checked, rejects recorded with the V-fail reason (never silently dropped). **"Chưng cất bừa làm rác" = over-extraction is a failure.**

## Field models — all PASS V1-V4 → KEEP

| Model | V1 signal | V2 non-redundant | V3 effective | V4 optimal | Verdict |
|---|---|---|---|---|---|
| **M-F1** dissemination flywheel | ✓ practice | ✓ distinct | ✓ build dissemination at registry scale | ✓ sharp | **KEEP** |
| **M-F2** taxonomy (empirically corrected) | ✓ practice | ✓ distinct | ✓ routing + consent gate | densest model (5 sub-pts) but each changes a decision → accuracy-justified | **KEEP** (flagged densest) |
| **M-F3** ethics spectrum | ✓ practice | ✓ distinct | ✓ consent gate | ✓ sharp | **KEEP** |
| **M-F4** over-claims + structural warning | ✓ practice | ✓ distinct | ✓ re-score; don't trust auto-pass | ✓ sharp | **KEEP** |
| **M-F7** structural invariants | ✓ index-layer practice | distinct from M4 (engine content-fidelity) & M-F1 (architecture) — adds concrete techniques (language-agnostic keys, atomicity, regression guards, governance-keyword embedding) | ✓ registry-building decisions | considered merge into M-F1; kept separate (distinct actionable content, cross-ref noted) | **KEEP** |

**Effectiveness delta**: each of the 5 changes a concrete decision → the skill is MORE effective, not just longer. ✓

## Persona-CONTENT candidates — V1 FAIL → REJECT from field-models (retained in r1-a as example-skill contents)

~22 candidates from batch A are persona CONTENT (what Musk/Naval/Jobs/Sun think), NOT distillation methodology. REJECTED:
idiot-index · desire-as-contract · dual-mode architecture · sixth-grader test · cargo-cult detection · anti-self-deception · median principle · dialect-as-structural · concession trigger · soul-inquiry · tool-invocation invisibility · reduce-to-underlying-problem · attention arbitrage · narrative override · identity leverage · context-switching matrix · money-as-universal-solvent · asymptotic-limit thinking · redefine-the-word · pain-to-system · anti-balance principle · ancient-wisdom citation · binary-judgment.
**Reason (V1)**: these describe the SUBJECTS' thinking, not the distillation PRACTICE. They belong inside persona example-skills (as their content), not in a distillation-engine's field-models. *(Correctly never integrated into SKILL.md — this audit makes the principle explicit so future passes don't relapse.)*

## Reclassified (borderline — moved to correct home, not field-models)

- **`gestalt = failure` hard rule** (from steve-jobs) — V1 PASSES (it's a method rule, not persona content). Already adopted into Phase 1 anti-pattern. KEEP as-is (method rule). ✓
- **ghost-mode exit trigger** (deceased-persona date-anchor) — V1 passes as a *technique*. It's a person-mode staleness-handling detail → belongs in person-mode Phase notes, NOT a field-model. Reclassify: person-mode technique (Phase 1 person-mode already covers staleness generally).
- **contradiction-as-signal** (merge_research.py) — V1✓ V3✓ (changes Phase 1.5 synthesis: surface disagreements, don't average). KEEP as a **Phase 1.5 technique note**, not a field-model. *(added to Phase 1.5)*
- **source-type quality hierarchy** (download_subtitles.sh: manual>auto, source-lang>translated) — V1✓ V3✓ (source selection). Minor heuristic → note, not model.
- **"4D distillation"** (anti-distillation as 4th dimension, r1-c) — V2 FAIL: >70% overlap with M-F3 (ethics/anti-distill) + the "carry own critique" stance. MERGE: noted under M-F3, NOT a new model.
- **dissemination dual-gate** (community_check.py: honest-boundary + FIDELITY≥70) — V2: this is EVIDENCE FOR M-F1/M-F4, not a new model. Recorded as evidence.

## Net verdict
- R1 extracted ~30 candidates; **5 field models kept (all pass V1-V4)**, ~22 persona-content REJECTED (V1), 4 reclassified to correct homes (technique/evidence/merge).
- The integrated skill is **verified clean**: every field-model changes a real decision; no garbage, no redundancy, no persona-content leak.
- **Over-extraction was contained** (garbage stayed in research files, never polluted SKILL.md) — now made *principled* by Phase 2.6 so it's repeatable, not luck.
- Skill model-count = 5 field models (M-F1..F4, M-F7) + 5 core models (M1-M5) = 10 total — within the "sharp over numerous" budget. Pruning >50% of candidates = the gate working.
