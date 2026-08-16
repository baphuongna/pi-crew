# pi-crew Roadmap — 2026 Q3

Date: 2026-08-10

Companion to `docs/improvement-plan-2026-08-09.md` (maintainability inventory),
`docs/stories/backlog.md` (story backlog), and `docs/decisions/` (ADRs). This
document is a planning artifact, not an accepted spec — see `AGENTS.md`
source-of-truth order.

## Strategic assessment (short version)

- **Strengths to preserve:** durable-first state model, real child-Pi workers,
  worktree isolation, ADR discipline, real-test verification skill, honest
  cost/perf advisory.
- **Biggest risk:** feature-surface breadth (~40 tool actions, ~100 config
  keys, 6 runtime modes) exceeds what a solo maintainer can keep hardened.
  The fix is consolidation + focus, not more features.
- **Direction:** debt closure → security closure → product focus (review +
  research) → integration (CI/webhooks/teams).

---

## Phase 1 — Technical debt closure (v0.9.6x → v0.10, 1–2 releases)

Goal: restore the ability to run the full suite in a human-session timespan
and stop the "looks wired but is not" trap.

| ID | Action | Effort | Status / ref |
|----|--------|--------|--------------|
| R1-1 | Finish `team-runner.ts` split (scheduler-loop, dispatch-batch) | M | phase 1 (merge-gate) shipped 2026-08-10; further phases need own ADR |
| R1-2 | Reduce sync/async twins per contract-test-first plan | M–L | ADR `2026-08-10-reduce-sync-async-twins.md` (deliverable = ADR, not code yet) |
| R1-3 | Split integration suite into fast/slow tiers; `npm test` < 10 min | M | `npm test` currently times out at 580 s (improvement-plan §verification overhead) |
| R1-4 | ~~Wire scratchpad snapshot HMAC into production (Phase 2 of ADR)~~ **REMOVED 2026-08-12** | — | Premature: threat double-conditional (0 adoption + same-uid store both hold); helper + tests deleted; ADR Superseded. Re-add when scratchpad adoption >0 AND snapshots move to shared store |
| R1-5 | Add `limits.strictLockOwnership` opt-in (EPERM strictness) | S | SEC-008 accepted risk; E.3 |
| R1-6 | bug-023 Windows chain-path fix + un-skip gate | M | needs Windows VM; keep skip explicit until fixed |

**Done gate:** `npm test` completes < 10 min with 0 fail; ADR drift lint
`check:decision-drift` green; no module > 2000 lines in `src/runtime/`.

---

## Phase 2 — Security surface closure (milestone: isolated-vm v1.5)

Goal: no trust-model gaps that require "just don't use it" as the answer.

| ID | Action | Effort | Status / ref |
|----|--------|--------|--------------|
| R2-1 | DWF isolated-vm sandbox (default-deny F-01 stays until shipped) | L | ADR `2026-08-10-dwf-isolated-vm-sandbox.md`; multi-week milestone |
| R2-2 | ~~Scratchpad HMAC strict mode default + snapshot envelope audit~~ **REMOVED 2026-08-12** (was R1-4 continuation) | — | Depends on R1-4 which was removed; revisit only if scratchpad adoption >0 AND snapshots move to shared store |
| R2-3 | Consolidate trust-model docs (SEC-1, broker, sanitizeProjectConfig) into one page | S | currently split across README/docs/ADR |
| R2-4 | Windows CI as release gate (bug-023 + broker auto-disable proof) | M | R1-6 depends on this |

**Done gate:** every "accepted risk" in `docs/bugs/SECURITY-ISSUES.md` has an
owner + target version; no `.dwf.ts` executes without either sandbox or
explicit env opt-in.

---

## Phase 3 — Product focus: review & research (v0.10 → v0.11)

Goal: make the two parallel-fanout workflows where pi-crew provably beats raw
Agent calls (per topology advisory) into first-class, differentiated products.

| ID | Action | Effort | Status / ref |
|----|--------|--------|--------------|
| R3-1 | Run comparison (before/after) surfaced in `team summary` | M | backlog US-021 |
| R3-2 | Export run report as markdown (portable, CI-usable) | S | backlog US-022 |
| R3-3 | `review` workflow: PR-style findings artifact (severity + file:line + suggested fix) | M | new story |
| R3-4 | `research` workflow: citation tracking in artifacts (source URL per claim) | M | new story |
| R3-5 | Feature-shedding pass: candidates for removal/deprecation get a one-line ADR each | S | recur monthly |

**Done gate:** ≥2 external users can run `review` and `research` without
reading the README; `team summary` answers "what changed vs last run".

---

## Phase 4 — Integration & multi-user (v0.11+, opportunistic)

Goal: open the CI/team use cases without expanding the trust surface.

| ID | Action | Effort | Status / ref |
|----|--------|--------|--------------|
| R4-1 | Webhook notifications on run completion | M | backlog US-030 |
| R4-2 | GitHub Actions helper (report results as PR comment) | M | backlog US-031 |
| R4-3 | Interactive run dashboard in TUI (non-blocking, event-driven) | M | backlog US-020; relies on runEventBus replay |
| R4-4 | Shared/networked artifact store review (reopens E.2/scratchpad HMAC) | S | only after R2-2 ships |

**Done gate:** a CI pipeline can post a run report to a PR; a second machine
can consume exported run bundles without manual migration.

---

## Anti-goals (do NOT do before Phase 1 is green)

- New runtime modes (live-session v2, remote runners) — existing 6 are enough.
- New config keys without a deprecation path for existing ones.
- Default-on anything with arbitrary code execution (DWF, hooks).
- Broader plugin surface until `plugin-context` decision is closed one way
  (already deleted from bundle 2026-08-09 — keep it that way).

## Measuring progress

| Metric | Current (2026-08-09) | Target (end of Q3) |
|--------|----------------------|--------------------|
| Full suite time | > 580 s (timeout) | < 600 s clean pass |
| `src/runtime/` largest module | 2814 lines (team-runner) | ≤ 1500 lines |
| Accepted-risk items w/o owner | several | 0 |
| Dead/scaffolded modules in `src/` | 0 (post-Tier-1 cleanup) | 0 (CI-guarded) |
| Story backlog items completed | 0 (all planned) | ≥ 4 (R3-1/2 + R3-3/4) |

## Change log

- 2026-08-10: initial draft from assessment of `improvement-plan-2026-08-09.md`,
  `stories/backlog.md`, `README.md`, ADR set (2026-08-10 ×3).
