# Session Handoff Protocol (distill-persona)

> Self-contained reference for resuming a multi-session persona/topic distillation (#9 — adapted from Geek's handoff-format.md, trimmed to what a distillation run actually needs). A full standard distillation can exceed 500k tokens, so sessions segment and resume from state files. This is the *contract* that makes a cold resume lossless.

## When to write a handoff
- The session is about to end (context near budget) AND the run is not finished.
- **Skip** when the run fits one session, or will not outlive a single compaction.

## The handoff artifact — `references/handoff-N.md`
Write one file per resume boundary. Keep it structured and skim-readable:

```
# Handoff N — <target>
date: YYYY-MM-DD · phase reached: Phase X · session: M of K

## Goal (1 sentence)
<the distillation goal + flavor + cost tier>

## What's been tried (numbered)
1. <stream/phase + what it produced — link the artifact file>

## What's blocked (numbered)
1. <blocker + what is needed to unblock>

## Next-action list (numbered, ordered)
1. <the very next step a fresh session should take>

## State files (paths INSIDE the skill dir)
- references/research/0X-*.md  (persisted findings — the real checkpoint)
- EXCAVATION-CHECKLIST.md  (what's ✅/⏳/🧠)
- DISTILLATION-PROCESS-CHECKLIST.md  (phase progress + deep-dive round log)
- coverage-manifest.md  (topic/software flavor: what's COVERED/UNCOVERED)
```

## Rules
- **State files are the checkpoint, the handoff is the index.** Each phase already persists to `references/research/`; the handoff just points a fresh session at the right files + states the next action.
- Be concrete in next-action: name the phase + stream + the exact file to read first. "continue" is a useless handoff.
- Log each round's yield in the process-checklist round log (not here) — the handoff links to it.
- Number handoff files sequentially (`handoff-1.md`, `handoff-2.md`) so the resume order is unambiguous.

## Degraded mode
When a structured handoff cannot be written (crash, hard kill), fall back to a single paragraph: goal + last phase reached + the one file to read to resume. A 1-paragraph fallback beats no handoff, but is upper-bound lossy (details may be lost) — re-verify state on resume.
