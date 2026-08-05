# Bug: chain run via team tool fails fast when `workflow:"chain"` is forwarded to steps

**Status**: FIXED (2026-08-05, commit `5b43d556`) — see fix below
**Severity**: Low (usability — easy workaround: omit `workflow`)
**Found**: 2026-08-05, during `real-test-pi-crew` Tier 9b chain spawn probe
**Discovered by**: iterative verification (post subagent-model-routing merge, commit `4148540e`)

## Symptom

Invoking the team tool with a chain expression **and** an explicit `workflow: "chain"` causes every
chain step to fail in ~58 ms with no error message:

```
team action='run' chain='"A" -> "B"' workflow='chain' team='fast-fix' goal='...'

→ Chain ended: 2 step(s), 1 handoff(s).
  ✗ Step 1 ["Reply]: failure (58ms)
  Total: 58ms
```

Note the empty error field — the failure surfaces as `failure (58ms)` with no `| <error>` text,
which makes it look like a silent/parse failure. It is NOT a parse failure: `parseChainString`
parses correctly (`run.ts:388` chain-dispatch runs, `parseChainDSL` returns 2 valid steps).

## Repro

```bash
# Fails (58ms, each step):
#   team action='run' chain='"stepA" -> "stepB"' workflow='chain' team='fast-fix'

# Works (omitting workflow — 2/2 steps success, ~308s):
#   team action='run' chain='"stepA" -> "stepB"' team='fast-fix'
```

The chain **does** work end-to-end when `workflow` is omitted — verified: 2/2 steps success,
2 handoffs, `runId`s captured. Unit tests (`test/unit/workflows/chain-runner.test.ts` +
`chain-executor.test.ts`) are 66/66 green, and a `/team-run --chain` slash command in a live
Pi session progressed through explorer/planner — so the chain path itself is healthy. The bug is
specifically the `workflow:"chain"` forwarding.

## Root cause

`src/extension/team-tool/chain-dispatch.ts` forwards the chain invocation's `params.workflow`
into the executor overrides:

```ts
const executor = new ChainTeamRunExecutor({
    handleRun,
    ctx,
    overrides: {
        team: params.team,
        workflow: params.workflow,   // ← forwards "chain" to every step
        model: params.model,
    },
});
```

`chain-executor.ts:244` then passes `workflow: stepWorkflow` (the forwarded `"chain"`) into each
step's `handleRun` call (`runParams.workflow`). In `run.ts:482`:

```ts
const workflowName = directAgent
    ? "direct-agent"
    : (params.workflow ?? team.defaultWorkflow ?? "default");
```

So each chain step ends up executing the **`chain` workflow** (`workflows/chain.workflow.md`) as a
normal team workflow. The `chain` workflow is a dispatcher-only workflow (it exists for the chain
runner); running it through the normal `executeTeamRun` path fails fast (~58 ms, before any worker
spawn) and the failure is recorded with an empty error string.

## Impact

- **Low**. Chain runs work correctly when `workflow` is omitted (the documented usage in
  `real-test-pi-crew` SKILL.md and chain-runner.ts:126 examples uses bare `chain='"a" -> "b"'`).
- The failure is confusing because it is silent (no error text) and fast (looks like a parse
  failure). An LLM driver that happens to set `workflow:"chain"` (plausible, since the action is a
  chain run) will see every step fail and may loop.

## Proposed fix

The chain invocation's `workflow` is meaningless — the chain runner manages step execution itself,
so the workflow override should NOT be forwarded to steps. Pick one:

1. **Minimal (chain-dispatch.ts)**: drop `workflow` from the executor overrides (a chain has no
   per-step workflow; steps use `team.defaultWorkflow`):
   ```ts
   overrides: {
       team: params.team,
       // workflow intentionally omitted — chain runner owns step execution
       ...(params.model ? { model: params.model } : {}),
   },
   ```
2. **Defensive (chain-dispatch.ts + run.ts)**: in `handleRun`, if `params.workflow === "chain"`
   and `params.chain` is unset (i.e. a chain step calling back in), fall back to
   `team.defaultWorkflow ?? "default"`.
3. **Validate (team-tool schema/handler)**: reject `workflow:"chain"` when `chain` is set, with a
   clear error message.

Option 1 is cleanest (the workflow param is semantically irrelevant for a chain run). Option 3
adds the best user feedback. Consider doing both 1 + 3.

## Fix applied (2026-08-05, GitHub #44)

All three options implemented + regression tests:

1. **`chain-dispatch.ts`** no longer forwards `workflow` into the executor overrides (chain runner
   owns step execution; steps use `team.defaultWorkflow`).
2. **`chain-executor.ts`** defensively drops a `"chain"` workflow override in `runTask`
   (`rawWorkflow === "chain" ? undefined : rawWorkflow`) — covers older callers that still forward it.
3. **`run.ts`** falls back to `team.defaultWorkflow ?? "default"` when `workflow === "chain"` and
   `params.chain` is unset, so a chain step calling back in never re-enters the un-runnable
   `chain` workflow.
4. **`chain-dispatch.ts`** rejects `workflow:"chain"` combined with a chain run with a clear
   message ("cannot be combined with a chain run … omit `workflow`").

Regression tests in `test/unit/workflows/chain-executor.test.ts`:
- `(bug-44) chain with workflow='chain' is rejected with a clear message`
- `(bug-44) executor drops a 'chain' workflow override and falls back to default team`
- `(bug-44) handleRun with workflow='chain' (no chain param) falls back to team default workflow`

Verified live: `handleRun({ team: 'fast-fix', workflow: 'chain' })` previously failed in ~116 ms
with the workflow-validation error; after the fix it resolves to the `fast-fix` workflow and runs
successfully (6:17 real run, status ok). `handleChainRun({ chain: '"a" -> "b"', workflow: 'chain' })`
now returns a clear rejection instead of the silent fast-fail.

## Verification plan (after fix)

- `team action='run' chain='"a" -> "b"' workflow='chain'` → succeeds (or rejected with a clear
  message under option 3), no 58 ms silent failure.
- Re-run `real-test-pi-crew` Tier 9b chain probe with `workflow:'chain'` → 2/2 steps success.
- `test/unit/workflows/chain-{runner,executor}.test.ts` remain green.
