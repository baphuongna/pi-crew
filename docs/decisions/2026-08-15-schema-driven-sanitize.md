# Schema-driven project-config sanitization (`sensitive: true` marks + drift gate)

**Date:** 2026-08-15
**Status:** Accepted — Phase 5 (steps 5.1 + 5.2) of the maintainability refactor
**Relates to:** `src/schema/config-schema.ts` (sensitive marks), `src/schema/sensitive-config-paths.ts` (walk, NEW), `src/config/sanitize-project-config.ts` (derived drop-list), `test/unit/config/config-sanitize-drift.test.ts` (S-R7 gate, NEW), `test/unit/config/config-schema-sync.test.ts` (structural parity, unchanged)

## Context

`sanitizeProjectConfig` (Phase 2.2 split into `src/config/sanitize-project-config.ts`)
used a hardcoded drop-list of ~21 sensitive paths. Every future sensitive config
field had to be remembered and hand-added — forgetting one is a silent security
gap (review §ROUND 4 P3-S3, risk S-R7). Phase 5.1 moves the source of truth into
the TypeBox config schema and Phase 5.2 adds a drift gate so the migration can
never regress.

Round 19 additionally established that the three config surfaces had drifted
(`schema ≠ parser ≠ read`): F19-1/2/3 parity fixes were applied by a prior
worker BEFORE this ADR (verified: `parseModelFallbackConfig` +
`modelFallback` emission in `config-validation.ts`; `maxTotalSpawns` in the
retryPolicy schema; `consecutiveFailureThreshold`/`longRunningMinutes` in the
control schema and parser). With schema and parser now aligned, the
schema-walk premise of this ADR holds.

## Decision 1 — Mechanism: TypeBox Options metadata, NOT TypeRegistry/custom Kind

Sensitive fields are marked via the constructor Options object:
`Type.Boolean({ sensitive: true })`, `Type.Union([...], { sensitive: true })`,
`Type.Record(k, v, { sensitive: true })`, `Type.Object({...}, { additionalProperties:
false, sensitive: true })`.

**Evidence** (TypeBox 0.34.50, empirically verified by the Phase-1 explorer spike
against `node_modules/@sinclair/typebox/build/cjs`):

- `type/create/type.js` `CreateType`: `options !== undefined ? { ...options, ...schema }
  : schema` — unknown option keys are spread verbatim onto the emitted schema and
  never filtered.
- `type/optional/optional.js`: `Type.Optional` is a **flat spread modifier**
  (`{ ...schema, [OptionalKind]: 'Optional' }`), not an anyOf wrapper — marks on
  an Optional-wrapped property sit directly on `schema.properties[key]`; no
  unwrapping needed to find them.
- `value/clone/clone.js` (`getOwnPropertyNames` + symbols), `value/decode`,
  `value/clean` — Clone/Decode/Clean never strip string-keyed metadata;
  validation semantics (`Value.Check`, `additionalProperties: false`) are
  untouched by an extra `sensitive` key.

Note: `Type.String(schema, options)` — the two-arg form — is NOT in the
0.34.50 typings (single `options` parameter only), so on string schemas the
mark is inlined into the keywords object itself: `Type.String({ minLength: 1,
sensitive: true })` (`worktree.setupHook`, `otlp.endpoint`). Unknown keywords
are ignored by value validation, so this is equivalent to the Options form.

The rejected alternative, `TypeRegistry.Set` + `Type.Unsafe({ [Kind]: 'Sensitive' })`:
`Type.Unsafe` JSON-serializes to `{}` (loses all type info), requires
module-global registry state, and can break `additionalProperties: false`
value-checking if it replaces a typed schema. Custom Kind is for *validation
functions*, not metadata transport.

**Consequence**: `sensitive` is a plain enumerable key on schema objects. If a
`schema.json` generator is ever added (none exists today; `schema.json` is
hand-maintained and only top-level-key-checked), it must strip `sensitive`.

## Decision 2 — Sensitive inventory (old → new)

The drop-list is derived at runtime by walking `PiTeamsConfigSchema`
(`src/schema/sensitive-config-paths.ts`): marked properties are terminal
(Record/Object-valued marks like `agents.overrides`, `otlp.headers`,
`runtime.isolationPolicy` collapse to one dotted path); unmarked Object
properties are recursed; Union members are visited defensively.

Old hardcoded list (21 unconditional paths, frozen as fixture in the drift
gate): top-level `executeWorkers`, `asyncByDefault`,
`requireCleanWorktreeLeader`; `runtime.{mode, preferLiveSession,
allowChildProcessFallback, inheritContext, isolationPolicy, agentExtensions}`;
`autonomous.{profile, enabled, injectPolicy, preferAsyncForLongTasks,
allowWorktreeSuggestion}`; `worktree.setupHook`; `otlp.{headers, endpoint}`;
`agents.{disableBuiltins, overrides}`; `tools.{enableSteer,
terminateOnForeground}`.

New marks (all old 21 + 3 additions = 24 paths):

| Addition | Rationale |
|---|---|
| `policy.requireIntentForDestructiveActions` | S-R5 (§ROUND 4 P3-S). Latent gap: currently moot (user-wins merge + `false` default) but a malicious project config would take effect the day the default flips to `true`. Defense-in-depth. |
| `policy.disabledCapabilities` | S-R5, same class: a project could pre-weaken capability gating before a user has pinned the field. |
| `worktree.seedPaths` | S-R6: controls what gets copied into worktrees. Already mitigated by `normalizeSeedPaths()` (containment + symlink rejection in `worktree-manager.ts`), so marked as defense-in-depth only — a project file cannot influence which repo paths are seeded into worker worktrees. |

**Net behavior change** (the only one allowed by the plan): `policy.*` and
`worktree.seedPaths` are now dropped from project config with the standard
warning. No pre-existing test asserted that these survive project sanitize —
verified by grep before implementation; no test updates were required for this.

## Decision 3 — `runtime.requirePlanApproval` stays a hardcoded conditional

A boolean `sensitive` flag cannot express "drop only when `=== false`"
(the project may only *tighten*, never loosen, plan approval). The plan's
options were a predicate form (`sensitive: { when: ... }`), a hardcoded
special-case, or unconditional drop. **Chosen: keep the conditional as an
explicit hardcoded special-case inside `sanitizeProjectConfig`**, documented
with a comment, unmarked in the schema, and covered as a known-exception
assertion in the drift gate. No behavior change. A predicate form would
complicate every mark consumer for exactly one field; F19-4 proposes the same
"project may only tighten" pattern for guard fields as a follow-up tiering
work.

## Decision 4 — Legacy sanitize shape preserved verbatim

- Warning format: `` `${projectPath}: project-level sensitive config '<dotted>' is ignored; set it in user config to trust it explicitly` `` — byte-identical.
- Warning order: top-level first (legacy order `executeWorkers`, `asyncByDefault`,
  `requireCleanWorktreeLeader`), then sections in legacy order runtime →
  autonomous → worktree → otlp → agents → tools, with newly-marked sections
  (policy) appended in schema order. Within a section the sequence now follows
  schema declaration order — the only deltas vs legacy are cosmetic swaps of
  adjacent same-format warnings (`runtime.isolationPolicy`/`runtime.agentExtensions`,
  `otlp.endpoint`/`otlp.headers`); no consumer asserts warning order (tests use
  `.some()`).
- Empty-object collapse: a section whose defined keys were all dropped becomes
  `undefined`.
- Redaction quirk: `worktree`/`otlp` redact via `{ ...section, key: undefined }`
  (dropped key remains as an own `undefined` key) while other sections `delete`
  it — pinned by `config-sanitize-merge.test.ts`, preserved deliberately.
- `runtime`/`autonomous` are still replaced by a shallow copy even when nothing
  in them was dropped (legacy always-copy behavior).

## Decision 5 — F19-1/2/3 outcome summary (pre-applied, verified)

- **F19-1** `runtime.modelFallback`: parser now emits it (`parseModelFallbackConfig`)
  and `mergeConfig` deep-merges it (user-wins per key). Regression:
  `test/unit/config/f19-config-parity.test.ts`.
- **F19-2** `reliability.retryPolicy.maxTotalSpawns`: declared in the schema
  (was read+parsed but `additionalProperties: false` rejected it).
- **F19-3** `control.consecutiveFailureThreshold` / `control.longRunningMinutes`:
  declared in schema + parser (read-site defaults 3/10 preserved when unset).

These were prerequisites for this ADR's walk (the walk only sees schema
surface, so schema and parser must agree first).

## Out of scope — ACCEPTED-FOR-NOW follow-ups

- **F19-4 / S19-1 / S19-2 (guard-tiering)**: `runtime.completionMutationGuard`,
  `runtime.effectivenessGuard`, `reliability.{scopeModels, autoRecover}`,
  `limits.{maxConcurrentWorkers, allowUnboundedConcurrency}`,
  `goalWrap.*.verification.commands` remain project-settable. This ADR does NOT
  tier them user-only or project-tighten-only; a future ADR may extend the
  `requirePlanApproval` conditional pattern to them.
- **F19-5 / S19-5 (LOW bound alignment)**: parser/schema bound mismatches
  (`otlp.endpoint` minLength vs pattern, `metricRetentionDays` 365 vs 90,
  `dedupWindowMs` 1 vs 1000) are accepted as-is; aligning them is optional
  follow-up work with no security impact in scope here.

## Consequences

- Adding a sensitive config field is now: mark it in `config-schema.ts`. The
  sanitizer and warnings follow automatically; the drift gate fails if the mark
  is orphaned, if a legacy path loses its mark, or if the derived list stops
  covering the frozen old list.
- `collectSensitiveConfigPaths()` runs per sanitize call (config loading is not
  hot; ~100 properties walked).
- `PiTeamsAutonomyProfileSchema` remains exported for the parser
  (`config-validation.ts` parse path); `autonomous.profile` carries its own
  marked inline union in the config schema.

## References

- Plan: `docs/refactor-plan.md` Phase 5 rows 5.1/5.2 (Round 4 verdict SOUND-LOW,
  Round 19 premise update).
- Review: `docs/refactor-plan.review.md` §ROUND 4 P3 (S-R5/S-R6/S-R7),
  §ROUND 19 Part A (F19-1/2/3, F19-4, F19-5).
- Code: `src/schema/config-schema.ts`, `src/schema/sensitive-config-paths.ts`,
  `src/config/sanitize-project-config.ts`.
- Tests: `test/unit/config/config-sanitize-drift.test.ts` (NEW — S-R7 gate +
  walk unit coverage), `test/unit/config/config-sanitize-merge.test.ts`
  (legacy shape, unchanged), `test/unit/config/f19-config-parity.test.ts`
  (F19 regressions, prior worker).
