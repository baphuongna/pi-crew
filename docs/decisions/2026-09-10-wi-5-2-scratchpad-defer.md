# ADR — Scratchpad decision gate (WI-5.2)

**Date**: 2026-09-10
**Status**: ACCEPTED — **verdict: DEFER** (precondition window not satisfied)
**Refs**:
- pi-crew-upgrade-spec.md §5 M5 / WI-5.2
- docs/archive/improvement-plan-2026-08-11.md §5 (I5 follow-up)
- ADR 2026-08-12 (scratchpad HMAC REMOVED — anti-claim)

## Spec gate (verbatim)

> I5 đã live (metrics registered `contracts.ts:156-157`). Kiểm tra:
> cửa sổ quan sát đã trôi chưa + có ≥5 multi-step runs đủ điều kiện
> task-shape chưa (đọc event data thật). Đủ → verdict KEEP/REMOVE theo
> gate; thiếu → DEFER là verdict hợp lệ, không mở cửa sổ mù.
> KHÔNG re-add HMAC.

## Evidence (this window)

### Step 1 — metrics registered

```
src/state/contracts.ts:155-157:
  // RLM/scratchpad adoption metrics (plan I5)
  "scratchpad.cell",
  "scratchpad.restored",
```

✅ Live (registered in `TEAM_EVENT_TYPES`).

### Step 2 — observation window + ≥5 multi-step runs

```
$ grep -E "scratchpad\.cell|scratchpad\.restored" .crew/state/...
0 occurrences in real run data (last 30 days)
```

`grep -rh '"type":"scratchpad.cell\|"type":"scratchpad.restored"' .crew/state/` → **0 lines**.

The two metric event types are declared but NEVER EMITTED in any run
captured since registration. This means:

1. **No observation window exists** — even if a multi-step run included
   a scratchpad cell, no metric would fire because the wire-up is
   missing.
2. **`<5 multi-step runs` is not satisfiable** — there is no signal
   at all to count, let alone to evaluate.
3. **Multi-step task-shape detection** — same issue: without the metric
   emission path, we have no record of which runs even exercised
   scratchpad cell flow.

## Verdict

**DEFER.** Two reasons, both grounded in the spec gate text:

1. The gate asks for "≥5 multi-step runs đủ điều kiện task-shape". With
   0 emitted events, that count is "0 ≥ 5" — a hard precondition
   failure, not a soft one. Spec says: "thiếu → DEFER là verdict hợp
   lệ".
2. Re-evaluating without wiring the emit path is impossible. The emit
   path is I5's prescribed fix in `docs/archive/improvement-plan-2026-08-11.md`
   (§I5: use `appendEventFireAndForget` / `void appendEventAsync().catch(
   logInternalError)` — H1 pattern). Wiring that emit path ITSELF is
   separate work that should be a follow-up ADR (out of scope for WI-5.2).

## What is deferred, exactly

- The KEEP/REMOVE verdict on the scratchpad feature itself.
- Re-evaluation timing: deferred until EITHER:
  (a) I5 emit-path is wired AND ≥5 multi-step runs accumulate, OR
  (b) A different ADR elects to remove scratchpad without I5 evidence
      (e.g. because a successor feature replaces it).

## What is NOT deferred

- The facts above are recorded now so that future runs can be checked:
  anyone re-running this analysis can `grep .crew/state/...` and see
  if the count has reached the gate.
- This ADR is a source-of-truth answer for "what is the current
  scratchpad verdict" — the answer remains "DEFER, awaiting signal".

## Anti-claim check (spec §7)

- **Scratchpad HMAC REMOVED** (2026-08-12): NO re-add. ✅
- **Scratchpad spawn missing `detached`**: not touched.
- **crewHooks ACTIVE**: not touched.

## Re-open conditions

This ADR is superseded when ANY:
1. I5 emit-path is wired (follow-up PR) AND ≥5 multi-step runs accumulate
   real `scratchpad.cell` events → re-run analysis with new evidence.
2. A successor feature (e.g. host bridge per `host_request` reservation
   in `protocol.ts:48`) obsoletes scratchpad → new ADR with verdict
   REMOVE-with-replacement.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M5 / WI-5.2
- Plan: docs/archive/improvement-plan-2026-08-11.md §I5
- Event types: src/state/contracts.ts:155-157
- Run data: .crew/state/ (last 30 days; 0 emitted events)
