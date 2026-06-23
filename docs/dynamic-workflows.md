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
| `ctx.agent({role, prompt, model?, skill?, maxTurns?, inputs?, schema?})` | Spawn one agent, await `{ok, text, structured, artifactPath, usage}`. Concurrency enforced by `ctx.semaphore`. `schema?` (round-13) is a TypeBox schema — when set, output is validated and mismatch yields `ok:false`. |
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

## Determinism (round-13 P0-2)

Dynamic workflow scripts must be **deterministic** — the runner rejects
`Date.now()`, `Math.random()`, and `new Date()` at workflow-load time so that
two runs of the same script against the same inputs produce the same outputs.

The check uses an **AST walk** (not regex) so that:

- Prompts mentioning `Date.now()` as a string literal are accepted.
- Comments mentioning `Math.random()` are accepted.
- `Date.parse()`, `Date.UTC()`, `Math.floor()`, etc. are accepted (only `now`
  and `random` are blocked).
- `Date["now"]()` is also blocked — the bracket-property is resolved to the
  string `"now"` statically before the comparison.

**Escape hatch:** set `PI_CREW_DWF_SKIP_DETERMINISM_CHECK=1` to bypass the
check (intended for benchmark scripts that intentionally depend on time or
randomness). The check is **enabled by default**.

```ts
// .crew/workflows/deterministic.dwf.ts
export default async function (ctx) {
  // OK: Date.parse and Math.floor are permitted.
  const ts = Date.parse("2024-01-01");
  const rounded = Math.floor(3.14);

  // OK: Date.now() in a string literal.
  const label = "Date.now() is forbidden at runtime";

  // REJECTED at load time:
  // const t = Date.now();
  // const r = Math.random();
  // const d = new Date();
}
```

When the check fails, the runner throws a clear error before `jiti` executes
the script:

```
Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are
unavailable. These introduce non-reproducible behavior across runs. Use ctx.vars
for cached state, or pass a fixed seed via ctx.setArgs(). To bypass this check
(escape hatch), set PI_CREW_DWF_SKIP_DETERMINISM_CHECK=1.
```

## Structured output (round-13 P0-3)

Dynamic workflow scripts can request **typed JSON output** from `ctx.agent()` by
passing a TypeBox `schema` in the call opts. When set, the runner validates the
extracted JSON against the schema and returns `ok:false` with a clear error on
mismatch.

```ts
// .crew/workflows/typed-agent.dwf.ts
import { Type, type Static } from "@sinclair/typebox";

const ReviewSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal("accept"),
    Type.Literal("reject"),
    Type.Literal("changes_requested"),
  ]),
  feedback: Type.String(),
});
type Review = Static<typeof ReviewSchema>;

export default async function (ctx) {
  const result = await ctx.agent({
    role: "reviewer",
    prompt: "Review the diff and judge.",
    schema: ReviewSchema, // <-- new round-13 field
  });
  if (!result.ok) {
    // result.error explains what didn't match.
    ctx.setResult("/tmp/error.md", { error: result.error });
    return;
  }
  const review = result.structured as Review;
  // review is now type-checked as Review.
  ctx.setResult("/tmp/review.md", { review });
}
```

Backwards compatibility: when `schema` is **omitted**, behavior is identical to
the previous regex-based extractor. Existing scripts that don't pass a schema
continue to work unchanged.

**How it works:** the runner appends a JSON-output instruction to both the agent's
system prompt (so it knows the expected shape) and the user prompt (so the
output directive is the last thing the model reads). After the agent emits its
final text, the runner validates against the schema using `Value.Check`.
Validation failure surfaces as `ok:false, error: "structured output does not
match schema: ..."`.

## Abort listener cleanup (round-13 P0-5)

`runChildPi` registers two abort listeners on the parent signal (the `abort`
handler that cancels the child process and the `onParentAbort` handler that
sets the internal `abortDueToParentSignal` flag). Both are removed in the
`settle()` function so they do not leak when many child-pi calls share one
AbortSignal (the common pattern under `background-runner`).

The fix was originally landed in round 27 (BUG 4). Round-13's audit confirmed
the cleanup is correct: both `input.signal?.removeEventListener("abort", ...)`
calls fire before `settle()` returns, regardless of whether the run completed
normally, hit a timeout, or was aborted. No code changes were needed.

## Isolation

Worker output → artifact file (via `runChildPi` + `writeArtifact`). The dynamic runner
holds results only in JS variables + `ctx.vars`. Only `ctx.setResult(artifactPath)` is
read back into the tool result returned to the main context — mirroring the static
workflow `summary.md` contract. The orchestrator's context never holds raw worker
output.
