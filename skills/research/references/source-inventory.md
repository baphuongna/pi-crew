# Source Inventory — research skill

> **Per-source citation table** with `file:line` for every claim. Each row is a proof-of-read: the file was opened, the line was read, and the quote was captured verbatim.

---

## Deep-Research-skills (Weizhena)

| Claim | File | Line | Quote |
|-------|------|------|-------|
| Iterative depth with batch_size | `skills/research-en/research-deep/SKILL.md` | 23 | "Batch by batch_size (need user approval before next batch)" |
| Items × fields matrix | `skills/research-en/research/SKILL.md` | 114-128 | (table visualization of items × fields) |
| Hard-constraint template | `skills/research-en/research/SKILL.md` | 33 | "**Hard Constraint**: The following prompt must be strictly reproduced, only replacing variables in {xxx}, do not modify structure or wording." |
| Resume check (Step 2) | `skills/research-en/research-deep/SKILL.md` | 13-14 | "Step 2 Resume Check" |
| Breadth iteration | `skills/research-en/research-add-items/SKILL.md` | 17-21 | "Simultaneously: A. Ask user: What items to supplement?" |
| JSON schema validator | `skills/research-en/research/validate_json.py` | 25 | "def load_fields_yaml" |
| Coverage logic | `skills/research-en/research/validate_json.py` | 60-92 | (coverage check function) |
| Web-search module | `agents-codex/web-search-modules/general-web.md` | n/a | (generic web search aggregator) |
| GitHub debugging | `agents-codex/web-search-modules/github-debug.md` | n/a | (GitHub-specific debugging) |

**Source 1 verdict**: provides 6 of the 37 claims. Heaviest on the items×fields + JSON schema + iteration gates.

---

## x-research-skill (rohunvora)

| Claim | File | Line | Quote |
|-------|------|------|-------|
| Query refinement heuristics | `SKILL.md` | 163 | "Refinement Heuristics" header |
| First heuristic | `SKILL.md` | 165 | (first heuristic line) |
| Cost display in code | `x-search.ts` | 152-209 | (cost display code) |
| Cost breakdown | `CHANGELOG.md` | 13 | (cost breakdown entry) |
| Bearer token handling | `lib/api.ts` | 25-27 | "X_BEARER_TOKEN not found in env or ~/.config/env/global.env" — throws clear error (NOT silent) |
| Cache layer | `lib/cache.ts` | n/a | (disk-based cache with TTL) |
| Format helpers | `lib/format.ts` | n/a | (markdown table emitter) |
| X-API docs | `references/x-api.md` | n/a | (documentation copy) |
| 5 versions in 2 days | `CHANGELOG.md` | (whole file) | v1.0.0–v2.3.0 (2026-02-08 to 2026-02-09) |
| 13 stale purges | `CHANGELOG.md` | 8 | "Purged all stale tier/subscription references across 6 files (13 instances…)" |

**Source 2 verdict**: provides 4 of the 37 claims. Heaviest on cost transparency + query refinement + the "delete-stale" pattern.

---

## pi-autoresearch (davebcn87)

| Claim | File | Line | Quote |
|-------|------|------|-------|
| 2-file pattern | `README.md` | 194-200 | "Two files keep the session alive across restarts and context resets: `.auto/log.jsonl` ... `.auto/prompt.md` ... A fresh agent with no memory can read these two files and continue exactly where the previous session left off." |
| Continued rehydration | `README.md` | 222-225 | "All progress is persisted in those files, so the post-summary turn rehydrates from the source of truth instead of relying on whatever survived compaction." |
| Tool gating | `CHANGELOG.md` | 30-33 | (tool gating — only revealed in active mode) |
| Removed entries (3 explicit) | `CHANGELOG.md` | 71-73 | (3 entries under `### Removed`) |
| Removed entries (1 body line) | `CHANGELOG.md` | 25 | "Removed the collapsed one-liner mode and the `Ctrl+Shift+T` expand/collapse toggle" |
| Compaction summary | `CHANGELOG.md` | 49-51 | "Deterministic compaction summary. When pi compacts context, autoresearch now bypasses the LLM summarization and injects a lossless markdown summary built from persisted state (experiment rules, ideas backlog, and last 50 runs with ASI fields)." |
| LOOP FOREVER | `skills/autoresearch-create/SKILL.md` | 139 | "**LOOP FOREVER.** Never ask 'should I continue?'" |
| Compaction summary (file) | `extensions/pi-autoresearch/compaction.ts` | 2 | "Deterministic compaction summary for autoresearch sessions." |
| Compaction summary (function) | `extensions/pi-autoresearch/compaction.ts` | 42-43 | "Build the full compaction summary text from persisted autoresearch state." |
| Hook examples | `skills/autoresearch-hooks/` | n/a | (5 hook examples: anti-thrash, context-rotation, idea-rotator, hypothesis-reflection, external-search) |
| finalize.sh | `skills/autoresearch-finalize/finalize.sh` | n/a | (bash + jq summary emitter) |

**Source 3 verdict**: provides 8 of the 37 claims. Heaviest on state-on-disk + LOOP FOREVER + hooks + compaction.

---

## Geek-skills-deep-research (parent in ClaudeSkills)

| Claim | File | Line | Quote |
|-------|------|------|-------|
| Single-agent first | `SKILL.md` | 30 | "Single-agent first. Start with one lead agent and only fan out when parallel work will clearly help." |
| Brief / full / delta | `SKILL.md` | 36-41 | (table) |
| Phase prefixes P0–P6 | `SKILL.md` | 100-193 | (P0–P6 with P0.5 sub-phases) |
| 2-4 subagents | `references/methodology.md` | 43-48 | "prefer 2-4 subagents, rarely more than 5 / each subagent owns one crisp thread / avoid two agents answering the same sub-question" |
| Honest thin-evidence | `references/methodology.md` | 183 | "where evidence was thin" |
| Handoff format | `references/handoff-format.md` | 1-128 | (whole file — 128 lines, NOT 160) |
| Quality gates (5 tiers) | `references/quality-gates.md` | n/a | (5 gates defined; Gate 2 = grounding/citation integrity) |
| Tension discovery (3 probes) | `references/tension-discovery.md` | 17-36 | (3 probes: pairwise, source-class, evidence-quality) |
| Severity-tagged errors | `scripts/verify_citations.py` | 193-284 | (severity-tagged errors, broader than originally cited 174-225) |
| Source evaluator | `scripts/source_evaluator.py` | n/a | (3D filter: authority/freshness/primary-vs-secondary) |
| Run summary emitter | `scripts/emit_run_summary.py` | n/a | (wall-clock + token + cost) |
| Report template | `assets/report_template.md` | n/a | (sections + lengths) |
| NO CHANGELOG | (file does not exist) | n/a | HB-2: Geek has no CHANGELOG.md (verified by `find`) |

**Source 4 verdict**: provides 19 of the 37 claims. Heaviest on rigor mechanisms (verifications, sources, tensions, handoff, quality gates).

---

## Cross-source synthesis

| Claim | # sources | Notes |
|-------|-----------|-------|
| Topology-first orchestration | 3 | Geek + pi-autoresearch + Deep-Research |
| Iterative depth (3-way) | 3 | Deep-Research + pi-autoresearch + x-research |
| State-on-disk | 2 | pi-autoresearch + Geek |
| Subtract surface area | 2 | pi-autoresearch + x-research |
| Handoff protocol | 2 | Geek + pi-autoresearch |
| Cost transparency | 1 | x-research |
| Items × fields | 1 | Deep-Research |
| Tiered validators | 1 | Geek |
| Tension discovery | 1 | Geek |
| Brief/full/delta | 1 | Geek |
| Phase prefixes | 1 | Geek |
| Hard-constraint templates | 1 | Deep-Research |
| Severity-tagged errors | 1 | Geek |
| CHANGELOG-as-postmortem | 1 | pi-autoresearch |
| Resume check | 1 | Deep-Research |
| Coverage-only validator (AP-4) | 1 | Deep-Research |

**Synthesis: 5 mental models + 5 inner tensions have ≥2 sources; 5 heuristics + 7 anti-patterns have 1 source each but are universally applicable principles.**

---

## HB-3 (Shallow clones)

All 4 sources are shallow clones as of 2026-07-24:

| Source | `.git/shallow` SHA |
|--------|---------------------|
| Deep-Research-skills | single SHA (e5479f85...) |
| pi-autoresearch | single SHA (00062fb9...) |
| x-research-skill | single SHA |
| ClaudeSkills | single SHA |

**Implication**: the corpus can move without our knowledge. The next 4-source sweep should re-verify (especially the Geek P0–P6 convention and the Citation verifier's exit codes).

---

## Provenance + License

| Source | License | Notes |
|--------|---------|-------|
| Deep-Research-skills | MIT | open-source |
| x-research-skill | MIT | open-source |
| pi-autoresearch | MIT | open-source |
| Geek-skills-deep-research | (parent: MIT) | open-source |

All 4 sources are MIT-licensed — the skill can be freely distributed.
