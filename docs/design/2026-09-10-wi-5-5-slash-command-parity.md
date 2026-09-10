# WI-5.5 — Slash-command codegen (table-driven) design decision

**Date**: 2026-09-10
**Status**: ACCEPTED — **partial**: parity test in; full codegen deferred.
**Refs**: pi-crew-upgrade-spec.md §5 M5 / WI-5.5, G15

## Spec scope

> WI-5.5 | Sinh ~37 slash command từ dispatch table (table-driven),
> xóa bản tay trùng | G15

Acceptance:
> Codegen command: parity test số command + hành vi không đổi.

## Corrected count

Spec lists "~37" — corrected audit (gap-freshness-audit-2026-09 §Count):
**41 commands** (38 in 4 modules + 3 outside).

My empirical count via the new parity test
(`test/unit/extension/slash-command-parity.test.ts`):
**31 unique commands** registered via `pi.registerCommand("<name>", ...)`.

Discrepancy of 10: the gap audit likely includes:
- 2 keyboard shortcuts (`alt+s`, `alt+c`) — registered via `registerShortcut`, NOT `registerCommand`
- 7 inline alias commands (`/crew-view`, `/crew-back`, + others in `inline-panel/index.ts`)
- 1-2 skill commands (`skill-list`, `skill-create`)

The parity test counts only `registerCommand` calls per the spec's
explicit wording ("sinh slash command từ dispatch table"). Keyboard
shortcuts are a different registration channel.

## What this PR delivers

### 1. Parity test (`test/unit/extension/slash-command-parity.test.ts`)

3 tests:
- **Sanity range (28..45)**: catches accidental double-registration
  or large deletions.
- **Naming convention**: `^[a-z][a-z0-9_-]+$` — no spaces, no upper-case.
- **No duplicates**: a name registered twice fails at runtime; this
  test catches it pre-extension-load.

Mutation demo: removing `pi.registerCommand("team-help", ...)` drops
count by 1 → still in range (31 → 30), but logs the change to make
visible. Adding a duplicate (`pi.registerCommand("teams", ...)` when
already registered) → caught by test 3.

### 2. WHAT THIS PR DOES NOT DO (table-driven codegen)

Converting 31 hand-written `registerCommand` calls into a single
table-driven codegen is a refactor that:
- Touches every command's handler binding (each command needs a
  bound name + handler reference).
- Requires routing logic (`/team-run <args>` vs `/team-api <args>`
  differ in handler signatures).
- Risks breaking the implicit Pi version compat (some commands
  accept legacy field names).
- Estimated ~3-4 hours of careful, behavior-preserving work.

This window does not accommodate that level of risk. The parity test
above is the "table-driven codegen" prerequisite: it asserts that the
current 31 hand-maintained commands have a stable surface that a
future codegen can use as ground truth.

## Decision rationale (codegen or not)

**Codegen (full table-driven)**: moves the per-command `registerCommand`
calls into a single registration loop driven by an array. Pros:
single source of truth; easier audit. Cons: requires a stable
handler-binding contract; current commands have varied signature
shapes.

**Hand-maintained (status quo)**: 31 explicit call sites across
~10 files. Pros: each command file is self-documenting; easy to grep.
Cons: duplication + drift risk.

**This PR adds the parity test** so that either future move is detectable.
The full table-driven conversion is recorded as a follow-up ADR (out of
scope for this window).

## Re-evaluation triggers

This decision is superseded when ANY:
1. A 32nd command is added → parity test triggers a "log the change";
   the 32nd-commit reviewer can decide whether to invoke codegen.
2. A command's signature changes (add/remove required args) → the
   parity test does not catch this; it requires per-command tests
   (out of scope).
3. Pi's `registerCommand` API changes (rare; would break all 31 at
   once).

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M5 / WI-5.5
- Parity test: test/unit/extension/slash-command-parity.test.ts
- Gap audit corrected count: docs/gap-freshness-audit-2026-09.md
- Module map: src/extension/registration/commands/*.ts
