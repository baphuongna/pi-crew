# R1-B — nuwa operational scripts (exhaustive sweep)

Read quality_check.py, merge_research.py, srt_to_transcript.py, download_subtitles.sh, community_check.py, community-pr-check.yml.

## 🔴 KEY FINDING — quality_check.py is an INCOMPLETE Phase-4 gate (strengthens M-F4)
quality_check.py checks 6 STRUCTURAL criteria via regex:
1. mental-model count 3-7 (`^### (模型|Model|心智模型)\d`)
2. limitations keyword present
3. expression-DNA section + ≥3 style markers
4. honest-boundary section + ≥3 list items
5. ≥2 tension/contradiction markers
6. primary-source ratio >50%

**It does NOT check the behavioral dimensions** (stance-consistency, edge-honesty, voice) — those need spawned agents (fidelity_eval.py). **A skill can pass quality_check.py 6/6 and STILL fail F2' edge-honesty.** → automated structural gate gives false confidence. Strengthens M-F4: never trust a structural-only pass; require the behavioral framework-answerable-edge test.

## NEW technique — contradiction-as-signal (merge_research.py)
Phase 1.5 synthesis detects cross-agent contradictions (markers `矛盾|相反|但实际上|然而.*?不同|争议`, capped 5) and surfaces them for human adjudication rather than averaging. Encodes "disagreement between research dimensions is a signal, not noise." (A technique, not a field model — note in Phase 1.5.)

## NEW — source-type quality hierarchy (download_subtitles.sh)
4-tier cascade: ZH-manual > EN-manual > ZH-auto > EN-auto. Encodes an implicit source-credibility ranking (manual>auto, source-language>translated). Formalizable as a primary-source-language-preference heuristic.

## dissemination-layer dual gate (community_check.py) — operationalizes M-F1/M-F4
Community submission admission requires BOTH: (a) honest-boundary section exists, AND (b) FIDELITY.md score ≥70. PR must touch ONLY COMMUNITY.md (scope gate). Checkout always from main, never PR branch (security: never executes contributor code). This is the index-layer enforcement of the field-over-claims + honest-boundaries gates.

## ingestion layer (srt_to_transcript.py)
Temporal paragraph-boundary detection (emit paragraph at >200 chars or sentence-end) — preserves rhetorical structure, doesn't flatten to word-soup.
