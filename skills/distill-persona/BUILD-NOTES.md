# distill-persona — Build Notes (decision traceability)

> Why this pi-native port makes each choice. Traces every design decision to a finding from the review/experiment cycle.

## What this is
A pi-skill port of nuwa's (女娲) distillation engine, incorporating: the nuwa methodology (researched), the rigorous review (NUWA-SKILL-REVIEW), the variant reviews (x-mastery-mentor, mrbeast), the empirical fidelity experiment (f2-experiment), AND **two self-distillation passes** over the 3 source projects (dogfooded — see below).

## Self-distillation log (dogfooded the skill on its own sources)
The skill was applied to the 3 source projects (nuwa + 2 awesome-lists), topic flavor. Three rounds:
- **Pass 1** (`references/distillation-field-synthesis.md`): triple-verified 13 candidates → 3 NEW field models (M-F1 dissemination flywheel, M-F2 target taxonomy, M-F3 ethics spectrum) integrated into SKILL.md Phase 0.
- **Pass 2** (`references/distillation-field-synthesis-pass2.md`): independent re-derivation → **core 8/8 reproduced (100%)** + 1 standout new model **M-F4 (field over-claims its own fidelity)** — elevates the F2' finding from a skill-internal fix to a field-level meta-model.
- **R1 exhaustive sweep** (user correction: distillation must sweep EVERY part over many rounds, not gestalt): upgraded Phase 1 to add **project/topic exhaustive-sweep mode** (coverage manifest + diminishing-returns gate + self-correction meta-loop). Then RAN it — 4 parallel batches swept the 9 uncovered nuwa examples + scripts + 76KB README + 5 test files (`references/research/r1-{a,b,c,d}.md`). **3 self-corrections integrated**: (1) **M-F2 empirically corrected** — gestalt spectrum was wrong (84% public-figures, bimodal; +meta-tier, living-creator, commemorative-split); (2) **+M-F7** (structural invariants = index-scale quality gate, from the test sweep); (3) **M-F4 strengthened** (quality_check.py structural-pass ≠ behavioral edge-honesty → never trust structural-only auto-pass). This is the self-correction meta-loop firing: the sweep found the skill's own M-F2 was gestalt-inaccurate and fixed it.
- **R1.5 extraction verification** (user correction: distillation must verify it's optimal+effective, not "chưng cất bừa làm rác"): added **Phase 2.6 Extraction verification gate** (V1 signal-not-persona-content · V2 non-redundant · V3 effective · V4 optimal · reject principle + post-integration delta check). RAN it on R1 output (`references/research/r1-verification.md`): audited ~30 candidates → **5 field models kept** (all pass V1-V4), **~22 persona-content REJECTED** (V1 fail — idiot-index/desire-as-contract/etc. are subject content, not distillation method), 4 reclassified. Over-extraction was already contained (garbage stayed in research files); now made *principled & repeatable*. Skill carries 10 models total (5 core M1-M5 + 5 field M-F1..F4/M-F7) — sharp, not bloated.
- **Reproducibility (F10 dogfood)**: core model-set overlap 8/8 — methodology is stable (not coin-flip); pass 2 is a strict superset (deeper pass enlarges surface). R1 then enlarged surface further (M-F7) AND corrected an existing model (M-F2). Caveat: same mind across passes — suggestive, not proof.

## Decision → finding trace

| Decision in the skill | Driven by |
|---|---|
| pi frontmatter (`name` + 1-line `description` + `triggers:` list) | F4/F5 — pi's explicit-trigger convention avoids nuwa's keyword-stuffed descriptions |
| Detect `<skill-dirs>`; don't hardcode `.claude/skills/` | **F1** — environment lock-in (the #1 reason nuwa won't run in pi) |
| Dispatch research via `team action='parallel'` / background `Agent`, with **serial + single-agent fallback as documented default** | **F1** + nuwa's own failure table ("runtime without background tasks hangs") |
| Guard tool availability (WebSearch/rg/git/pi-langsrv "if present") | **F1** — don't assume named external skills exist |
| Cost tier quoted in Phase 0, context-window segmentation guidance front-loaded | **F6** — nuwa buries this in a failure table; default standard tier is the one that blows windows |
| Triple-verification with exclusivity emphasized as anti-bloat | **S2** + SOFTWARE-DISTILLATION-DEEP-DIVE §D |
| Honest boundaries ≥3 + `distilled:` staleness date mandatory | **S3** + software staleness anchor |
| Fallback tree + anti-example blacklist required in output | **S5** |
| Contradictions preserved (≥2 tensions, never flattened) | **S7** |
| **The F2' third inference category** ("in-field-but-never-addressed → flag as inference") in the Agentic Protocol | **f2-experiment finding** — the empirical result; this is the single most important addition over nuwa |
| Phase 4 mandates a **NOVEL in-domain edge question** not covered by research files | **F2'/f2-experiment** — nuwa's edge questions sat too close to documented material; that's why its 97/100 didn't reproduce (got 71-72) |
| Scorer MAY read the skill file (kept nuwa's design) | **F2 REFUTED** — experiment showed skill-file access does NOT inflate scores (71 vs 72 converged); so the "blind scoring" fix proposed earlier is dropped |
| Operational scripts wired INTO the Agentic Protocol Step 2 | **F13** — mrbeast scripts were orphaned showpieces |
| Engine embeds methodology inline (self-contained) | **F9** — nuwa's engine depends on its own references/ at runtime; outputs are portable but the engine isn't |
| Three flavors (person / topic / software) with pointers | x-mastery-mentor (topic works, S8/S9/S10) + SOFTWARE-DISTILLATION-DEEP-DIVE |

## What was deliberately NOT copied from nuwa
- Keyword-stuffed descriptions (F4) → pi triggers list instead.
- The published 97/100 fidelity scores as ground truth (F2') → re-run on novel edge questions.
- Chinese-source blacklist as a *universal* rule (F11) → scoped to "Chinese figures only, quality reason".
- Default = the expensive standard tier in one session (F6) → segmentation front-loaded.

## Known gaps in this port (honest) — status after the gap-closing pass

- ✅ **F2' validation — CLOSED.** Ran the experiment on 2 more nuwa skills (ilya, munger): published 94/97 → blind 76/67; edge-honesty 20→13/7. F2' generalizes at n=3. Refined mechanism: **framework-answerable** novel edges are the drift zone; fact-demanding edges give false passes. See `source/f2-experiment/validation-conclusion.md`. The skill's F2' rule + Phase 4 now specifically require a framework-answerable edge.
- ✅ **Phase 4 automation + reproducibility test — CLOSED.** Shipped `scripts/fidelity_eval.py` (stdlib-only): `validate` (spec must have 3 known + 1 framework-answerable edge + ground-truth + edge-note) · `runbook` (emits runtime-agnostic answerer+scorer prompts) · `parse` (5-dim scorecard → grade, with the F2' edge-honesty gate: edge <14 = NO-SHIP regardless of total) · `repro` (Jaccard/name-overlap on mental models, <60% = non-reproducible). Tested against all 3 experiment scorecards + self/diff-persona repro.
- ⚠️ **All 3 nuwa skills grade NO-SHIP** under the validated gate (karpathy edge 6, ilya 13, munger 7 — all <14). Strong confirmation the gate catches what it should: none of nuwa's published skills reliably flag framework-derived inference on novel in-domain questions.
- 🔲 **No operational DNA script shipped yet.** The engine is methodology; a software-flavor distillation should add per-target `scripts/<persona>_dna.py` (per the mrbeast pattern / F13 — wired into the Agentic Protocol, not orphaned). Build per-target.
- 🔲 **Topic-flavor user-data persistence** (S9) referenced but not implemented — add when building a stateful topic skill.
- 🔲 **pi-crew specialization adapter** not written — the base is runtime-agnostic by design; a `distill-persona-pi-crew` specialization would pin `team action='parallel'` + pi skill-dirs + pi-langsrv. Defer until the base is battle-tested.

## Suggested next slices (in priority order)
1. **Scale F2' validation** to 5+ skills × 3-5 framework-answerable edges each, via `fidelity_eval.py runbook`. The harness makes this cheap. Confirms the 60% repro floor and the edge-honesty gate are calibrated.
2. **Build `distill-software`** as a sibling (the SOFTWARE-DISTILLATION-DEEP-DIVE playbook, pi-langsrv-native; ships a `<engineer>_dna.py` code-Expression-DNA script wired into its Agentic Protocol).
3. **Write the pi-crew specialization adapter** (pins the runtime; reuses the validated base unchanged).
4. **Implement topic-flavor user-data persistence** (S9) when the first topic-skill use case appears.
