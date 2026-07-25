## Phase 4 — Fidelity validation (with the mandatory novel-edge test)

Run **independent** sub-agents (fresh context — `context: 'fresh'`; the answerer ≠ scorer; no self-eval — SkillLens: self-eval only 46.4% accurate). **Degraded mode (single-agent build)**: if the runtime can't spawn independent sub-agents, score CONSERVATIVELY, flag EVERY dimension as "single-agent self-score = upper bound", and mark edge-honesty as unverified-on-paper (the F2' inference-flag rule is written down; whether it actually fires under blind testing is exactly what a single agent can't self-prove). Prioritize independent re-scoring of the edge-honesty dimension later. A single-agent FIDELITY.md is a provisional score, not a ship verdict.

Test design (the scorer MAY read the skill file — F2 refuted: skill-file access does not inflate scores):
- **3 known-stance questions** — topics the person publicly addressed repeatedly. Direction + specific detail must match.
- **🔴 1 NOVEL in-domain edge question — and it MUST be framework-answerable, not fact-demanding.** (Validated at n=3: a fact-demanding edge — e.g. "what specific number" — can be dodged by refusal vocabulary and give a false pass. The drift-catching test is a question DERIVABLE from the person's principles that they never publicly addressed — e.g. "given his inversion+incentives models, which of these two deal structures is worse-aligned?".) The skill must flag the stance as inference, NOT present a confident derived judgment as established doctrine. **A skill that passes known-stance + style but fails this is NOT ship-ready.** (See `f2-experiment/validation-conclusion.md` for the test-design rationale.)
- **1 style sample** — blind-read recognizable within ~3 sentences.
- ⚠️ **Test questions must NOT overlap** with example dialogues already in the skill file — if the answerer pattern-matches a stored example rather than reasoning from models, the score is inflated (false pass). Cross-check each test question against the skill's examples before running.

5-dim rubric (100): stance-consistency 30 · style-recognizability 20 · edge-honesty 20 · source-transparency 15 · structural-completeness 15. Ship ≥85 (A) / acceptable ≥70 (B) with flagged weak spots. Iterate Phase 2→4 max 2×; else deliver best + flagged limits.

**Persist fidelity result as `FIDELITY.md`** in the skill dir (mandatory): total + per-dimension scores + per-question test records (Q1–Q5: answer summary + real-stance comparison + score + rationale) + test date + answerer/scorer models + **run observability** (wall-clock time, token count, cost tier — lets the user compare across runs; optional aid: `skills/research/scripts/emit_run_summary.py` emits wall-clock+token+cost from an event log). Enables independent re-scoring (M-F4: published scores are upper bounds; without a persisted baseline, "re-score independently" has nothing to compare against).

**Source-liveness check** (before ship): verify all cited URLs return HTTP 200 (HEAD → GET fallback for servers that 405 on HEAD). Log any dead links in honest-boundaries: "N sources were live at distillation time; M have since become unavailable." Ship-ready requires 0 broken source links OR flagged dead links with an alternative source named.

**Optional — adversarial robustness test** ("Skill Fidelity Bench" pattern): (1) tamper the generated skill (remove a boundary, inject a fabricated model); (2) re-run fidelity eval; (3) measure delta. A robust skill should show *measurable degradation* when tampered — proving original components were load-bearing. A skill that scores the same with and without a boundary means that boundary was cosmetic.

---
