# Session Handoff Protocol (distill-software)

> Self-contained reference for resuming a multi-session codebase/工程师 distillation (#9 — adapted from Geek's handoff-format.md, trimmed to what a software distillation run actually needs). Large repos (>200 files) routinely exceed a single context window; sessions segment and resume from state files. This is the *contract* that makes a cold resume lossless.

## When to write a handoff
- The session is about to end (context near budget) AND the sweep is not finished.
- **Skip** when the repo fits one session, or will not outlive a single compaction.

## The handoff artifact — `references/handoff-N.md`
Write one file per resume boundary. Structured and skim-readable:

```
# Handoff N — <repo@sha> / <engineer>
date: YYYY-MM-DD · phase reached: Phase X · session: M of K
distilled_against: <repo@sha>  (re-pin on resume — staleness check)

## Goal (1 sentence)
<codebase-conventions / engineer / domain + cost tier>

## Coverage-manifest state
- COVERED: <count> parts (link coverage-manifest.md)
- UNCOVERED: <count> parts — next batch: <list the next dir/package to sweep>
- [UNREADABLE — reason]: <any>

## What's been tried (numbered)
1. <stream/phase + artifact produced — link references/research/0N-*.md>

## What's blocked (numbered)
1. <blocker — e.g. pi-langsrv unavailable, private submodule — + what unblocks it>

## Next-action list (numbered, ordered)
1. <the very next step: which UNCOVERED batch + which lens>

## State files (paths INSIDE the skill dir)
- references/research/0N-*.md
- coverage-manifest.md  (the "miss nothing" contract — resume reads this first)
- DISTILLATION-PROCESS-CHECKLIST.md  (phase progress + deep-dive round log)
```

## Rules
- **The coverage-manifest is the real checkpoint; the handoff is the index.** On resume, read the manifest first to see what's UNCOVERED, then the round log for diminishing-returns state.
- Re-verify `distilled_against` on resume: if the repo moved past the pinned commit, flag staleness before continuing.
- Name the next UNCOVERED batch explicitly. "continue the sweep" is a useless handoff.
- Log each round's yield in the process-checklist round log (not here).

## Degraded mode
When a structured handoff cannot be written (crash, hard kill), fall back to one paragraph: goal + `distilled_against` + last phase + the manifest file to read first. Re-verify coverage on resume (a lost handoff can double-sweep or skip parts — the manifest catches both).
