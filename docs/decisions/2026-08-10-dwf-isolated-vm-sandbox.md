# ADR: DWF isolated-vm sandbox (E.1)

**Date:** 2026-08-10

## Status

Proposed — NOT implemented in this session. This ADR records
the design decision and the prerequisite work; the implementation is a
multi-week milestone, not a session task.

## Context

`src/runtime/goal-workflow/dynamic-workflow-runner.ts` runs `.dwf.ts`
scripts with **full Node access** (process, require, fs, child_process).
The F-01 trust gate (`:154-163`) default-denies project-sourced scripts
unless `PI_CREW_TRUST_PROJECT_DWF=1` is set; builtin and user workflows
proceed without restriction. `docs/dynamic-workflows.md:204-228` is
explicit that the content check for `require('child_process')` is
advisory and trivially bypassable. `workflow-create` and `workflow-save`
are arbitrary-code-execution surfaces.

This is acceptable for the single-user dev-machine trust model. It blocks
two product directions:

1. **Shared workflow marketplaces** — users cannot safely install
   third-party `.dwf.ts` workflows without auditing them line-by-line.
2. **Shared host / multi-tenant deployments** — any user who can write
   to the workflows directory can execute arbitrary code in the
   orchestrator's process.

The standard mitigation is `isolated-vm` — a real V8 isolate that gives
the script a JS runtime without Node host APIs.

## Decision

**Do NOT implement isolated-vm in this session.** It is a multi-week
milestone (rewrite of `WorkflowCtx`, migration of every `ctx.*` method
across the isolate boundary, perf measurement, and a migration window
for existing trusted workflows). This ADR records the decision and the
prerequisite plan so the work can be picked up deliberately.

### Prerequisites (must land before the sandbox)

1. **Audit every `WorkflowCtx` API surface** (`docs/dynamic-workflows.md`
   lists ~14 methods: `agent`, `fanOut`, `pipeline`, `review`, `retry`,
   `mail`, `gatherReplies`, `renderTemplate`, `vars`, `phase`, `log`,
   `budget`, `args`, `setResult`). For each, decide: stays in the
   isolate, crosses the boundary via `isolated-vm` refs, or is removed
   from the sandboxed API.
2. **Decide the trust tiering.** Three tiers are likely:
   - Builtin + user `~/.pi/agent/workflows/` → full Node (status quo).
   - Project `.crew/workflows/` with `PI_CREW_TRUST_PROJECT_DWF=1` →
     full Node (status quo).
   - Project workflows without the env opt-in, and any third-party
     marketplace install → isolate.
3. **Migration window.** Existing workflows that use `require` /
   `process` / `fs` will break in the isolate. Ship a dry-run mode
   (`PI_CREW_DWF_SANDBOX_DRY_RUN=1`) that logs what would be blocked,
   cut a release with the warning, then flip the default.
4. **Perf budget.** `isolated-vm` isolate creation is not free; the
   workflow runner currently caches the transpiled module. Measure the
   cold-start cost and decide on a warm-pool if needed.
5. **Timeout + memory limits.** The isolate must enforce
   `PI_CREW_DWF_SCRIPT_TIMEOUT_MS` (currently 30 min) and a memory cap
   that the host process does not have today.

### Implementation sketch (for the milestone PR)

- `npm install isolated-vm` (new runtime dependency — needs NOTICE +
  license check).
- Replace `loadWorkflowModule`'s `createRequire` + `jiti` path with an
  isolate-based evaluator.
- `WorkflowCtx` becomes an `isolated-vm` `Reference`-shaped object; each
  method marshals its arguments across the boundary.
- `ctx.setResult` stays the only path back to the host context (same
  isolation-by-design contract as today).
- The `Object.freeze(ctx)` defence (`dynamic-workflow-runner.ts:216`)
  stays — the isolate cannot add capabilities the host did not provide.

### Alternatives considered

1. **`node:vm` module.** Rejected: `node:vm` is NOT a security boundary
   (the script has full access to the V8 context and can break out via
   prototype-walking). `isolated-vm` uses a separate V8 isolate.
2. **WebAssembly-based sandbox (e.g. QuickJS-wasm).** Tentatively
   attractive but requires a transpilation step and loses Node-style
   ergonomics. Revisit if `isolated-vm` proves to block any platform in
   pi-crew's matrix.
3. **Status quo + tighter advisory check.** Rejected: the advisory check
   is documented as bypassable. Real sandboxing requires a real
   isolate.
4. **Delete `.dwf.ts` entirely.** Rejected: dynamic workflows are a
   documented feature with users. The sandbox is the path to keep the
   feature safe enough to share.

## Out of scope

- Sandboxing the scratchpad guest (separate threat model — the guest is
  spawned by pi-crew itself, not loaded from disk; E.2 HMAC addresses
  the snapshot-input vector).
- Sandboxing user-supplied agent system prompts (that is a prompt-
  injection problem, not a code-execution sandbox problem).

## References

- `docs/improvement-plan-2026-08-09.md` E.1
- `docs/dynamic-workflows.md:204-228` (advisory-check honesty)
- `src/runtime/goal-workflow/dynamic-workflow-runner.ts:154-163` (F-01
  trust gate, current mitigation)
- `docs/decisions/2026-08-10-scratchpad-snapshot-hmac.md` (companion
  hardening for the scratchpad surface)
