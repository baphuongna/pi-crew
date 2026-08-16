# Schema-driven project-config sanitization (`sensitive: true` marks + drift gate)

**Date:** 2026-08-15
**Status:** Accepted — Phase 5 (steps 5.1 + 5.2) of the maintainability refactor; amended the same day by the Wave 1A remediation (see below)
**Relates to:** `src/schema/config-schema.ts` (sensitive marks), `src/schema/sensitive-config-paths.ts` (walk, NEW), `src/config/sanitize-project-config.ts` (derived drop-list + conditional drops), `src/config/config-validation.ts` (F19-5 bounds), `src/config/defaults.ts` (F19-6 precedence), `test/unit/config/config-sanitize-drift.test.ts` (S-R7 gate, NEW), `test/unit/config/config-schema-sync.test.ts` (structural parity, unchanged)

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

New marks (all old 21 + 3 additions = 24 paths; Wave 1A later added 2 more → 26, see the remediation section):

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

**Wave 1A update (same day):** that follow-up tiering work landed — the
special-case is now entry #1 of a declarative `CONDITIONAL_PROJECT_DROPS`
table (same drop semantics, byte-identical warning string). See the Wave 1A
remediation section.

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

These were prerequisites for this ADR’s walk (the walk only sees schema
surface, so schema and parser must agree first).

## Wave 1A remediation (same day, 2026-08-15)

Round 19 follow-ups F19-4/S19-1/S19-2 (guard-tiering), F19-5/S19-5 (parser
bound alignment), F19-6 (`DEFAULT_CONCURRENCY` two-source ambiguity), and
F19-7 (broker tiering) are fixed on top of the mechanism above. All changes
are gated by extending the drift gate to (i)–(ix).

### Conditional drops — `CONDITIONAL_PROJECT_DROPS` (F19-4 / S19-1 / F19-7)

Decision 3's single hardcoded `requirePlanApproval` conditional is
generalized into a small declarative table in `sanitize-project-config.ts`:
`Record<string, (value: unknown) => boolean>` mapping a dotted path to a
predicate over the project value. When the predicate holds (the value
LOOSENS a guard or disables an availability control) the key is dropped with
the standard warning; every other value survives untouched. The legacy case
is folded in as entry #1 with identical drop semantics.

Walk order: the unconditional `sensitive` pass runs FIRST, then the
conditional pass. One observable delta from the fold-in:
`runtime.requirePlanApproval`'s warning now emits after all unconditional
section warnings (previously inline within the runtime section; warning
string unchanged; no consumer asserts warning order). The schema walk
(`sensitive-config-paths.ts`) stays pure — conditional tiering lives
entirely in the sanitizer. Sections holding conditional keys but no
sensitive marks (`limits`, `reliability`, `broker`) integrate with the same
empty-object-collapse and no-input-mutation conventions.

| Path | Dropped when | Rationale |
|---|---|---|
| `runtime.requirePlanApproval` | `=== false` | Legacy precedent (Decision 3), unchanged: `true` tightens and survives |
| `runtime.completionMutationGuard` | `=== "off"` | S19-1: guards are active by default; the project may tighten to `warn`/`fail`, never disable |
| `runtime.effectivenessGuard` | `=== "off"` | S19-1: same tighten-only rule over its schema literals (`off`/`warn`/`block`/`fail`) |
| `limits.allowUnboundedConcurrency` | `=== true` | S19-1: unbounded concurrency is a resource-exhaustion loosening |
| `reliability.autoRecover` | `=== false` | S19-1: a project may not disable crash recovery |
| `reliability.scopeModels` | `=== false` | S19-1: a project may not opt out of model scoping |
| `broker.enabled` | `=== false` | F19-7 availability-only tiering: a project may ENABLE the broker, never disable it repo-wide. Non-availability broker fields (endpoint, headers, pathHashLen, …) are unmarked and pass through |

**Explicit NO-DROP: `limits.maxConcurrentWorkers`.** The schema types it as a
positive Integer and reader-side sanity ceilings apply, so an in-bounds
project value can only LOWER it — i.e. tighten. There is no expressible
loosening value, so a conditional entry would be dead code; its absence from
the table is asserted by the drift gate.

### Unconditional marks — inventory 24 → 26 (S19-2 / S19-5)

| Addition | Rationale |
|---|---|
| `goalWrap` (entire section: `enabled`, `maxTurns`, `evaluatorModel`, `verification.*`, `budgetTotal`, `budgetUnlimited`) | S19-2: kills unbounded-spend-via-untrusted-project-config (`budgetUnlimited: true`, attacker-chosen `evaluatorModel`) and silent auto-wrap. The mark sits on the section Record — terminal, same pattern as `agents.overrides` — so the walk collapses the subtree to the single path `goalWrap`. Consequence: `test/unit/runtime/goal-workflow/goal-wrap.test.ts` now feeds goalWrap through the USER config tier. |
| `autonomous.magicKeywords` | S19-5: `magicKeywords` alone flips effective autonomous mode on (`effectiveAutonomousConfig` defaults profile `"suggested"` when only `magicKeywords` is present) — a keyword planted in a repo config must not steer the leader into autonomy. |

### Parser bound alignment (F19-5 / S19-5) — `config-validation.ts`

Schema wins; violations parse to `undefined` (the existing `parseWithSchema`
bound style). Three seams:

- `observability.metricRetentionDays`: parser ceiling 365 → **90** (schema
  max 90). The review's "default 365 → 90" framing was in fact a CEILING, not
  a default: absent values still parse to `undefined`, and the effective
  runtime default is 7 days (`extension/registration/observability.ts`
  `?? 7`). The old behavior silently accepted 91–365 in violation of the
  schema; it never defaulted anything.
- `notifications.dedupWindowMs`: `Type.Integer({ minimum: 1000 })` (schema
  min 1000; 1–999 → `undefined`). The old parser-only 24 h ceiling is GONE —
  the schema has no maximum, so values >24 h are now accepted (schema wins in
  both directions). Absent → `undefined`; registration applies
  `DEFAULT_NOTIFICATIONS.dedupWindowMs` (30 s).
- `otlp.endpoint`: `Type.String({ minLength: 1, pattern: "^https?://" })` —
  non-http(s) endpoints (`unix://`, bare strings) parse to `undefined`,
  matching the schema.

Covered by `test/unit/config/config-validation-bounds.test.ts` (NEW) and
drift gate (ix).

### `DEFAULT_CONCURRENCY` two sources (F19-6) — `defaults.ts`

Every workflow entry was mapped to a live reader in
`defaultWorkflowConcurrency` (`src/runtime/scheduling/concurrency.ts`), so
**no entry was removed** — the table stays as the fallback for teams WITHOUT
frontmatter. Resolution behavior is unchanged; precedence is now documented
at the definition site and pinned by `test/unit/config/defaults.test.ts`:

team frontmatter `maxConcurrency` > `DEFAULT_CONCURRENCY.workflow[name]` >
fallback (2).

(`limits.maxConcurrentWorkers` may additionally override at the scheduler
level; the `DEFAULT_CONCURRENCY = 4` constant in
`src/extension/team-tool/parallel-dispatch.ts` is an unrelated local
constant.)

### Drift-gate coverage — now (i)–(ix)

`config-sanitize-drift.test.ts` extends the Phase 5.2 gate: (i) every
sensitive-marked path dropped from project config, (ii) every old-21 path
still marked, (iii) derived list ⊇ old hardcoded list, (iv) no orphan marks —
plus Wave 1A: (v) conditional-drop inventory pinned (including the explicit
`maxConcurrentWorkers` absence) + loosening values dropped / tightening
values survive + section collapse + no input mutation, (vi) `goalWrap`
subtree dropped, (vii) `autonomous.magicKeywords` dropped, (viii)
`broker.enabled === false` dropped while `=== true` and non-availability
fields survive, (ix) F19-5 parser bounds asserted through `parseConfig`.

## Wave B2 update (2026-08-15): crew-settings project-tier `scheduledJobs` opt-in gate

Wave 2B of the maintainability refactor closed the P1 crew-settings bypass
(`loadCrewSettings` + `applyCrewSettingsToConfig` applied a project-tier
`<cwd>/.pi/crew-settings.json` fragment raw over the sanitized config); the
sanitizer now routes the project fragment through `sanitizeProjectConfig` +
tight-only guard tiering (`src/runtime/settings-store.ts`,
`loadCrewSettingsTiers` / `applyCrewSettingsTiersToConfig`). One residual was
documented then and is now closed by an explicit gate: project-tier
`scheduledJobs` (and `schedulingEnabled`) still passed through after basic
validation, so a malicious repo shipping `.pi/crew-settings.json` could get
background jobs registered on session_start.

**Gate (leader decision, final):** project-tier `scheduledJobs` are DROPPED
(standard `projectOverrideWarning` with dotted path `scheduledJobs`) unless
the user-tier global file (`~/.pi/crew-settings.json`) explicitly opts in
with BOTH `schedulingEnabled: true` AND `allowProjectScheduledJobs: true`
(new optional `CrewSettings` field). `schedulingEnabled` itself is
user-tier-only: a project value is always dropped with a warning, whether
`true` or `false` — the project can neither enable nor disable scheduling.
The gate lives in the TIERS layer: `loadCrewSettingsTiers` exposes a gated
`effectiveScheduledJobs` view (user jobs always; project jobs only when
opted in, user-first concat) that the scheduler registration consumer
(`src/extension/registration/lifecycle-handlers.ts`) loops instead of the raw
`merged` view; `merged` semantics are unchanged (the write-path round-trip
depends on them). `allowProjectScheduledJobs` is user-tier-only SEMANTICS
enforced at the tiers layer — the flat `sanitizeSettings` allowlist merely
preserves the boolean so the opt-in survives the user-tier file read (a
project-tier `allowProjectScheduledJobs: true` is therefore meaningless).
The tighten-only philosophy of Wave 1A is intentionally NOT applied here:
jobs are not numeric bounds — allowing them is an availability decision the
human user makes in their global file.

**UX consequence (accepted):** `crew schedule add/update/remove` persists
jobs into the PROJECT file (`handle-schedule.ts` → `updateCrewSettings`).
Consequently, users of `crew schedule` must set BOTH flags in
`~/.pi/crew-settings.json` or their own previously-registered jobs stop
registering on session_start. This needs a README/CHANGELOG note
(follow-up; out of scope here).

**Non-relation:** the `docs/bugs/bug-026` follow-up is UNRELATED to this
gate and remains untouched.

## Out of scope — remaining follow-ups

The two ACCEPTED-FOR-NOW items of the original ADR (F19-4/S19-1/S19-2
guard-tiering including goalWrap, and F19-5/S19-5 bound alignment) are now
FIXED — see the Wave 1A remediation section above. Genuinely remaining:

- `observability.metricRetentionDays` has no explicit parser default (absent
  → `undefined`; effective default 7 days at registration). Giving it an
  actual default of 90 would change effective retention 7 → 90 days — a
  product decision, not a security fix; intentionally not taken in Wave 1A.

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
  §ROUND 19 Part A (F19-1/2/3, F19-4, F19-5; Wave 1A items S19-1/2/5, F19-6/7).
- Code: `src/schema/config-schema.ts`, `src/schema/sensitive-config-paths.ts`,
  `src/config/sanitize-project-config.ts`, `src/config/config-validation.ts`,
  `src/config/defaults.ts`.
- Tests: `test/unit/config/config-sanitize-drift.test.ts` (S-R7 gate + walk
  unit coverage + Wave 1A extensions (v)–(ix)), `test/unit/config/config-sanitize-merge.test.ts`
  (legacy shape; updated for the Wave 1A marks), `test/unit/config/f19-config-parity.test.ts`
  (F19 regressions, prior worker), `test/unit/config/config-validation-bounds.test.ts`
  (NEW — F19-5 bound matrix), `test/unit/config/defaults.test.ts` (F19-6
  precedence pins), `test/unit/runtime/goal-workflow/goal-wrap.test.ts`
  (rerouted to the user config tier).
