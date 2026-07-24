# Session Handoff Protocol (research)

> Self-contained reference for resuming a multi-session research run (M#5 — adapted from Geek's handoff-format.md, trimmed to what a research run actually needs). A long research loop can exceed 500k tokens, so sessions segment and resume from state files. This is the *contract* that makes a cold resume lossless.

## When to write a handoff
- The session is about to end (context near budget) AND the run is not finished.
- **Skip** when the run fits one session, or will not outlive a single compaction.

## The handoff artifact — `references/handoff-N.md`
Write one file per resume boundary. Structured and skim-readable:

```
# Handoff N — <topic>
date: YYYY-MM-DD · phase reached: Step X · session: M of K

## Goal (1 sentence)
<the research question + scope + budget tier>

## Coverage-manifest state
- COVERED: <count> facets/sub-questions (link coverage manifest)
- UNFETCHABLE: <count> facets — reason for each
- Next batch: <list the next sub-question to investigate>

## What's been tried (numbered)
1. <iteration mode + query + what it produced — link references/research/0N-*.md>

## What's blocked (numbered)
1. <blocker — e.g. source paywalled, API quota exhausted — + what unblocks it>

## Next-action list (numbered, ordered)
1. <the very next step: which UNCOVERED facet + which iteration mode>

## State files (paths INSIDE the skill dir)
- references/research/0N-*.md  (persisted findings — the real checkpoint)
- log.jsonl equivalent  (iteration events: breadth/depth/refinement per round)
- coverage-manifest.md  (every facet COVERED / UNFETCHABLE)
- DISTILLATION-PROCESS-CHECKLIST.md  (phase progress + deep-dive round log)
```

## Rules
- **State files are the checkpoint, the handoff is the index.** Each step already persists to disk (M#3: state-on-disk beats state-in-context); the handoff just points a fresh session at the right files + states the next action.
- Be concrete in next-action: name the sub-question + iteration mode + the exact file to read first. "continue" is a useless handoff.
- Log each round's yield in the process-checklist round log (not here) — the handoff links to it.
- Number handoff files sequentially (`handoff-1.md`, `handoff-2.md`) so the resume order is unambiguous.
- Record tensions discovered (H#9) so the resume agent does not re-litigate settled disagreements.

## Degraded mode
When a structured handoff cannot be written (crash, hard kill), fall back to a single paragraph: goal + last step reached + the coverage-manifest file to read first. A 1-paragraph fallback beats no handoff, but is upper-bound lossy (details may be lost) — re-verify state on resume.
