# ADR-6 — Minimal spec system: SpecRecord, evidence footers, strict-mode machine checks

- **Status:** proposed (T4 / WP-6)
- **Date:** 2026-08-17 (pinned) · written 2026-08-19
- **Implements:** subagent-v2 design §6 (H2, P1) rev 2.1; implementation-plan ADR-6 + WP-6
- **Depends on:** ADR-4 (revision machinery shared with PlanRecord)
- **Gates:** CI 3-OS + B4 battery (spec-weighted)

## Context

"Spec" is skill vocabulary only: `TaskPacket` is static, acceptance evidence is free text, and nothing mechanically ties a completed task to its stated acceptance criteria. Design rev 1's "verifier independently checks" was rejected (reviewer P1-9 — not airtight); rev 2/2.1 pinned the fabrication-defense split: **mechanical coverage at the write-gate, machine-checkable evidence in strict mode, and a hardened re-run sandbox** because `SpecRecord.source.kind: "generated"` makes root-side re-execution a privilege-escalation vector (NEW-2).

## Decision

### 1. Schema (workspace-level)

```ts
SpecRecord  { id, version, revisionOf?, title,
              requirements: [{ id, text, priority: must|should|could }],
              acceptance:  [{ id, requirementId, check, idempotent?: boolean }],
              source: { kind: "manual" | "generated", by?, from? } }
SpecSnapshot{ specId, version, frozenAt, items[] }   // immutable, frozen into the task at dispatch
```

- Stored at `state/specs/<id>.json` (workspace-level, outside per-run state). **Revision machinery is shared with PlanRecord** (ADR-4 §2: append-only revision list, copy-forward linkage, stable item-ids) — one implementation, two stores.
- `TaskPacket` gains `specRefs[]`; the SpecSnapshot is **embedded at freeze time** (dispatch) so later spec edits never rewrite what a running task was held to. Snapshot items carry the acceptance ids the footer may cite — citing anything else is fabrication.
- `acceptance[].check` in strict mode carries `command` + `expectedDigest` (sha-256 hex) or `expectedExitCode`.
- `idempotent` (per acceptance, **default false**): only idempotent commands may be re-run by the strict gate (§4).

### 2. Evidence footer contract

Executor prompt (SPEC contract section) requires the result to end with:

```
SPEC-EVIDENCE:
<acceptanceId>: <one-line evidence>
```

- The footer parser (`spec-evidence.ts`) is mechanical: map of `acceptanceId → evidence`. Footer lines citing non-existent ids, or a missing footer where the task has must-acceptances, are gate events — never crashes.
- `should/could` requirements NEVER block any gate.

### 3. Write-gate (non-strict default — ⚑ warn-only)

- **Mechanical coverage ONLY**: every must-acceptance id cited ≥ 1 time. The gate never claims to verify truth.
- Missing footer / missing ids / unknown ids → task passes with an **`unverified` badge** in task status (visible in UI); never blocks in non-strict mode.
- Spec-less tasks are untouched (regression guard: full critical suite stays green).
- Extends the existing `empty-or-stderr-only-result` classifier seam (`task-runner/post-execution.ts:289+`) — no new gate layer.

### 4. Strict mode (opt-in per workflow) + the re-run sandbox

**Strict-mode trust gate (security P1 — pinned):** acceptance-command re-runs execute ONLY for specs with `source.kind: "manual"` (or an explicit user-set trust flag on the record). **`generated` specs (worker/planner-authored) degrade to coverage-only + `unverified`** — a worker must never be able to author a command that the root re-executes (prompt-injection → RCE/exfil surface). **Negative AC: worker-authored acceptance in strict mode degrades to coverage-only.**

**Sandbox parameters (concrete values):**
- **env**: the `BASE_ALLOWLIST` pattern from `child-pi-spawn.ts:35-58` **minus credential-carrying keys** — NO provider API keys, NO `PI_CREW_BROKER_*`, NO session tokens. Asserted in tests by capturing the child env.
- **cwd**: pinned to the run's workspace root.
- **Resources**: `sh -c 'ulimit -v 262144; ulimit -t 30; exec …'` (256 MiB address space, 30 CPU-seconds — config-capped ceilings).
- **Wall-clock**: 60s timeout, SIGTERM → 200ms → SIGKILL escalation (existing pattern).
- **Network**: `unshare -n` wrapper on Linux; **macOS has no equivalent → loud warning when strict mode is enabled on macOS** (platform honesty, not silent best-effort).
- **Storage**: output captured to a run-scoped **digest file** — digests only, NEVER raw command output persisted (leak discipline).

**Non-idempotent musts in strict mode**: cannot be machine-re-run → fall back to coverage-only + `unverified` (recorded per-acceptance).

**Digest comparison**: exit-code or sha-256 digest mismatch → gate fails that acceptance → strict task cannot pass the write-gate (P1 severity outcome: task marked failed/blocked per existing gate semantics).

### 5. Reject-start

A strict-mode workflow without a **verifier-role task fails at start** — no silent self-certification. (Non-strict workflows are unaffected.)

### 6. Verifier role

Read-only; receives the SpecSnapshot + the evidence footer; checks cited evidence against frozen snapshot ids. **Advisory signal only — the security boundary is the machine-check, never the verifier's judgment.**

### 7. Rollout & config

Non-strict default for v0.10.x (design §12.4 open decision stays open until post-release data). Strict opt-in via workflow frontmatter (`specStrict: true`). No new config keys beyond the sandbox ceilings (§4) — config-capped constants, not user-facing knobs, in v1.

### 8. Alternatives considered

- **Verifier-judged evidence** (rev 1) — rejected: LLM judgment is not a security boundary (P1-9).
- **Re-running generated-spec commands** — rejected: privilege escalation (NEW-2); degraded path is the compromise.
- **Persisting command output for audit** — rejected: digest-only (leak discipline; output may contain secrets).
- **Per-task (not per-spec) acceptance lists** — rejected: specs are workspace-level reusable artifacts; freezing happens per-task via the snapshot.

## Consequences

- New: `src/state/stores/spec-store.ts`, `src/runtime/task-runner/spec-evidence.ts`; extended: `task-packet.ts` (`specRefs[]` producer — the only packet-creation path), `pre-execution.ts` (freeze hook), `post-execution.ts` (write-gate), `prompt-builder.ts` (SPEC contract section).
- `requirements-to-task-packet` skill upgraded to author the SpecRecord+TaskPacket pair.
- Tests: `spec-store`, `spec-footer-parser` (valid/missing/unknown-id/fabricated), `spec-strict-sandbox` (network-blocked fails closed; timeout kills; env has NO provider keys; digest mismatch fails), negative ACs (non-idempotent strict → coverage-only; spec-less regression guard).
- Events: `spec.frozen`, `spec.unverified`, `spec.check_failed` registered in `TEAM_EVENT_TYPES`.

## Appendix — B4 battery case list

1. **(a) Non-strict happy path:** must-acceptances covered by footer → pass, no badge.
2. **(b) Non-strict fabrication:** plausible-but-wrong evidence cites every id → passes write-gate, flagged `unverified` where machine-checkable, visible in status.
3. **(c) Footer parser matrix:** valid / missing footer / unknown id / fabricated id.
4. **(d) Strict + manual spec:** digest match passes; digest mismatch fails the gate; exit-code mode works.
5. **(e) Strict + generated spec (negative AC):** degrades to coverage-only + `unverified` — no re-run.
6. **(f) Sandbox env containment:** captured child env has NO provider keys / NO `PI_CREW_BROKER_*`.
7. **(g) Sandbox limits:** timeout kills (60s escalation); network-blocked command fails closed on Linux (`unshare -n`); macOS emits the loud warning.
8. **(h) Non-idempotent strict must:** coverage-only + `unverified` fallback, recorded.
9. **(i) Reject-start:** strict workflow without verifier task fails at start.
10. **(j) Spec-less regression:** tasks without specRefs behave exactly as before (critical suite green).
11. **(k) Freeze immutability:** spec edited after dispatch → snapshot unchanged in the running task.
12. **(l) Verifier advisory:** verifier receives snapshot ids + footer; judgment advisory-only.

## References

- Design: `docs/design/subagent-v2-design.md` §6 (+ rev-2 P1-9 fabrication defense, rev-2.1 NEW-2 sandbox)
- Plan: `docs/design/subagent-v2-implementation-plan.md` ADR-6 + WP-6 (steps 1-7, tests, ACs)
- Shared machinery: ADR-4 §2 (revisions); `child-pi-spawn.ts:35-58` (BASE_ALLOWLIST); `post-execution.ts:289+` (classifier seam)
