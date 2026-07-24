# Anti-patterns — research skill (extended catalog)

> 12 anti-patterns distilled from the 4 sources. Diagnostic + prescriptive. Self-test: does the skill exhibit any of these right now?

---

## A1 — One omnibus run for a sprawling topic

**Symptom**: a single sweep of ≥5 sources yields a "complete" report that misses nuances and overclaims consensus.

**Why wrong**: skim/hallucination; depth budget spread thin; nothing verified.

**Corrective**: decompose by sub-domain; each sub-domain gets its own coverage manifest + 3-empty-rounds gate; merge.

**Source**: distill-persona Core Principle #6 (decompose large targets).

---

## A2 — State-on-disk skipped because "we'll just remember"

**Symptom**: no `.auto/log.jsonl` or `.auto/prompt.md` exists at compaction time; the resume agent starts from scratch.

**Why wrong**: lost on context reset; resume agent has no advantage over a fresh agent.

**Corrective**: always write the 2 files before any compaction. Even on a "quick" run, the cost of writing is < 1% of the cost of recovery.

**Source**: pi-autoresearch `README.md:194-200` (M#3).

---

## A3 — Iteration mode silent

**Symptom**: the agent switches breadth↔depth↔refinement without logging; thrash increases.

**Why wrong**: thrash is the #1 cause of OOM / overrun / low-quality output. The user can't see why the agent is stuck.

**Corrective**: choose mode explicitly in Step 1; record in `log.jsonl`; visible in `code_dna` axis 6.

**Source**: synthesis (M#2).

---

## A4 — Citations from memory

**Symptom**: plausible-but-wrong URLs; cite GitHub URLs that don't exist; `verify_citations.py` fails.

**Why wrong**: a citation without verification is a hallucination. The user may follow the link.

**Corrective**: only cite URLs that are in the running source list; resolve via `WebFetch` HEAD before citing.

**Source**: synthesis (cross-source).

---

## A5 — Tensions papered over

**Symptom**: out-of-scope disagreements noted in a footnote; user never sees them.

**Why wrong**: the most interesting findings are the disagreements. Hiding them is hiding the value.

**Corrective**: each tension has its own top-level section; 3 probes (pairwise / source-class / evidence-quality).

**Source**: Geek `tension-discovery.md` (H#9).

---

## A6 — Cost hidden

**Symptom**: user can't decide whether to continue; budget surprises at finalize.

**Why wrong**: cost is real; the user has a budget. Without per-call cost, the user can't budget.

**Corrective**: every API call shows cost; `emit_run_summary.py` at run-end.

**Source**: x-research `x-search.ts:152-209` (H#8).

---

## A7 — Validator orphaned

**Symptom**: validators exist but never run; skill ships with bug.

**Why wrong**: a validator is only useful if it actually runs. A static doc saying "validate before shipping" is useless.

**Corrective**: wire into Step 2 (verify_citations, source_evaluator) and Step 4 (final-check); never "check before shipping".

**Source**: distill-software F13 (orphaned-scripts lesson).

---

## A8 — Scripts in a tools table never invoked

**Symptom**: skill has a script index but the agent never finds them.

**Why wrong**: the F13 lesson (mrbeast orphan) — if the script isn't in the Agentic Protocol, the agent won't find it.

**Corrective**: every script named in the Agentic Protocol has a `bash` invocation at the named step.

**Source**: distill-software F13.

---

## A9 — Single-source topic skill

**Symptom**: one perspective dominates; no cross-verification.

**Why wrong**: one-source bias; the user is sold a single viewpoint.

**Corrective**: topic skills cite ≥3 independent sources; source-class diversity audited.

**Source**: synthesis (M#1).

---

## A10 — Honest boundaries as a checklist

**Symptom**: boundaries listed but never actually checked.

**Why wrong**: a boundary that doesn't fire is a fiction. The F2' finding is that *vocal* boundaries (e.g. "I won't cite from memory") don't always fire under novel edge.

**Corrective**: boundaries surface in the report (e.g. "Stale claw: 14% of sources ≥ 365 days old"). The boundary becomes a measured metric.

**Source**: distill-software M-F4 (over-claims fidelity).

---

## A11 — Thin evidence re-run silently

**Symptom**: agent re-runs the same query when evidence is thin; user pays again.

**Why wrong**: the honest move is to **flag the thinness**, not silently re-run. The original Geek=evidence-accumulation leg was V5-rejected for this reason.

**Corrective**: honest thin-evidence flag in the report + cost-justified re-run only with user approval.

**Source**: synthesis (V5-rejection of Geek leg).

---

## A12 — Mono-mode publish

**Symptom**: skill only works for one platform (X / one GitHub repo).

**Why wrong**: mono-mode is a taxonomy failure — the field's strength is *generalization*. Topic skills should be platform-agnostic.

**Corrective**: generalize — input is a topic + sources; any source class is fine; output schema is platform-agnostic.

**Source**: synthesis.

---

## Self-test (does the skill exhibit any of these?)

Run before shipping:

```bash
# A2: state-on-disk compliance
ls .auto/log.jsonl .auto/prompt.md 2>/dev/null | wc -l  # expect ≥ 2

# A3: iteration mode declared
grep -E "iteration.mode|breadth|depth|refinement" log.jsonl | wc -l  # expect ≥ 3

# A4: citations only from source pool
python3 scripts/verify_citations.py $DRAFT_REPORT $SOURCES_JSON  # exit 0

# A6: cost transparency
grep -E "cost|fee|\\\$" $OUTPUT  # expect ≥ 1

# A7: validators wired
grep -E "verify_citations|source_evaluator|emit_run_summary|code_dna" SKILL.md | wc -l  # expect ≥ 4

# A8: scripts in tools table — count references vs orphans
grep -E "scripts?/" SKILL.md | wc -l  # expect ≥ 4

# A9: source diversity
python3 -c "import json; d=json.load(open('$SOURCES_JSON')); print(len(set(s['url'].split('/')[2] for s in d['sources'])))"  # expect ≥ 3

# A10: boundaries in output
grep -E "thin|stale|\\bboundary\\b" $OUTPUT  # expect ≥ 1

# A12: mono-mode
echo "platform dependencies:"; grep -E "twitter|x\.com|github\.com" SKILL.md | wc -l  # expect 0 (or count = scope)
```

If any of these fails, the skill exhibits the anti-pattern. Fix before shipping.
