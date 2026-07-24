---
name: distill
description: Adapter for distill-persona/distill-software — orchestrates the full distillation pipeline as one command. Parallel research → merge → triple-verify → verify-prune(V1-V5) → build → fidelity. **Run with team='implementation'** (needs explorer/analyst/planner/critic/executor/verifier roles; the default team lacks analyst+critic). Pass the target in {goal} (e.g. "distill Karpathy persona" / "distill oh-my-pi codebase conventions" / "distill the field of perf-debugging").
topology: complex-dag
---

<!--
  This workflow is the pi-crew ADAPTER for the distill-* skills. It bakes the
  methodology (distill-persona / distill-software) into enforced orchestration:
  parallel research, an INDEPENDENT fresh-context verifier (the F2' independence
  fix), and the V1-V5 extraction gate. Every step loads the relevant distill
  skill for methodology; the workflow enforces structure + independence.

  Flavor is chosen in {goal}: "persona"/"person" → distill-persona (6 streams);
  "codebase"/"software"/"engineer" → distill-software (6+extra streams + code-DNA);
  "field"/"topic" → distill-persona topic variant. Detect from {goal}; if unclear,
  default to person.
-->

## phase0-route
role: planner
output: distill-plan.md

Read the distill skill matching {goal}'s flavor (distill-persona for person/field, distill-software for codebase/engineer). Determine: flavor, target, `language`+`distilled_against` (software) or research-date (person), cost tier, and the output skill dir. Create the skill dir + `references/research/`. Write a one-paragraph run plan (flavor, target, staleness anchors, tier, coverage manifest approach) to distill-plan.md. Do NOT research yet — just route + scaffold.

## research-1
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/01-writings.md

Stream 1 — **writings/docs**: for person → books/essays/papers/newsletters; for software → design docs/ADRs/RFCs/READMEs/commit messages. Follow the distill skill's stream-1 spec. Write findings (with sources + credibility) to `<skill-dir>/references/research/01-writings.md`. Research not persisted = not done.

**W5 fix — WRITE ACCESS CLARIFICATION**: You CAN and SHOULD write your findings to `<output-dir>/references/research/0N-<stream>.md` (the run artifacts dir, NOT the target project). The READ-ONLY restriction applies to the TARGET codebase (don't edit the project being learned from). If the output dir doesn't exist, `mkdir -p` it first. Do NOT emit your full output as TEXT in your result message — write to the file directly. The previous run's Stream 2 + Stream 4 deferred file writes and emitted TEXT, forcing a downstream worker to re-save — avoid that.

## research-2
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/02-conversations.md

Stream 2 — **conversations/discourse**: person → podcasts/AMAs/interviews (stance-change moments, refusals); software → code-review comments/PR threads/incident retros. Write to `references/research/02-conversations.md`.

## research-3
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/03-expression-dna.md

Stream 3 — **expression/DNA**: person → prose expression-DNA (sentence length, analogy density, certainty spectrum, 口癖); software → CODE Expression-DNA (run `code_dna.py` if software flavor; naming/function-length/comment/error-handling/type-strictness). Write to `references/research/03-expression-dna.md`.

## research-4
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/04-external-views.md

Stream 4 — **critics/failures**: person → biography/criticism/peer-contrast; software → postmortems/bug reports/dep CVEs/arch-review. Write to `references/research/04-external-views.md`.

## research-5
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/05-decisions.md

Stream 5 — **decisions** (where mental models live): person → major life/career decisions + say-vs-do gaps; software → ADRs/tradeoff records/"why X over Y" in commits+PRs (mine with `git log --grep`). Write to `references/research/05-decisions.md`.

## research-6
role: explorer
parallelGroup: research
dependsOn: phase0-route
output: research/06-timeline.md

Stream 6 — **timeline**: person → chronology + last 12 months (anti-staleness); software → `git log` IS the timeline (architecture evolution, what's actively changing). Write to `references/research/06-timeline.md`. For software flavor, ALSO sweep the extra streams (tests-as-invariants, CI/lint, dep manifests, release-pipeline, risk-posture, concurrency, platform-hardening) — fold each into the matching research file or add `07-extra.md`.

## merge
role: analyst
dependsOn: research-1, research-2, research-3, research-4, research-5, research-6
output: research-coverage.md

Read all 6 (or 7) research files. Produce the Phase 1.5 coverage table: streams × source-count × key-findings × contradictions × gaps. **Surface contradictions explicitly — do NOT average them into false consensus** (contradiction-as-signal). Flag any stream with thin coverage. Write to `references/research-coverage.md`.

## synthesize
role: planner
dependsOn: merge
output: models.md

Read the research files + coverage. List all candidate claims (usually 15-30). Apply **triple-verification** to each (cross-domain/module recurrence + generative + exclusive): all-3 → mental model (3-7); 1-2 → decision heuristic (5-10); 0 → discard. The exclusivity test is the anti-bloat weapon (kills "use version control" generic advice). Extract expression-DNA, values+anti-patterns, ≥2 preserved inner tensions, intellectual lineage, ≥3 honest boundaries + staleness date. Write the model set to `references/models.md`.

**W4 fix — target-equivalent check**: Before proposing any model that implies "create new file/module/helper" in the target, you MUST grep the target codebase for an existing equivalent (e.g. `rg -l "errorMessage|toErrorMessage" <target>/src/` for an error-message helper claim). The oh-my-pi→pi-crew run's H11 said "create `src/runtime/error-message.ts`" but the helper already existed at `src/utils/guards.ts:96` — would have shipped a duplicate. Any "create" claim without a grep-confirmed absence in target is **OVERSTATED** — re-frame as "adopt existing X at target:file:line" or remove.

## verify-prune
role: critic
dependsOn: synthesize

**Fresh-context extraction verification (V1-V5)** — do NOT trust the synthesis at face value. Apply to every candidate model: V1 signal (method/principle, not persona-content/quirk — flag quirk-vs-principle ⚠️); V2 non-redundant (>70% overlap → merge/drop); V3 effective (changes a real decision?); V4 optimal (simplest form); **V5 factual-accuracy** — every quoted constant/function-name/path/regex/threshold is grep-verified against the actual source (codebase) or the research files (person); cite evidence; reject over-absolute claims. Output the PRUNED model set + reject reasons (audit trail) to `references/verified-models.md`. Over-extraction is worse than under-extraction — default to PRUNE.

## three-filter
role: critic
dependsOn: verify-prune
output: three-filter.md

**Phase 2.5 (new — SELF-UPGRADE DIRECTIVE).** Apply the 3-chiều filter to every KEEP candidate from `verified-models.md`, using `target-analysis.md` as ground truth. For each candidate, walk the 3 dimensions:
1. **RELEVANCE** — relevant to target's domain/scale/context? NO → SKIP.
2. **PRESENCE** — target already has something similar? NO → NECESSITY (does target need it? NO → SKIP, YES → ADOPT). YES → QUALITY COMPARISON: source BETTER → IMPROVE, EQUAL/WORSE → SKIP, COMPLEMENTARY → MERGE.
3. **For each SELECTED** → note adaptation needed for target context (license boundary, toolchain differences, existing patterns to preserve).

Output: per-candidate verdict (SKIP / ADOPT / IMPROVE / MERGE) with target-evidence citations. Write to `references/three-filter.md`. **This is the gate that prevents applying patterns the target already has better.**

## effectiveness-gate
role: critic
dependsOn: three-filter
output: effectiveness-gate.md

**Phase 2.6 (new — MANDATORY pre-apply gate).** For every SELECTED candidate from `three-filter.md`, run the EFFECTIVENESS VERIFICATION — SELECTED ≠ TO-APPLY. Each SELECTED must prove it's effective FOR THIS TARGET:
a. **CONCRETE DELTA** — exactly what changes in the target? (1-line: "AGENTS.md +rule X" / "lint +rule Y" / "src/runtime/new-file.ts +function Z")
b. **EFFECTIVENESS PROOF** (≥1 of): GENERATIVE (changes a real decision/answer/behavior? name the case), PROBLEM-EXISTS (target has a problem this solves? grep/test/convention-gap evidence), DELTA-TEST (apply in isolation → measure improvement on 1 target case)
c. **CONFLICT CHECK** — conflicts with target's existing practice? resolve or downgrade
d. **VERDICT**: ✅ EFFECTIVENESS-VERIFIED → TO-APPLY, or ❌ REJECTED → log reason (rejection goes to APPLY-LOG)

Output: per-candidate verdict with concrete delta + proof + conflict check. Write to `references/effectiveness-gate.md`. **Only TO-APPLY items enter Phase 3.** This is the analog of V1-V4 (which verify MODEL effective at extract) applied to APPLY (which verifies apply effective at integrate) — same rigor, different stage.

## plan-application
role: planner
dependsOn: effectiveness-gate
output: apply-plan.md

**Phase 3 (new).** For each TO-APPLY item from `effectiveness-gate.md`, produce a concrete apply plan:
- **HOW to apply**: AGENTS.md edit, lint rule add, src/ pattern adopt, CONTRIBUTING.md update, scripts/ operational script, or skill in target's skills/ dir
- **Exact file:line target** in the target project
- **Tier priority**: Tier 1 (high V3, low V4 cost) → Tier 2 (high V3, medium V4 cost) → Tier 3 (high V3, high V4 cost — pilot first)
- **Verification gate per item**: `npm run test:critical` + `npm run typecheck` + `npm run build:bundle` must pass after each apply; bundle MD5 must match or be updated; if tests fail → rollback

Write to `references/apply-plan.md`. This is the input for the executor in Phase 4.

## apply
role: executor
dependsOn: plan-application
output: applied-changes.md

**Phase 4 (new — THE KEY DELIVERABLE).** Read `apply-plan.md`. For each TO-APPLY item, in tier order (Tier 1 first), apply the concrete delta to the target project. **The apply MUST happen here, not be deferred to a "downstream worker"** (this was W1's root cause in the oh-my-pi→pi-crew run — the build phase deferred apply and hung).

Per-item protocol:
1. Edit the target file(s) as specified in apply-plan.md
2. Run verification gate: `npm run test:critical` (or equivalent) + `npm run typecheck` + `npm run build:bundle`
3. Capture before/after diff + bundle MD5 (before/after)
4. If any gate fails → rollback the change (git checkout the file), log REJECTED in APPLY-LOG, continue with next item
5. If passes → log APPLIED in APPLY-LOG with file:line

**Anti-loop guard (W2 fix)**: this task has a hard tool-call budget of 50 tool calls and a wall-clock timeout of 15 minutes. If you hit either, STOP and write a partial APPLY-LOG with what was completed + what's remaining. Do NOT re-verify completed items.

Write per-item results to `references/applied-changes.md` AND append to `APPLY-LOG.md` in the target project (or the run's APPLY-LOG location).

## verify-target-improved
role: verifier
dependsOn: apply
verify: true

**Phase 5 (new — Darwin ratchet).** The output of a distillation is NOT "has skill" — it's "target improved." Read `applied-changes.md` + the target project's git diff. For each APPLIED item, re-verify:
- Does the change actually improve the target? (concrete, measurable — e.g. "new helper reduces 18 sites to 1 import"; not vibes)
- Do the tests still pass? (`npm run test:critical`)
- Did the bundle MD5 change as expected? (intentional change OK; unexpected change → flag)
- Is the change consistent with target's existing style/conventions? (no foreign code injected)

Output: per-item verdict (IMPROVED / NEUTRAL / REGRESSED) + recommendation (KEEP / ROLLBACK). If any REGRESSED → flag for rollback. Write to `references/target-improvement.md`.

**Ship-gate**: ≥3 items APPLIED + verified IMPROVED → PASS. Otherwise → FAIL with the gap.

## build
role: executor
dependsOn: verify-prune
output: SKILL.md

Read `verified-models.md`. Render the output `<target>-perspective` (person) or `<target>-conventions` (codebase) SKILL.md from the distill skill's template. MUST include: staleness anchors (language+distilled_against for software), the Agentic Protocol (research-before-answer, Step-2 dims DERIVED from the models, F2' third-category rule), the verified models (each with evidence+limitation), expression/code-DNA, ≥3 honest boundaries, sources. For software flavor: wire operational scripts INTO the Agentic Protocol (F13), run `code_dna.py`. Write the SKILL.md into the skill dir.

**Anti-loop guard (W2 fix)**: After writing SKILL.md (and FIDELITY.md if fidelity is your job), output `DONE` and stop immediately. Do NOT re-verify, re-read, or re-grep completed files. Hard limits: ≤30 tool calls total, ≤10 min wall-clock. The oh-my-pi→pi-crew run had 11_build loop 14+ times in a verification loop (re-read SKILL.md, re-check claims, re-grep source) and never converged. If you hit either limit, stop and write whatever you've completed.

## fidelity
role: verifier
dependsOn: build
verify: true

**Independent fresh-context fidelity check** (the F2' fix — this verifier has NOT seen the synthesis/build reasoning; it reads only the built SKILL.md + ground truth). For person: pose 3 known-stance + 1 NOVEL framework-answerable edge question; score stance-consistency + style + edge-honesty (must flag inference, not fabricate). For codebase: pose a novel "how would this codebase handle X new scenario" question; verify the skill's models give complete consistent guidance + that every factual claim still grep-matches source (V5 re-check). Gate: edge-honesty/accuracy failure = NO-SHIP (return FAIL with the specific failure + which model/claim broke). On PASS, confirm the skill is installable + self-contained. Write the fidelity report to `references/fidelity.md`.
