# Lesson — the memory-shortcut failure mode

**Captured**: 2026-07-24, during dogfood distillation of Kahneman + Andreessen using the upgraded distill-persona.

## What happened
Six parallel `explorer` research agents were dispatched to research Kahneman and Andreessen. The agents' runtime gave them only `read/grep/find/ls` tools — **no WebSearch, no web-article fetch**. Instead of stopping and reporting "I cannot read real sources," every agent silently fell back to **training-data recall** and produced rich, well-structured findings marked `[TRAINING-DATA]` / `[SAID]` (from memory).

The resulting Kahneman + Andreessen skills scored 79-81/100 on the FIDELITY rubric and passed `validate-skill-structure` 21/21 ALL-GREEN. They looked ship-ready.

## Why it's a failure
- The skills are **upper bounds of the model's prior**, not excavations of the two people.
- Quotes are paraphrased from memory; URLs are unverified; the Manifesto text was never fetched.
- A user activating these skills would get "Kahneman as the model remembers him," not "Kahneman excavated from his actual works."
- **The scores hid the problem.** High fidelity + green validator gave no signal that the input was memory, not sources. The failure was invisible without the excavation-ratio gate (now added).

## Root cause
- `explorer` agents in this runtime are **read-only** (no fetch). Dispatching them for web-research on public figures was a category error — they have no way to read the person's actual works.
- The skill said "use WebSearch + web fetch" but never **verified the agent had those tools**, nor **forbade the memory fallback**. The agents optimized for "produce output" over "refuse when I can't do it properly."

## Fix (now in the skill — Phase 1 Excavation Protocol + ship-gate)
1. **Fetch, don't recall.** Every finding must cite a source the agent ACTUALLY fetched. If agents lack fetch tools → STOP, tell the user "this would be a memory-recap, not a distillation."
2. **Tag unfetched** findings `[MEMORY — unfetched]`; count the ratio.
3. **Ship-gate**: refuse ship-grade if `[MEMORY]` ratio >30%.
4. **Chunking**: large corpora split into shards, one agent per shard, each reading its shard for real.

## How to redo Kahneman/Andreessen properly (when fetch-capable agents exist)
- Writings stream: shard TFS into chapters → one agent per ~3 chapters reads the actual book text → findings per shard → merge. Same for the Manifesto (fetch real text, don't recall).
- Conversations: fetch ≥10 real transcripts (Lex Fridman, Conversations with Tyler, etc.) sampled across career.
- Decisions: dated list, each with fetched article/interview.
- Only then is the skill a distillation; until then it stays `[PROVISIONAL — memory-based]`.

## Generalizable lesson
**Tool capability ≠ assumed.** A methodology that says "read sources" is empty unless it (a) verifies the executor CAN read sources, (b) tags what wasn't actually read, and (c) refuses to ship when too much is unfetched. This applies beyond web research: any step that depends on a capability the runtime may not provide needs a detect-and-degrade-or-stop guard, not a silent fallback to the model's prior.
