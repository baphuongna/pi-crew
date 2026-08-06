# Bug: provider-quota responses are attributed to the session model's provider, not the serving provider (live-session runtime only)

**Status**: OPEN — LATENT by default, conditionally triggerable via opt-in `live-session` runtime
**Severity**: Low (latent on default config; opt-in trigger; self-heals in 5 min; fully fixable in pi-crew)
**Found**: 2026-08-06, independent verification of provider-quota attribution
**Verified against**: active `pi` binary **0.83.0** (`which pi` → `…/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent`, `dist/cli.js`). An older 0.80.3 bundle exists under node v22.22.0 but is **not** the active binary; claims below were re-checked and hold on both.

> **Revision note (2026-08-06):** This doc supersedes the original draft. A four-round source
> verification (pi-dist claims, pi-crew source claims, live-session reachability, pi fallback
> existence) corrected two material errors in the original framing:
>
> 1. The original assumed **pi** has a "fallback chain" that serves provider B within a session
>    anchored to provider A. **pi has no such mechanism** — `agent.state.model` is only reassigned
>    via `setModel` / `_cycleScopedModel` / `_cycleAvailableModel` (user/extension-triggered) and a
>    same-identity registry refresh; it is **never** switched automatically on 429/error. The real
>    trigger is pi-crew's own **opt-in `live-session` runtime**.
> 2. The original claimed "`dist` contains no live-session path" to bound cross-session
>    contamination. **False** — the live-session branch is reachable on 0.83.0 (capability probe
>    passes). Process isolation only bounds the *default* `child-process` runtime.
>
> The plumbing findings (after_provider_response payload, `noteProviderResponse` full-overwrite,
> `_emitModelSelect` source set) were all re-confirmed and remain correct.

## Symptom

pi's `after_provider_response` event carries **only `status` and `headers`** — no provider, no
model, no session id. pi-crew therefore records quota data under the key
`providerOfModelRef(currentSessionModel())` (`src/extension/registration/lifecycle-handlers.ts:95-98`).

When a response is actually served by provider **B** while the tracked session model is provider
**A**, B's rate-limit headers (`x-ratelimit-remaining-*`, `retry-after`) are written to A's quota
entry. Two failure modes follow:

1. **Wrong deprioritization** — a 429 or `remaining < 5` from B records A as exhausted, so A is
   pushed to the back of the auto tail (`providerRankFromQuota`, `src/runtime/model/provider-quota.ts:191-209`,
   which assigns deprioritized providers `MAX_SAFE_INTEGER - 1`).
2. **Cleared deprioritization** — a successful B response with high remaining overwrites A's 429
   state (`noteProviderResponse` does a **full-replacement** overwrite at `provider-quota.ts:134-147`,
   with no "keep max-severity" guard), *undoing* a genuine rate-limit signal.

### IMPORTANT: when can A and B actually diverge? (corrected trigger)

The mis-attribution only matters if a response is served by a provider different from the tracked
session model. Verified trigger landscape:

- **Default `child-process` runtime** — each worker subagent is spawned as its own child process
  (`src/runtime/task-runner.ts:121` → `src/runtime/run-worker.ts:72` → `runChildPi`). The child
  seeds `currentSessionModel()` from the model pi-crew *chose for it*, so its anchor provider and
  its serving provider **always match**. **No mis-attribution is possible** in this mode.
- **Opt-in `live-session` runtime** (`runtime.mode: "live-session"` or `runtime.preferLiveSession: true`,
  OFF by default; see `src/runtime/model/runtime-resolver.ts:107-127`) — in-process subagents are
  created via pi's `createAgentSession({model})` SDK export
  (`src/runtime/live-session/live-session-runtime.ts`). These subagents share the main process's
  **module-scoped** `currentSessionModel()` tracker (`src/runtime/model/session-model.ts`), which
  reflects the **main** session's anchor model A. If pi-crew selects a **cross-provider** model for
  such a subagent (provider B), that subagent's `after_provider_response` is attributed to A. **This
  is the only path where the bug fires**, and it is a pi-crew process-global-tracker scoping issue —
  not a within-session provider switch by pi.

> **pi does NOT perform cross-provider fallback within a session** on 0.80.3 or 0.83.0. The HTTP
> layer (`streamFn`, `sdk.js:177-203`) retries the same request; the agent layer
> (`_prepareRetry`, `agent-session.js:2002/2119` in 0.80.3) backs off on the **same model**.
> Grep for `depriorit|provider-quota|autoTail|subagent|model-rout` in either `dist/` returns zero
> matches — these are exclusively pi-crew concepts.

## Evidence (active pi 0.83.0)

- `after_provider_response` emit, `dist/core/sdk.js:207-217` (byte-identical to the 0.80.3 bundle
  at `:208-216`):
  ```js
  onResponse: async (response, _model) => {
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("after_provider_response")) {
          return;
      }
      await runner.emit({
          type: "after_provider_response",
          status: response.status,
          headers: response.headers,
      });
  },
  ```
  No model/provider/session field on the event; the `_model` callback arg is genuinely ignored.
  Attribution can only come from the session model.
- `_emitModelSelect` call sites in `dist/core/agent-session.js` (0.83.0: def `:1200`; call sites
  `:1205` `"set"`, `:1244` `"cycle"`, `:1264` `"cycle"`). Sources are only `"set"` and `"cycle"` —
  **never `"restore"`**. The TypeScript type `ModelSelectSource = "set" | "cycle" | "restore"`
  (`dist/core/extensions/types.d.ts:577`) *permits* `"restore"`, but the runtime **never emits it**.
  This contradicts the assumption recorded in `src/runtime/model/session-model.ts:11-14` that "pi
  emits `model_select` ... on every set / cycle / restore". At session start the tracker is instead
  seeded from `extensionCtx.model` (the saved model, `lifecycle-handlers.ts:194`) — exactly the
  "stale saved model" value the module documented as unreliable.
  (The guard at `session-model.ts:45` — "session_start only seeds" — protects a
  `model_select`-sourced value from being overwritten, but since no restore event exists, the
  tracker is always seeded and can be overwritten by a later session's start.)
- Attribution chain: `lifecycle-handlers.ts:95-98` → `providerOfModelRef(currentSessionModel())`
  → `noteProviderResponse(provider, status, headers)` (`provider-quota.ts:134`). `noteProviderResponse`
  does `quotaCache.set(key, entry)` (`:146`) — a full-replacement overwrite, no merge/keep-severity.
- Live-session reachability: `isLiveSessionRuntimeAvailable()` (`runtime-resolver.ts:29-67`) probes
  the installed SDK for `createAgentSession`, `DefaultResourceLoader`, `SessionManager`,
  `SettingsManager`. All four are exported by pi 0.83.0 `dist/index.js`, so the probe returns
  `{available: true}` and the in-process branch (`task-runner.ts:141` → `live-executor.ts`) is
  importable and runnable with config opt-in.

## Scope / not a bug where you would expect (corrected)

- **Default `child-process` runtime**: worker subagents are isolated child processes; their
  `session_start` / `after_provider_response` mutate the child's own process-local tracker. Anchor
  provider == serving provider by construction. **No mis-attribution.**
- **Opt-in `live-session` runtime**: NOT bounded by process isolation — multiple in-process
  subagents share one module-scoped quota singleton, so cross-worker quota contamination is possible
  within the 5-min TTL window. The original draft's "process isolation bounds this" only holds for
  the default runtime.

## Impact bound

- Quota entries expire after `QUOTA_TTL_MS` (5 min, `provider-quota.ts:38`), so wrong entries
  self-heal after the TTL; they can still flip routing decisions within that window.
- The mis-attribution is **latent** unless the operator opts into `live-session` runtime. On the
  default `child-process` runtime it cannot fire.

## Suggested directions (re-prioritized after verification)

1. **[RECOMMENDED — fixes the real bug, pi-crew only]** Scope the live-model tracker per session/agent
   instead of process-global. Key `session-model.ts` state by `sessionId`/`agentId` so each in-process
   `live-session` subagent has its own tracker, and attribute its quota to its own anchor. No pi
   change required.
2. **[KEEP — defensive]** In pi-crew, stop recording quota for responses whose serving provider
   cannot be determined (the event gives no signal) rather than guessing A.
3. **[KEEP — narrow contract]** Record quota only from responses whose session model's provider is
   unambiguous, and treat every other response as "unknown" (`Number.MAX_SAFE_INTEGER` rank already
   exists as precedent, `provider-quota.ts:191-209`).
4. **[DEPRIORITED — addresses a non-existent problem]** The original suggestion to "have pi add a
   `provider` field to `after_provider_response`" targets a scenario that cannot occur (pi never
   switches providers mid-run). It is still a clean, general improvement to the event payload, but
   it is **not** the fix for this bug.

## Test seam

Add a unit test exercising the live-session path: register two in-process "sessions" with distinct
anchors `"provider-a/foo"` and `"provider-b/bar"`; record a `noteProviderResponse(provider = "provider-a", 429, headers)`
driven by an `after_provider_response` whose serving model is `"provider-b/bar"`; assert that
provider-a is the one deprioritized (or, after fix #1, that each session's tracker attributes to its
own anchor and there is no cross-contamination). Test seams `__test_resetProviderQuota` and
`__test_resetSessionModel` already exist.

## Verification trail

| Round | Focus | Verdict |
|---|---|---|
| 1 | pi-dist claims (`after_provider_response`, `_emitModelSelect` sources) | 3/3 MATCHES (byte-identical on 0.80.3; re-confirmed on 0.83.0) |
| 2 | pi-crew source claims (9 citations + 2 core-logic chains) | 7 MATCHES, 3 PARTIAL (citation-path imprecision), 0 WRONG; both failure modes supported by code |
| 3 | live-session reachability on 0.83.0 | REACHABLE (opt-in); original "no in-process path" claim FALSE |
| 4 | pi cross-provider fallback existence | NONE in either version; bug trigger re-framed to pi-crew live-session opt-in |

Citation path corrections vs the original draft:
- `lifecycle-handlers.ts` → `src/extension/registration/lifecycle-handlers.ts` (not `src/runtime/`)
- `provider-quota.ts` → `src/runtime/model/provider-quota.ts` (not `src/runtime/`)
- `runWorker` lives in `src/runtime/run-worker.ts` (not `task-runner.ts`)
- `isProviderDeprioritized` (`provider-quota.ts:160-175`) is a boolean predicate; the reordering
  action is `providerRankFromQuota` (`provider-quota.ts:191-209`).
