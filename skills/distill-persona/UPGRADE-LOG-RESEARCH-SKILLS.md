# UPGRADE-LOG — research-skill self-upgrade candidates applied to the distill skills

> Companion to `source/RESEARCH-SKILLS-SELFUPGRADE-CANDIDATES.md` (the 12-candidate artifact). This log records the EFFECTIVENESS-VERIFICATION gate verdict (concrete-delta + proof + conflict-check + verdict) for each candidate, and what was actually applied.
>
> Date: 2026-07-24 · Targets: `skills/distill-persona/SKILL.md`, `skills/distill-software/SKILL.md` (+ 2 new `references/handoff.md`).

## Effectiveness-gate legend (per distill-software Phase 2.6 EFFECTIVENESS VERIFICATION)
- **CONCRETE DELTA** — exactly what changes in target.
- **EFFECTIVENESS PROOF** — GENERATIVE (changes a real decision) / PROBLEM-EXISTS (target has the gap) / DELTA-TEST.
- **CONFLICT CHECK** — does it clash with an existing practice?
- **VERDICT** — ✅ APPLIED · ❌ SKIPPED (+ reason).

---

## APPLY (high-value, low-risk)

### #1 verify_citations rigor — ✅ APPLIED → distill-persona Phase 2.6 (new V5)
- **Concrete delta**: Phase 2.6 gains a **V5 — Source/citation verified** gate (persona analog of distill-software's grep-V5): every cited source exists in the fetched pool, no invented URLs, no dangling `[n]`, source concentration ≤25%. `skills/research/scripts/verify_citations.py` referenced as an OPTIONAL aid (not ported — the script already lives in the research skill).
- **Proof**: PROBLEM-EXISTS — V1–V4 covered signal/redundancy/effective/optimal but NOT source-integrity; invented URLs and over-concentrated sourcing were caught only by hand. verify_citations.py exists and is runnable (`skills/research/scripts/verify_citations.py`).
- **Conflict**: none — V5 sits after V4; V1–V4 unchanged.
- **Verdict**: ✅ APPLIED (surgical: 1 bullet, references existing script rather than porting it).

### #2 tension-discovery 3-probe — ✅ APPLIED → distill-persona Phase 2 (内在张力)
- **Concrete delta**: the 内在张力 extraction line gains an active-probing checklist: discover tensions via 3 named probes (concept-confusion / assumption-check / effect-vs-mechanism) instead of reactively recording whatever surfaced.
- **Proof**: PROBLEM-EXISTS — current tensions were post-hoc (recorded, not sought). Probe 2 ("what is everyone assuming?") would have caught model drift earlier.
- **Conflict**: none — inline prose (parenthetical (1)/(2)/(3)), no new section; M9a format preserved. The source `tension-discovery.md` was NOT copied — only the 3-probe names integrated.
- **Verdict**: ✅ APPLIED (1 inline addition; no file copy).

### #7 emit_run_summary observability — ✅ APPLIED → BOTH skills Phase 4 (FIDELITY.md)
- **Concrete delta**: FIDELITY.md persistence gains a **run observability** field (wall-clock time, token count, cost tier). `skills/research/scripts/emit_run_summary.py` referenced as optional aid in BOTH skills.
- **Proof**: PROBLEM-EXISTS — FIDELITY.md tracked scores + models but no cost; run-comparison was impossible (Run #2's 11.27M-token blowout was detectable only with such observability).
- **Conflict**: none — additive to the existing FIDELITY.md spec.
- **Verdict**: ✅ APPLIED (mirrored to both skills; symmetry grep-verified: 1 occurrence each).

### #9 handoff-format protocol — ✅ APPLIED → BOTH skills
- **Concrete delta**: new `references/handoff.md` in EACH skill (concise ~40-line protocol adapted to distillation, not generic research) + 1-line pointer in each SKILL.md (distill-persona at the context-window guard; distill-software at Phase 4 fidelity).
- **Proof**: PROBLEM-EXISTS — handoff was a single sentence ("segment across sessions"); a fresh session had no contract for lossless resume.
- **Conflict**: none — the 2-file state pattern (M#3) is preserved; handoff.md is an index over existing state files, not a new mechanism.
- **Verdict**: ✅ APPLIED (mirrored; both handoff.md files created; both SKILL.md have 1 pointer each).

### #12 "Removed" changelog tracking — ✅ APPLIED → distill-persona Update mode
- **Concrete delta**: Update mode gains a **Deletion tracking** rule — log what was removed (`### Removed`) alongside additions; "no removals" stated explicitly if none.
- **Proof**: PROBLEM-EXISTS — update mode only ever grew the skill; stale heuristics never pruned → drift (the foundry distill-skills grew without deletion logs).
- **Conflict**: none — additive to Update mode; no-op detection preserved.
- **Verdict**: ✅ APPLIED (1 paragraph).

---

## APPLY CAREFULLY (medium, kept concise)

### #4 anti-thrash convergence gate — ✅ APPLIED → distill-persona Phase 2 (diminishing-returns gate)
- **Concrete delta**: the 3-empty-rounds gate gains an **active anti-thrash nudge**: if ≥3 consecutive rounds add only 0–1 marginal findings (low-yield but not zero), switch to a structurally different approach BEFORE the passive 3-empty gate fires.
- **Proof**: PROBLEM-EXISTS — Run 2's 11.2M-token spiral was exactly grinding low-yield variations without structural change.
- **Conflict**: none — the 3-empty-rounds gate is preserved; this is a within-round intervention that fires earlier (low-yield) than the terminal gate (zero). NOT a full hook port — integrated as 1 sentence.
- **Verdict**: ✅ APPLIED (1 sub-step; no `references/anti-thrash.md` companion — kept inline).

### #6 hypothesis-reflection — ✅ APPLIED → distill-persona Phase 2.6 V5
- **Concrete delta**: V5 gains a cheap-model meta-critique step — before a costly re-extract on V5 failure, ask a lighter model to critique the failure pattern and propose an adjacent direction.
- **Proof**: PROBLEM-EXISTS — the M#2 V5-rejection (4-way → 3-way) was a meta-pattern (over-claiming); a cheap critique would have caught the over-claim before the expensive re-extract.
- **Conflict**: none — V5 preserved; the critique is upstream of re-extraction.
- **Verdict**: ✅ APPLIED (folded into the V5 bullet with #1; 1 sentence).

---

## SKIP (justified)

### #5 context-rotation — ❌ SKIPPED
- **Reason**: pi-autoresearch's `.auto/` on-disk state layout is NOT the distill skills' model. The distill skills persist state to `references/research/` + checklists, not a single growing `prompt.md`. Context pressure is already handled by the context-window guard (F6) + session segmentation (#9 handoff).
- **Effectiveness proof fails**: PROBLEM-EXISTS is weak — there is no `.auto/prompt.md` analog to rotate. The real fix for context pressure is already present (segmentation + handoff).
- **Conflict**: would introduce an alien state model. **Verdict**: ❌ SKIPPED.

### #8 5-tier ship-gate — ❌ SKIPPED (folded lightly)
- **Reason**: distill-software already has a working single ship-gate (the all-green checklist with 10 items). Restructuring into a 5-tier Gate 1–5 model would risk the mature validator's grep checks and the existing gate contract for marginal cost-awareness gain.
- **Folded lightly**: added 1-line **Tiered effort** note — trivial distillations may skip the costliest sub-step (independent dual-agent re-score → self-score with caveat), but never the structural/V5-grep/coverage gates.
- **Effectiveness proof**: PARTIAL — the 5-tier model's value (skip expensive gates for trivial output) is captured by the 1-line note without the risky restructuring.
- **Conflict**: a full restructure would break cross-references. **Verdict**: ❌ SKIPPED-restructure / ✅ folded-1-line.

### #10 hard-constraint block — ❌ SKIPPED
- **Reason**: minor convention; the generated-skill template already enforces its invariants via the validator (validate-skill-structure.mjs asserts mandatory fields, Agentic Protocol, no placeholders). A prose "Hard Constraint:" block duplicates what the validator machine-enforces.
- **Effectiveness proof fails**: PROBLEM-EXISTS is weak — the validator IS the hard-constraint enforcement; a prose block adds ceremony, not rigor.
- **Conflict**: none, but low value. **Verdict**: ❌ SKIPPED.

### #11 P0–P6 heading rename — ❌ SKIPPED (RISKY)
- **Reason**: renaming `## Phase N` → `## P0–P6` is purely cosmetic AND would break (a) the validator's Phase-based grep assertions, (b) cross-references throughout both skills and the knowledge base that match "Phase N", (c) the self-upgrade directive text that references phases by number.
- **Effectiveness proof fails**: PROBLEM-EXISTS is cosmetic (readability), not functional. The conflict risk (breaking validator + cross-refs) vastly outweighs the readability gain.
- **Conflict**: HIGH — breaks validator + cross-references. **Verdict**: ❌ SKIPPED.

---

## Candidate #3 (source_evaluator) — note
The artifact lists #3 (source_evaluator.py → distill-software Phase 2.1). It was NOT in the APPLY/APPLY-CAREFULLY triage for this run (the task scoped the distill-software changes to #7, #9, #8-fold only). #3 remains a future candidate — it would add a source-quality gate to the decisions stream, but porting the script + integrating into Phase 2.1 exceeds the "surgical" bar set for this pass.

---

## Verification evidence
- `distill-persona` validator: **12 pass, 9 fail** — IDENTICAL to pre-edit baseline. The 9 failures are all inherent to the engine skill being a *template* (placeholders `<person>`/`<target>`; no generated artifacts FIDELITY.md / EXCAVATION-CHECKLIST.md / DISTILLATION-PROCESS-CHECKLIST.md — those are produced per GENERATED skill, not the engine). **No new failures introduced.**
- `research` validator (reference): **30 pass, 0 fail — ✅ ALL-GREEN** (unchanged; research skill not edited).
- Symmetry grep: `emit_run_summary.py` = 1 in each SKILL.md; `references/handoff.md` = 1 pointer in each SKILL.md; both handoff.md files created.
- Phase numbering / heading scheme: UNCHANGED (constraint #2 honored).
- distill-persona M9a count (内在张力 ≥3), honest-boundaries (≥3), M12 fallback (7 rows): all UNCHANGED — no edit disturbed validator counts.
