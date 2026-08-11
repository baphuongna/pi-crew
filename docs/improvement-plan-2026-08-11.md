# pi-crew Improvement Plan — 2026-08-11 (RLM / scratchpad adoption batch)

> Third in the series after `docs/improvement-plan-2026-08-09.md` (A–F) and
> `docs/improvement-plan-2026-08-10.md` (G1–G13, H1–H9). This batch is narrower
> and has a single thesis: **the pi-rlm pattern transfer is technically complete
> but commercially unproven — the `scratchpad` tool has never been called once.**
> Item IDs continue the sequence: **I** = Tier 1 (this batch), **J** = Tier 2 /
> ADR candidates.
>
> Sources: `rlm-apply-pi-crew.md` (22-pattern matrix), `rlm-quickwins-spec.md`,
> `src/runtime/scratchpad/README.md` (Phase 1-3 design), plus a read-only audit
> of `src/` + `.crew/` run state performed 2026-08-11 against HEAD `7c6815aa`
> (v0.9.66).
>
> This is a planning artifact, not an accepted spec — see `AGENTS.md`
> source-of-truth order.

## Verification status legend

| Marker | Meaning |
|---|---|
| ✅ VERIFIED | Directly checked (read / grep / git log) on 2026-08-11 |
| ⚠️ PARTIAL | Verified with nuance |
| 🔍 EXPLORE | Hypothesis, not yet proven |

## How this plan is organised

Each item carries a **lane** (tiny / normal / high-risk) per
`docs/FEATURE_INTAKE.md` and an explicit risk classification. Tier 1 items are
small and independently shippable. Tier 2 items need an ADR or a metric from
Tier 1 before any source change. A **decision gate** at the end defines the
keep-or-remove criterion for the whole feature.

---

## 0. Headline finding — the feature is armed but unused

The scratchpad ships, is wired correctly, is armed by default for three roles,
and pays a prompt-token cost on every turn of those workers. It has produced
zero cells and zero snapshots.

| Check | Result | Evidence |
|---|---|---|
| Phase 1 landed | 2026-08-08 | `git log -1 45674a35` |
| Released | v0.9.64, 2026-08-09 | `git log -1 15ab5055` |
| Runs after landing | 14 | `.crew/state/runs` (`team_20260810*`) |
| `"toolName":"scratchpad"` in any transcript | **0** | grep over `.crew/artifacts/*/transcripts/*.jsonl` |
| `scratchpad/*.snapshot.json` artifacts | **0** (across all 87 runs) | `find .crew -path '*scratchpad*'` |
| Executor transcripts sampled | 8/8 used only `bash` | `.crew/artifacts/team_2026081*/transcripts/02_execute*.jsonl` |
| Wiring correct? | ✅ yes — not a plumbing bug | `child-pi-spawn.ts:282-283` sets `PI_CREW_SCRATCHPAD=1` when `isScratchpadEnabledForRole` passes |
| Armed roles | `executor`, `verifier`, `test-engineer` | `role-tools.ts` (`scratchpad: true`) |
| Prompt cost when armed | **~246 tokens/turn** | doctrine 751 chars (~188 tok) + name/label/description/promptSnippet 232 chars (~58 tok) |

**Leading hypothesis (🔍 EXPLORE — not yet proven):** the kept-toolbox trade-off
whose consequence was not planned for. `rlm-apply-pi-crew.md` §4.3 deliberately
rejected pi-rlm's tool-collapse (pattern 13's `setActiveTools(["execute"])`),
keeping the classic toolbox alongside the scratchpad. pi-rlm gets adoption by
*removing the alternative*; pi-crew kept the alternative, so the scratchpad
competes with `bash` and loses every time. Pattern 22's trade-off note
("collapse only wins when the model is good at code") predicted the risk;
nothing was put in place to detect or counter it.

**This is a hypothesis, not a confirmed root cause — the 14-run sample cannot
discriminate it from at least three equally-plausible alternatives:**
- **Short window:** all 14 runs are from a single day (2026-08-10), ~1 day
  after release — far too little to separate "never adopted" from "not yet
  adopted".
- **Workflow bias:** 13/14 runs used the `fast-fix` team (one-shot
  explorer→executor→verifier), which structurally lacks the multi-step
  parse-then-analyse data flow scratchpad exists for. "8/8 executors used only
  bash" is exactly what you'd expect on single-line fixes regardless of any
  bash-vs-scratchpad competition.
- **No qualifying task shape:** none of the 14 sampled tasks is the kind
  scratchpad was built for, so 0 adoption may simply mean "not yet tested on a
  task it can help" — the unfalsifiable counterfactual the §5 gate must close
  before it can return "remove".

I1–I4 still ship as the cheapest lever *on the adoption number*; but if the
true cause is task-shape mismatch, doctrine fixes cannot move the number and
the §5 gate must be able to say so (see the DEFER branches in §5), not default
to "remove".

**Secondary factor (I1–I4): the doctrine is partly false.** Two of the seven
doctrine bullets describe behaviour that does not exist in pi-crew. pi-rlm's own
prompt rule applies: *"a prompt that advertises absent tools is worse than no
prompt at all."*

**Measurement gap:** `test/unit/scratchpad-perf-metric.test.ts` measures only
the prompt-token **cost**. Design-doc success criterion (a) — "attempt 2 does
not re-fetch/re-parse data already in the snapshot, measured as a token
reduction attempt 2 vs attempt 1" — has never been measured. There is no
counter, no event, and no readout.

---

## 1. Pattern-matrix status (22 patterns, verified 2026-08-11)

| Status | Patterns | Notes |
|---|---|---|
| ✅ Shipped | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 16, 17, 19, 20 | High quality: fd3+nonce (`protocol.ts`), abort grace 500 ms + ping-before-execute, 65536 chars/channel cap (`engine.ts:36`), D10 TOCTOU re-validation at READ time, D6 two-sided caps, D13 base64 round-trip, kill-process-group (`0fa7fc5c`). **16** (subagent handles) pre-exists in `subagent-tools.ts` — no new work |
| ⚠️ Partial + drift | **13** (dormant activation), **14** (prompt replacement) | **13**: dormant-arming shipped, but the tool-collapse sub-pattern (`setActiveTools`) was deliberately rejected (§0, §4.3) — so it cannot *force* adoption the way pi-rlm does. **14**: see I1, I2, I3, I4 |
| ❌ Gap, small effort | **12** (shell guard) | See I6 — matrix rated it "CHUYỂN / value Cao / effort Nhỏ" and it was silently dropped at spike time |
| ⏸ Deferred by design | **15** (host bridge) | `host_request` is declared at `protocol.ts:48` but no engine handler exists — dead protocol surface. See J2 |
| ⏸ Correctly skipped | 18, 21 (rendering) | Worker runs `--mode json`; no TUI |
| ⚠️ Consequence unhandled | **22** (design philosophy) | The kept-toolbox decision produced 0 adoption; see §0 and the decision gate |

Feature footprint (for the decision gate): `src/runtime/scratchpad/` 1 716
lines + `src/prompt/scratchpad-lifecycle.ts` 605 lines = **2 321 lines**, plus
**19 test files** (line counts re-verified 2026-08-11 via `wc -l`).

---

## 2. Preconditions

### P0 — commit the staged 2026-08-10 batch first

- **Status:** ✅ VERIFIED
- **Evidence (2026-08-11):** `git status --short` shows ~30 staged files
  (`src/extension/team-tool/api*`, `src/runtime/team-runner.ts`,
  `src/state/gitignore-manager.ts`, deleted `src/types/new-api-types.ts`,
  moved integration tests, …) matching the G1–G13 + H1–H8 execution changelog
  in `improvement-plan-2026-08-10.md`. HEAD is `7c6815aa` (v0.9.66); that work
  is **not** in a commit.
- **Action:** commit the 08-10 batch before starting any item below, so the
  I-batch diff stays reviewable and the H-work cannot be lost.
- **Owner:** human (this is uncommitted user work; do not stage/unstage or
  revert it as part of the I batch).

---

## 3. Tier 1 — small, independently shippable

### I1 — Doctrine advertises a tools bridge that does not exist (BUG) — TINY

- **Status:** ✅ VERIFIED
- **Files:** `src/prompt/scratchpad-lifecycle.ts:99`
- **Evidence (2026-08-11):** the doctrine bullet reads *"Tool calls inside
  scratchpad are await expressions — await the result before the next cell."*
  There is no tool binding in the guest:
  - `src/runtime/scratchpad/guest.ts:186` — `INTERNAL_BINDINGS = new Map()`,
    never populated.
  - `src/runtime/scratchpad/guest.ts:188-190` — `installBootstrapBindings()` has
    an empty body with the comment *"Spike: no host bridge, no Bun — nothing to
    mount."*
  - `src/runtime/scratchpad/engine.ts` — grep for `host_request` / `hostRequest`
    → **0 hits**; the message type exists only as a declaration at
    `protocol.ts:48`.
- **Impact:** High. This is the most likely direct cause of 0 adoption: a model
  that follows the doctrine writes `await tools.read(...)`, gets
  `ReferenceError: tools is not defined`, and abandons the tool. It is also the
  exact anti-pattern pi-rlm documents against.
- **Lane:** tiny (delete one string).
- **Risk:** none (removes a false claim).
- **Fix:** delete the bullet. Do **not** replace it with a truthful "there is no
  tools bridge" line — silence is cheaper than a negative statement.

### I2 — Doctrine references a marker pi-crew never emits (BUG) — TINY

- **Status:** ✅ VERIFIED
- **Files:** `src/prompt/scratchpad-lifecycle.ts:98`
- **Evidence (2026-08-11):** the bullet says *"If you see `<rlm_engine_reset>`
  or a snapshot-restore notice, re-verify variables before use."* `grep -rn
  "rlm_engine_reset" src/ test/` returns **exactly one hit — that doctrine
  string itself**. pi-crew's real notice is built at
  `scratchpad-lifecycle.ts:471-472` and reads
  `[scratchpad] restored N vars from attempt-K; restored: [...]; failed: [...]`
  (or `[scratchpad] snapshot restore: no state to restore (fail-open)` /
  `[scratchpad] snapshot restore failed; continuing with empty namespace`).
- **Impact:** Medium. The advice is half-dead: the model watches for a token
  that can never appear, and is never told the literal prefix that *does*
  appear.
- **Lane:** tiny.
- **Risk:** none.
- **Fix:** replace `<rlm_engine_reset>` with the real prefix, e.g. *"A message
  starting `[scratchpad]` means the namespace was restored or reset —
  re-verify variables before using them, especially inside shell commands."*
  Keeping the "especially in shell commands" clause preserves pi-rlm's
  stale-variable rationale (and pairs with I6).

### I3 — Model-facing tool surface mixes Vietnamese and English — TINY

- **Status:** ✅ VERIFIED
- **Files:** `src/prompt/scratchpad-lifecycle.ts:438` (`description`),
  `:441` (`promptSnippet`) vs `:93-99` (`promptGuidelines`)
- **Evidence (2026-08-11):** `description` is *"Chạy JavaScript trong namespace
  bền vững của task. State (biến gán ở cell trước) tồn tại qua các lần gọi.
  Kết quả cell = giá trị biểu thức cuối."* and `promptSnippet` is
  *"scratchpad(code) — chạy JS trong namespace bền vững của task"*, while all
  seven doctrine bullets are English. Every other worker-facing tool surface in
  the repo is English.
- **Impact:** Medium. The tool's *first* impression (name + description, which
  is what the model uses to decide whether to call it at all) is in a different
  language from the instructions that explain how to use it. Instruction
  following degrades on mixed-language tool specs, and this is the one surface
  that must win the choice against `bash`.
- **Lane:** tiny.
- **Risk:** none (Vietnamese stays in human docs; this changes only the
  model-facing channel).
- **Fix:** translate `description` + `promptSnippet` to English. Human-facing
  copy (README, this plan, chat) stays Vietnamese per project convention.

### I4 — Doctrine has no worked example (the actual adoption lever) — TINY

- **Status:** ✅ VERIFIED (gap), 🔍 EXPLORE (that it fixes adoption)
- **Files:** `src/prompt/scratchpad-lifecycle.ts:92-99`
- **Evidence (2026-08-11):** the doctrine is seven abstract assertions. It never
  shows a cell, never shows the two-cell pattern that is the whole point, and
  never names a situation where scratchpad beats `bash`. pi-rlm by contrast
  ships a long teaching prompt (`prompt.ts:20-71`) with concrete guidance, and
  its 7-test prompt suite pins the doctrine content.
- **Impact:** High (this is the cheapest possible lever on the 0-adoption
  number).
- **Lane:** tiny.
- **Risk:** low — costs tokens. Budget: keep the whole `promptGuidelines` block
  under ~350 tokens (currently ~188); re-run
  `test/unit/scratchpad-perf-metric.test.ts` to record the new delta.
- **Fix:** add (a) one two-cell worked example, and (b) one explicit
  *when-to-prefer* rule. Sketch:

  ```
  Prefer scratchpad over bash when a later step reuses an earlier step's data.
  Example — cell 1: `const fs = await import("node:fs"); const raw = fs.readFileSync("out.json","utf8"); const failures = JSON.parse(raw).tests.filter(t => !t.ok); failures.length`
            cell 2: `failures.slice(0,3).map(t => t.name)`   // no re-read, no re-parse
  For a single one-shot command, bash is cheaper — use it.
  ```

  The last line matters: telling the model when *not* to use the tool is what
  makes the positive rule credible.
- **Caveat (feasibility, verified 2026-08-11):** (1) cells run inside an
  `AsyncFunction` in the ESM worker — `require()` is **undefined** there, so the
  example must use `await import("node:fs")` (or the `sh()` binding once I6
  ships), never `require(...)`. (2) the perf-metric test guards
  `!line.includes("${")`, so the worked-example string must not contain a
  literal `${` (do not paste `execSync(\`rm -rf ${dir}\`)` into the doctrine).
  (3) sequence after I6 if the example references `sh()`, and add a one-line
  doctrine note "keep namespace values small — do not park large parsed objects
  across cells" (the namespace is V8-serialized on every snapshot).

### I5 — No adoption or value metric (design-doc criterion (a) unmeasured) — NORMAL

- **Status:** ✅ VERIFIED
- **Files:** `test/unit/scratchpad-perf-metric.test.ts` (cost only),
  `src/prompt/scratchpad-lifecycle.ts` (execute handler, no emit),
  `src/state/contracts.ts` (`TEAM_EVENT_TYPES`)
- **Evidence (2026-08-11):** the perf test's own header says it measures the
  *"per-turn prompt cost"* and is *"metric only — no hard assert"*. There is no
  counter for cells executed, no event on restore, and no field in the run
  summary. Consequently the 0-adoption fact above had to be discovered by
  grepping raw transcripts — it was invisible to the product.
- **Impact:** High. Without this, the keep-or-remove decision (§5) cannot be
  made on evidence, and I1–I4/I6 cannot be shown to have worked.
- **Lane:** normal (touches the event log).
- **Risk flags:** event-log write on a hot path — must be fire-and-forget, must
  not block the cell.
- **Caveat (feasibility, verified 2026-08-11):** the scratchpad execute handler
  runs in the **worker (child-pi) process**, NOT the team-runner — it has no
  access to `eventsPath` or `runId`. The "follow the H1 pattern" instruction in
  step 1 is therefore **under-specified**: H1 converted existing callers in
  `team-tool/*` that already held `eventsPath` via their manifest; the
  scratchpad context does not. I5 needs new plumbing — thread a new
  `PI_CREW_EVENTS_PATH` env var from `child-pi-spawn.ts` and read the already-set
  `PI_CREW_BROKER_RUN_ID` (`child-pi-spawn.ts:274`) into the handler, then
  import `appendEventFireAndForget` (`event-log.ts:1309`). `AppendTeamEvent`
  requires `runId` (`TeamEvent.runId`), so it must be threaded too.
- **Fix:**
  1. Emit `scratchpad.cell` after each cell with
     `{ taskId, status, durationMs, codeLength, resultBytes }` via
     `appendEventFireAndForget` / `void appendEventAsync().catch(logInternalError)`
     (follow the H1 pattern — never sync on this path).
  2. Emit `scratchpad.restored` on the restore branch with
     `{ taskId, attempt, restoredCount, failedCount }` (names are already in
     the model-facing notice; the event carries counts only).
  3. Register both literals in `TEAM_EVENT_TYPES` (`src/state/contracts.ts`) so
     the 2 new types do not add to the G11 drift backlog. The registry already
     reports 72 unregistered (see J5) — "clean" here means **does not grow**
     that count, not zero-drift.
  4. Report them: add a line to the run summary artifact when the count is
     non-zero (silent when the feature is unused — no noise for the 3 armed
     roles that never call it).
- **Tests:** unit test that the handler emits exactly one `scratchpad.cell` per
  cell and does not throw when the event write fails (injected failing writer).

### I6 — Pattern 12 (shell interpolation guard) was never ported, and the doctrine steers straight into the hazard — NORMAL

- **Status:** ✅ VERIFIED
- **Files:** `src/runtime/scratchpad/guest.ts:186-192` (no bindings),
  `src/prompt/scratchpad-lifecycle.ts:95` (doctrine)
- **Evidence (2026-08-11):**
  - The 22-pattern matrix (`rlm-apply-pi-crew.md` §2) rates pattern 12
    **CHUYỂN / value Cao / effort Nhỏ**, with the note *"port nguyên; chống
    class-bug `rm -rf undefined`"*.
  - `src/runtime/scratchpad/README.md:52` records the spike deviation as a table
    row: `Bun.$ guard / host bridge | bỏ (không cần cho spike)` (Vietnamese:
    "dropped — not needed for spike").
    Phase 1-3 never revisited it.
  - Doctrine line 95 actively directs the model at the unguarded surface:
    *"The runtime is Node.js — use child_process for shell commands; there is
    no Bun."*
  - The hazard is *aggravated* by Phase 2: after a restore, a variable can be
    legitimately missing (it is in `failed[]`, or it was redacted to the literal
    `"***"` per D4). `execSync(\`rm -rf ${dir}\`)` with `dir === undefined`
    stringifies to `rm -rf undefined` — a command that **succeeds** against the
    wrong path. pi-rlm added this guard precisely because stale-after-restore
    variables are the trigger.
  - `safe-bash.ts` does **not** cover this: it blocks dangerous command strings,
    it does not guard template interpolation, and it is not in the guest path.
- **Impact:** High (destructive-action class bug), and it is the highest
  value-to-effort item left in the whole matrix.
- **Lane:** normal (new guest binding + namespace/snapshot interaction).
- **Risk flags:** adds a binding to the guest namespace — must interact
  correctly with snapshot/restore.
- **Fix:** install a guest-local `sh` helper in `installBootstrapBindings()`
  (no host bridge needed — `node:child_process` is importable in the guest; see
  caveats):
  - `sh(cmd, args[])` → `execFile` with `shell: false`, args as an array.
    **Use promisified `execFile`** (not `execFileSync`) so a non-zero exit
    returns `{exitCode,stdout,stderr}` instead of throwing.
  - Refuse `null` / `undefined` arguments with a named error before spawning
    (the pattern-12 nullish guard), and refuse them in the tagged-template form
    if one is offered.
  - Return a value, not a string: `{ exitCode, stdout, stderr }` — pi-rlm's
    "shell as value" property, which also makes cell 2 able to reuse cell 1's
    result.
  - Register the binding in `INTERNAL_BINDINGS` so `snapshotNamespace()`
    (`guest.ts:246`, `INTERNAL_BINDINGS.get(name) === value` skip) does not try
    to serialize it, and confirm `installBootstrapBindings()` still runs
    **after** restore (`guest.ts:298`) so a revived stale value cannot shadow
    the live handle.
  - Update doctrine line 95 to point at `sh(...)` and state why (nullish
    interpolation is refused), and add an explicit "never interpolate variables
    into `child_process` / `exec` strings — use `sh()`" line.
- **Caveats (feasibility, verified 2026-08-11):**
  - The guest runs cells via `new AsyncFunction(... 'with (SCOPE) {...}')`
    (`guest.ts:197,212`) in the **host process** — it is **not a VM sandbox**.
    A cell retains full `globalThis` access (dynamic `import`, `node:fs`,
    `process`). Therefore `sh()` is an **advisory narrowing guard, not a
    security boundary** — a model that ignores it can still `import("node:child_process")`
    and hit the exact hazard. I6 **mitigates** the class bug for cooperative
    models; it does **not close** it. Do not let the "High (class bug)" Impact
    above read as "fixed"; state this in the ADR/CHANGELOG.
  - `node:child_process` is **not yet imported** in `guest.ts` — it must be
    added at module scope. "Available" above means importable, not imported.
  - `INTERNAL_BINDINGS` skip uses identity (`===`) at `guest.ts:246`; registering
    the **same function reference** in both `INTERNAL_BINDINGS` and `namespace`
    is required for snapshot exclusion to work (confirmed).
- **Tests:** guest-level tests for (a) nullish argument refused before spawn,
  (b) `{exitCode,stdout,stderr}` shape, (c) `sh` absent from a snapshot's
  `vars`, (d) `sh` still callable after `restoreState`.

### I7 — `snapshot-hmac.ts` is dead code with 11 green tests — TINY (doc), decision in J1

- **Status:** ✅ VERIFIED
- **Files:** `src/runtime/scratchpad/snapshot-hmac.ts` (161 lines),
  `test/unit/runtime/scratchpad/snapshot-hmac.test.ts` (11 tests),
  `docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md`
- **Evidence (2026-08-11):** grep for `getSnapshotHmacKey` /
  `attachSnapshotSignature` / `verifySnapshotPayload` /
  `shouldRejectSnapshot` across `src/` and `test/` → the **only** consumers are
  the module itself and its own unit test. Zero production call sites.
  `v8.deserialize` on restore content (`guest.ts:290`) remains unauthenticated,
  exactly as the scratchpad README declares.
- **Impact:** Medium — the risk is not the missing HMAC (the ADR conditionally
  accepts that while the same-uid boundary holds); it is that 11 passing tests
  named `snapshot-hmac` read like protection that is not in the path.
- **Lane:** tiny (documentation only in this batch).
- **Risk:** none.
- **Fix (this batch):** make "not wired" unmissable at both ends — a
  `NOT WIRED (see ADR 2026-08-10, Phase 2)` banner at the top of
  `snapshot-hmac.ts` and in the test file header, and a cross-reference in the
  scratchpad README threat-model section. The wire-or-delete decision is J1.

---

## 4. Tier 2 — ADR candidates / metric-gated

### J1 — HMAC: wire Phase 2, or delete the helper

- **Blocked on:** the three questions the ADR itself defers
  (`docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md`, Phase 2): does
  `writeArtifact`'s redaction survive an inline signature prefix; HMAC over raw
  V8 bytes vs the base64 envelope (ADR pre-decides: raw bytes); does
  `SNAPSHOT_MAX_BYTES` apply to the envelope or the bare payload (ADR
  pre-decides: bare payload).
- **Recommendation:** answer the redaction question first, because it is the
  only genuinely open one — `writeArtifact` applies structural + flat redaction,
  and a flat pass over a signed blob is exactly the corruption class D13 already
  had to defend against on restore. If the prefix cannot survive redaction,
  prefer artifact metadata over a sidecar file, and if neither is clean,
  **delete the helper** rather than leave 161 lines of decorative crypto.
- **Lane:** normal.

### J2 — Minimal host bridge (pattern 15) — metric-gated on I5

- **Scope if taken:** `tools.read` and `tools.grep` only. The point is not
  convenience; it is that data enters the namespace **without passing through
  the transcript**, which is where pi-rlm's token saving actually comes from.
  Today a cell must use `fs` directly, so the read is untracked and there is no
  `fullyKnown`-style "never read in full" nudge before an edit.
- **Do not start before I5 produces numbers.** If adoption is still ~0 after
  I1–I4 + I6, a host bridge adds surface to a tool nobody calls.
- **Note:** `protocol.ts:48` already declares `host_request`, so the protocol
  does not need to change — only an engine-side dispatcher and guest handles.
- **Lane:** normal-to-high-risk (new host-side execution path with the cell's
  abort signal).

### J3 — Arm the scratchpad by task shape, not by role

- **Problem:** every `executor` / `verifier` / `test-engineer` worker pays
  ~246 tokens/turn whether or not the task has any multi-step data flow.
- **Recommendation:** keep the role opt-in as the outer gate, and add an inner
  predicate on the task packet (multi-file / multi-step / parse-then-analyse
  shapes) before setting `PI_CREW_SCRATCHPAD=1` in
  `child-pi-spawn.ts:282`. Wins on both axes: less waste where it cannot help,
  stronger signal where it can.
- **Lane:** normal (spawn-path behaviour change; needs the I5 metric to tune
  the predicate).

### J4 — `team-runner.ts` is the last god file (2 637 lines)

- **Context:** H3 cut `api.ts` 1 239 → 77, `child-pi.ts` −140, `run.ts` −215.
  The deferred target named in both prior plans is the self-contained
  `dispatchUnit` closure (`team-runner.ts:1610-1837` in the pre-H3 numbering —
  re-locate before quoting).
- **Lane:** normal, phased; follow the `merge-gate.ts` extraction precedent
  (`ce847329`).

### J5 — G11 Phase 2: enforce the event-type registry

- **Context:** `npm run check:event-types` currently runs in **report** mode and
  detected 72 unregistered types (108 emitted vs 65 registered — the difference
  is not `108−65`: ~29 of the 65 registered literals are dead / never-emitted,
  so 108 emitted − ~36 live-registered ≈ 72 drift).
  `TeamEvent.type` is still `string`, not the `TeamEventType` union.
- **Recommendation:** migrate the backlog, then flip report → enforce, then the
  type union. I5 adds two new literals — register them there so the backlog does
  not grow.
- **Lane:** high-risk for the type flip; tiny for keeping new emissions clean.

### J6 — v0.9.66 release status (CORRECTED 2026-08-11 — draft premise was false)

- **Status:** ✅ RESOLVED / premise was false. The draft above claimed v0.9.66
  was "untagged and unpublished"; verification on 2026-08-11 shows it is
  **both tagged and published**:
  - `git tag --list` → `v0.9.66` exists.
  - `npm view pi-crew version` → `0.9.66`.
  - `git describe --tags` → `v0.9.66`; `package.json` → `0.9.66`; HEAD
    `7c6815aa` = v0.9.66.
  The original H9 "carried forward" premise no longer applies — this item is
  retired as written.
- **Residual open items:**
  - The staged 08-10 batch (P0) is **uncommitted** and therefore unversioned;
    confirm a v0.9.67 (or similar) bump + tag + publish once that batch lands.
  - **v0.9.65 has no tag** — the tree jumped 0.9.64 → 0.9.66; confirm whether
    that skip was intentional or a missed release.
- **Lane:** low (verification + doc correction only) for this item; the eventual
  release of the 08-10 batch remains **T4 production-mutating** and needs
  explicit human approval per `AGENTS.md`.

---

## 5. Decision gate — keep or remove the scratchpad

The feature is 2 321 source lines (1 716 in `src/runtime/scratchpad/` +
605 in `src/prompt/scratchpad-lifecycle.ts`) + 19 test files and costs ~246
tokens/turn on three roles. It has produced zero cells. Rather than let that
drift, bind it to an explicit criterion:

1. Ship I1–I4 (doctrine truthfulness + worked example) and I6 (shell guard).
2. Ship I5 (metric) so `scratchpad.cell` counts are visible in run state.
   **This is a hard precondition:** the observation clock in step 3 must NOT
   start until I5 is shipped and verified (DoD (d)) — without the events the
   gate has no data (the §0 measurement gap forced adoption to be discovered by
   grepping raw transcripts).
3. Observe for **two weeks of normal use** (or ~20 runs containing an armed
   role, whichever comes first). **Task-shape precondition:** the window must
   include ≥5 runs whose task packets are multi-step / multi-file /
   parse-then-analyse (e.g. `implementation` / `default` teams) — the shape
   scratchpad was built for. A window of only `fast-fix` runs cannot produce a
   "remove" verdict, because fast-fix structurally cannot benefit (see §0).
4. **Gate:**
   - **≥1 cell per ~5 armed-role runs, and at least one restore that measurably
     shortens attempt 2** → the premise holds; proceed to J3 (shape-based
     arming) and consider J2 (host bridge). *Note: this positive path requires
     a qualifying retry; since retries essentially never fire today (see the
     DEFER branch), reaching it may need a future change that forces retries on
     armed-role tasks.*
   - **≥1 cell but no qualifying retry / no measurable attempt-2 shortening**
     → **DEFER**: adoption happened but value is unproven. Extend the window
     (target tasks that retry), keep I1–I6 shipped, do not remove. Retries
     essentially never fire today (`executeWithRetry` retries on **any** error
     — `retryableErrors` is empty so `isRetryable()` defaults true, not just
     transient `ChildTimeout`; `maxAttempts=3` — but in practice 0 tasks in
     history have >1 attempt), so a "value" verdict may require a future change
     that forces retries on armed-role tasks. **Full net-ROI (tokens saved by
     reuse minus the ~246 tokens/turn armed cost) is deferred** — the gate is
     adoption-primary; DEFER when adoption >0 but value cannot be measured due
     to retry scarcity.
   - **Still ~0 cells AND the task-shape precondition (step 3) was met** →
     the pattern-22 trade-off has been empirically settled against pi-crew's
     architecture. Remove the feature (or move it behind a non-default
     `PI_CREW_SCRATCHPAD_EXPERIMENT=1` flag), reclaiming the token cost and
     2 321 lines. Record the outcome as an ADR — a negative result about a
     well-executed port is worth keeping.
   - **Still ~0 cells but the task-shape precondition was NOT met** (window
     contained only `fast-fix` / one-shot runs) → **DEFER**: the experiment was
     not run on qualifying tasks; restart the window with shape-diverse runs.
     Do **not** return "remove" on an unqualified sample.

Framing note: a "remove" outcome would not mean the port was wasted. It settles,
with evidence, whether stateful cells can win against a classic toolbox when the
toolbox is left in place — which is exactly the question `rlm-apply-pi-crew.md`
§4.3 deferred.

---

## 6. Sequencing and effort

| Order | Item | Effort | Gate to proceed |
|---|---|---|---|
| 1 | P0 commit staged 08-10 batch | 15 min | — |
| 2 | I1 + I2 + I3 (doctrine truthfulness) | 30 min | — |
| 3 | I4 (worked example) | 30 min | perf-metric delta re-recorded |
| 4 | I7 (NOT WIRED banners) | 15 min | — |
| 5 | I5 (adoption + value metric) | 0.5 day | `check:event-types` clean |
| 6 | I6 (pattern 12 shell guard) | 0.5 day | guest tests green |
| 7 | *observe 2 weeks* | — | decision gate §5 |
| 8 | J1 / J3 / J2 (in that order) | 1 / 0.5 / 2-3 days | §5 outcome |
| 9 | J4, J5 (J6 retired — see §4 J6) | separate ADRs | independent of the gate |

Tier 1 total: **~1.5 working days** (the raw effort column sums to ~1.2 days;
the balance is context-switch / review overhead). No Tier 1 *source* change
depends on another, except I4 which reads better after I1/I2 land. Note,
however, that the §5 decision gate depends on I5 being live for the whole
observation window — the clock must not start before I5 ships (DoD (d)); see
the gate precondition in §5.

## 7. Definition of Done (Tier 1)

- (a) I1/I2 — `grep -rn "rlm_engine_reset\|await expressions" src/` returns 0
  hits; a test pins the doctrine against advertising absent bindings (mirroring
  pi-rlm's "no placeholder leak" prompt test).
- (b) I3 — no non-ASCII prose remains in `description` / `promptSnippet`;
  Vietnamese retained in README/plan.
- (c) I4 — doctrine contains one worked two-cell example and one
  when-to-prefer-bash rule; `promptGuidelines` stays under ~350 tokens with the
  new figure recorded in `scratchpad-perf-metric.test.ts`.
- (d) I5 — `scratchpad.cell` + `scratchpad.restored` emitted fire-and-forget,
  both registered in `TEAM_EVENT_TYPES` (the 2 new types must NOT appear in the
  drift list — `check:event-types` already reports 72 unregistered, see J5),
  unit test covers the failing-writer path.
- (e) I6 — `sh()` bound in the guest with the nullish guard; 4 guest tests green
  (refusal, value shape, snapshot exclusion, survives restore); doctrine line 95
  points at it.
- (f) I7 — NOT WIRED banner in module + test header + README threat model.
- (g) No regression: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm run test:critical` (101/0), `npm run test:spike`, and all 19 scratchpad
  test files green. Bundle rebuilt (`npm run build:bundle`) — the 2026-07-13
  stale-bundle lesson applies to every `src/` change here.
- (h) CHANGELOG entry under an "RLM/scratchpad adoption" heading.

## 8. Risks

| Risk | Mitigation |
|---|---|
| I4 grows the prompt on a tool that may be removed | Hard token budget (~350) + the metric from I5 makes the cost visible next to the usage number |
| I6 binding breaks snapshot/restore | `INTERNAL_BINDINGS` registration + the two dedicated tests (snapshot exclusion, survives restore); `installBootstrapBindings()` already runs after restore (`guest.ts:298`) |
| I6 `sh()` reads as a new capability and increases full-trust surface | It is not new: the guest already has unrestricted `node:child_process`. `sh()` is strictly a *narrowing* wrapper. State this in the ADR/CHANGELOG so it is not mistaken for privilege expansion |
| I5 event write on the cell hot path | Fire-and-forget only (H1 pattern); test with an injected failing writer |
| Fixing the doctrine still yields 0 adoption | That is the point of the §5 gate — it converts an open-ended experiment into a dated decision |
| §5 "remove" branch touches more than the footprint | Removing 2 321 lines + 19 test files also deletes `child-pi-spawn.ts` env injection (282-285: `PI_CREW_SCRATCHPAD` / `PI_CREW_TASK_ID` / `PI_CREW_ATTEMPT`; ~290: `PI_CREW_ARTIFACTS_ROOT` inside its own `if`), the `scratchpad-lifecycle.ts` execute handler in the prompt pipeline, and `role-tools.ts` arming for 3 roles — the same hot spawn path + prompt builder other features depend on. Treat removal as a full regression pass + ADR, not a clean delete; verify the separately-useful per-attempt snapshot env vars aren't relied on elsewhere |
| Citations in this plan drift as files change | Every `file:line` here was read on 2026-08-11 against HEAD `7c6815aa`; re-verify before quoting in a spec |

---

## Execution changelog

(To be filled as items complete; format matches the 2026-08-09 / 2026-08-10
plans.)

- **2026-08-11 (draft):** read-only audit against HEAD `7c6815aa` (v0.9.66).
  Headline finding recorded (0 scratchpad calls / 0 snapshots across 14
  post-release runs); pattern matrix re-verified; items I1–I7 and J1–J6 filed.
  No source changes made.
- **2026-08-11 (verification pass + doc fixes):** 40 claims across 5 parallel
  verifier agents — 37 PASS / 2 FAIL / 1 PARTIAL. Applied 3 doc corrections:
  (1) J6 premise was false — v0.9.66 IS tagged + published (`git tag v0.9.66`,
  `npm view pi-crew version` → 0.9.66) — rewritten to a corrected/retired
  status, plus flagged v0.9.65 missing tag.
  (2) line-count footprint fixed 2 926 → **2 321** (dir 1 716 + lifecycle 605)
  in §1 footnote and §5.
  (3) I6 README quote corrected to the actual Vietnamese line (`README.md:52`).
  I1–I7 substance all confirmed by evidence; no source changes made.
- **2026-08-11 (loop review — `iterative-audit`, Lô A applied):** 3 review
  rounds (consistency / completeness+logic / feasibility). Round 1 minor:
  Pattern 16 added to the matrix; Pattern 13 moved to Partial (tool-collapse
  rejected); J5 arithmetic explained; "stays clean" → "does not grow backlog";
  "~1.5 days" reworded with overhead note. Round 3 caveats written into items:
  I4 example now uses `await import()` (not `require()`, ESM) and avoids `${`
  (perf-test guard); I5 flagged that the handler runs in the worker process
  with no `eventsPath` / `runId` (needs new env-var plumbing — H1 pattern does
  NOT apply); I6 reframed as an advisory narrowing guard (guest is unsandboxed
  → mitigates, not closes, the class bug) + use promisified `execFile`.
  Round 2 MEDIUM: §5 gate now states I5 is a hard precondition for the
  observation clock; §6 reframe (source-independence ≠ gate-independence);
  §8 row for the §5 remove-branch rollback surface; DoD (d) reworded. Round 2's
  HIGH cluster (root-cause over-assertion + gate reachability + task-shape
  denominator) **deferred to Lô B** for user decision. No source changes made.
- **2026-08-11 (loop review — Lô B applied, option B1):** §0 root-cause
  demoted from "the root cause" to a leading hypothesis (🔍 EXPLORE), with the
  three alternatives enumerated (short window / fast-fix workflow bias / no
  qualifying task shape) and the note that the 14-run sample cannot
  discriminate them. §5 gate gains (a) a task-shape precondition on the
  observation window (≥5 multi-step runs, not fast-fix only), and (b) two new
  branches: DEFER when adoption happens but value is unproven (no qualifying
  retry), and DEFER when the window was unqualified (only fast-fix). "Remove"
  now requires the task-shape precondition to have been met — preventing a
  false-negative verdict on an unqualified sample. No source changes made.
- **2026-08-11 (final coherence round + residual LOWs):** final review pass
  found the doc coherent (0 CRITICAL/HIGH). Fixed 2 MEDIUM citation errors: §0
  run glob `team_2026080910*`→`team_20260810*` (all 14 runs are 08-10); I5
  caveat `PI_CREW_BROKER_RUN_ID` line 278→**274** (re-verified via grep). Fixed
  LOWs: §0 "Secondary cause"→"Secondary factor" (root cause now a hypothesis);
  §5 DEFER branch corrected (retry fires on ANY error — `retryableErrors` empty
  — not only `ChildTimeout`) + explicit net-ROI-deferred note (R2#9); §5 gate
  bullet 1 notes the retry-scarcity tension; §8 "19 tests"→"19 test files" and
  env-injection range split (282-285 + ~290 for ARTIFACTS_ROOT, re-verified).
  No source changes made.
