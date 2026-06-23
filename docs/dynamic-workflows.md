# Dynamic Workflows (`.dwf.ts`)

pi-crew v0.9.0 introduces dynamic workflows, modeled on Claude Code's Dynamic Workflows.

## What it does

A dynamic workflow is a `.dwf.ts` script whose default export orchestrates subagents
with normal JavaScript (`for`/`while`/`if`/`switch`). It runs in the background, calls
subagents per phase via `ctx.agent()` / `ctx.fanOut()`, holds intermediate results in
JS variables, and only `ctx.setResult()` reaches the main context — keeping the plan
and intermediate data out of the main context window.

```ts
// .crew/workflows/security-audit.dwf.ts
export default async function (ctx) {
  const endpoints = [/* ... */];
  const shards = chunk(endpoints, 3);

  ctx.phase("Scan");  // round-12: mark the start of a logical phase
  const reports = await ctx.fanOut(shards, 3, (s) =>
    ctx.agent({ role: "explorer", prompt: `Audit ${s.join(",")} for auth + input validation` })
  );

  ctx.phase("Synthesize");
  const synth = await ctx.agent({ role: "analyst", prompt: "Merge + dedupe findings", inputs: reports.map(r => r.artifactPath) });

  ctx.phase("Review");
  for (let i = 0; i < 3; i++) {
    const review = await ctx.review(synth.taskId, "reviewer");
    if (review.outcome === "accept") break;
    await ctx.retry(synth.taskId, { feedback: review.feedback });
  }

  ctx.setResult(synth.artifactPath, { summary: "security audit complete" });
}
```

## Usage

Place the script under `.crew/workflows/<name>.dwf.ts`, then:

```
team action='run', workflow='security-audit', goal='Audit src/routes'
```

Slash command: `/workflows` lists all workflows (static + dynamic).

## WorkflowCtx API

| Method | Purpose |
|---|---|
| `ctx.agent({role, prompt, model?, skill?, maxTurns?, inputs?})` | Spawn one agent, await `{ok, text, structured, artifactPath, usage}`. Concurrency enforced by `ctx.semaphore`. |
| `ctx.fanOut(items, limit, fn)` | Bounded parallel fan-out (wraps `mapConcurrent`). |
| `ctx.review(taskId, reviewerRole?)` | Run a reviewer; parse `{outcome, feedback}`. |
| `ctx.retry(taskId, {feedback?})` | Re-run with feedback (wraps `executeWithRetry`). |
| `ctx.mail(to, body, opts?)` | Mailbox message to another agent/leader. |
| `ctx.gatherReplies(ids, deadlineMs)` | Block until N replies arrive or deadline. |
| `ctx.renderTemplate(name, vars)` | Render a built-in plan template. |
| `ctx.vars` | Script-local variables. |
| `ctx.phase(title)` | Mark the start of a named workflow phase. Emits `dwf.phase_started` (and `dwf.phase_completed` for the previous phase, if any) to the run's events.jsonl. Idempotent on the same title. Phase events let downstream consumers (UI, log readers) group agents by logical phase. |
| `ctx.setResult(artifactPath, meta?)` | Mark the final result. ONLY this reaches the main context. |

`ctx.agent({role})` resolves the role to an `AgentConfig` via 4-tier precedence:
explicit `agent` name → `team.roles[].agent` → `discoverAgents` by name → synthesize
minimal (`source:'dynamic'`).

### Phases (round-12)

`ctx.phase(title)` lets the script mark logical phases. Each call:

- Emits a `dwf.phase_started` event with `{phase: title}` to the run's `events.jsonl`.
- If a previous phase is still open, emits a `dwf.phase_completed` event for it
  **before** opening the new one (so consumers never see two open phases at once).
- Is idempotent: calling `ctx.phase("Scan")` twice does not emit a duplicate event.
- Validates the title (non-empty string, otherwise `TypeError`).
- Caps the in-memory `phases[]` list at 100 distinct titles (events still flow past
  the cap; the events log is the durable source of truth).
- The runner auto-closes the last open phase when the script returns, so
  `dwf.completed` is always preceded by a matching `dwf.phase_completed`.

## Security model (IMPORTANT)

`.dwf.ts` files are **postinstall-equivalent trust** — treat them as `node script.js`.

**v1 boundary (honest):** The `WorkflowCtx` is `Object.freeze()`d and exposes ONLY
the documented methods — but the script otherwise runs in **plain module scope** with
full access to `require`/`import`/`process`. There is **no vm sandbox in v1**; the
script can reach `process`/`require` directly or via constructor walking. The
"capability-locked ctx" is the documented contract surface, not a security boundary.

- The path-allowlist (`resolveRealContainedPath`) limits **WHERE** scripts load from
  (`.crew/workflows/`, `<proj>/.pi/teams/workflows/`, `~/.pi/agent/extensions/pi-crew/workflows/`),
  not what they can do.
- `isolated-vm` (real V8 isolate) is planned for **v1.5**.
- **Only place `.dwf.ts` files you have reviewed** in `.crew/workflows/`.

`workflow-create` and `workflow-save` are arbitrary-code-execution (ACE) surfaces and are gated:
- Require `confirm:true` (enforced by `destructive-gate.ts` at the tool_call layer).
- **User-initiated only** — the agent MUST NOT auto-invoke them.
- Path-allowlisted via `resolveRealContainedPath` (TOCTOU-safe, not `startsWith`).
- Content validation rejects obvious `require('child_process')`, `process.exit`, and
  network-import patterns — but this is **advisory only and trivially bypassable**
  (e.g. `require('child'+'_process')`, `globalThis.process.mainModule.require`).
  The real boundary is commit-review + the path-allowlist, not the content check.

## Isolation

Worker output → artifact file (via `runChildPi` + `writeArtifact`). The dynamic runner
holds results only in JS variables + `ctx.vars`. Only `ctx.setResult(artifactPath)` is
read back into the tool result returned to the main context — mirroring the static
workflow `summary.md` contract. The orchestrator's context never holds raw worker
output.
