# Pi 1.0.0 SDK Adoption Review — pi-crew

- **Date:** 2026-10-03
- **Run:** `team_20261003094832_beeed264e89afa71` (parallel-research: 4 explorer shards → synthesis → this review)
- **Scope:** Adoption-gap review of the Pi 1.0.0 SDK surface for pi-crew. **Not** a compatibility
  review — the compat wave and E1 re-eval were already green on 2026-10-03. pi-crew pins the full
  `@earendil-works/*` family at `^1.0.0`; the host session runs 1.0.0; npm has nothing newer.
  "Upgrade" here means: (a) remove future-break risk, (b) adopt new capability in place of
  workarounds.
- **MCP exposure:** reviewed separately in
  [docs/mcp-exposure-design-review-2026-10-02.md](../mcp-exposure-design-review-2026-10-02.md) §9
  (KEEP-STATUS-QUO). Not re-opened here. One new signal since §9 is noted in §Q2(e).
- **Inputs:** tarball extracts `/tmp/pi100/package` (1.0.0) and `/tmp/pi100/p0992/package` (0.99.2);
  installed type defs + docs under `node_modules/@earendil-works/*`; pi-crew `src/` (read-only).

## Provenance legend

Citations are tagged:

- **[V]** — verified directly in this run by reading the cited file:line (07_write spot-checks and
  the 06_synthesize re-verification pass).
- **[S]** — shard evidence pack (04 explorer shards, each self-verified with file:line); not
  re-opened by 07_write. Shard counts that disagree with the parent prompt are called out inline.

---

## Executive summary

**Stability verdict: CLEAN.** 0 of 93 import sites touch any `@deprecated` / `@internal` /
`@experimental` marker in the 1.0.0 type defs. The four markers that exist all sit on surfaces
pi-crew does not import (OAuth callback flag, model-resolver/model-runtime internals). The
0.99.2 → 1.0.0 type diff is additive except for one signature change (`forServer`) that pi-crew
does not use. There is no API pi-crew imports today that is scheduled to break.

**Adoption is the real work.** 1.0.0 adds no exit-reason or resume capability (Q2a answer is
*no*), but the pre-existing session-file + `--session-id` / `--session-dir` surface — which
pi-crew already writes but never reads back — is a native fix for the runner-died-near-end class.
The fullscreen-by-default change is the only behavior change that can silently alter pi-crew's
surfaces and cannot be settled by static analysis; it gates on a live probe.

### Adoption backlog

| ID | Item | Pain point / motive | Key evidence | Priority | Effort |
|----|------|--------------------|--------------|----------|--------|
| P0-1 | Verify all pi-crew surfaces under fullscreen-by-default; pin `--tui-mode` on spawned surface processes | 1.0.0 changed default TUI mode; overlays/dashboard/pane-scraping may render differently | CHANGELOG 1.0.0 "Changed" [V]; `src/runtime/surface/surface-spawn.ts:142-149` spawns a TUI variant without mode pinning [V] | P0 (verify) | S probe / S fix |
| P1-1 | Session-file recovery for SIGKILL'd runners: capture session header id at spawn, replay tail on `exitCode === null` | runner-died-near-end: host killed exit=137 while background run completed | `src/runtime/model/pi-args.ts:266-267` workers already persist sessions [V]; `docs/json.md:23-28` header record [V]; `src/runtime/child-pi/child-pi.ts:903-968` exit-status settle [V] | P1 | M |
| P1-2 | Audit every arg-builder path for `--provider` without `--model` | was silently ignored, now **errors** (#10236) | `docs/cli.md:63-64` [V]; CHANGELOG 1.0.0 Fixed [V] | P1 | S |
| P1-3 | Hygiene: adopt pi-tui `TruncatedText`; drop dead `persist:true`; retire version-guard shims | duplication + dead code under the `^1.0.0` floor | `pi-tui/dist/index.d.ts:17` [V]; `src/ui/widget/index.ts:525` passes `persist` [V]; `src/ui/pi-ui-compat.ts:47` strips it [V] | P1 | S–M |
| P2-1 | `ctx.modelRegistry.classify()` for host-side cheap decisions (retry triage, routing hints) — spike first | subagent turns are expensive; classifiers answer typed questions | `docs/models.md:137-138` [V]; host-process only (see Q2c) | P2 | M spike |
| P2-2 | Compaction hooks `session_before_compact` / `generateSummary()` in the injected prompt-runtime extension | control worker auto-compaction, custom summaries | `docs/compaction.md:296-313`, `:167-171` [V]; `pi-args.ts:318` unconditional `--extension` [V] | P2 | M |
| P2-3 | RPC mode (`RpcClient` / `runRpcMode`) for controllable long-lived workers | replace one-shot `-p` stdout parsing for steering-heavy roles | `dist/index.d.ts:34` exports [V]; `docs/cli-integration.md` "Control Pi with RPC" | P2 | L |
| P2-4 | Virtual models (per-request routing), `prepareLoadout()` + `ctx.executeTool()`, `fuzzyFilter`, staged drop of `@mariozechner` fork probe | fit model-fallback; tool composition; autocomplete; shrink out-of-semver surface | `dist/index.d.ts:27` virtual-model types [V]; CHANGELOG 0.99.0 Added [V]; `pi-tui/dist/index.d.ts:19` [V]; `src/runtime/peer-dep.ts:48` [V] | P2 | per item |

Effort: S < 1 day, M = days, L = week+.

---

## Q1 — Stability: does anything pi-crew imports carry a stability marker?

**Method.** Shard census of pi-crew import sites (recounted by shards; the parent prompt's grep
said 92 — the difference is non-material): **93 sites**, all package-root, no deep subpaths:

| Package | Import sites | Markers in 1.0.0 type defs | Sites touching markers |
|---|---|---|---|
| `@earendil-works/pi-coding-agent` | 68 | 4 (2× `@deprecated`, 2× `@internal`) | **0** |
| `@earendil-works/pi-tui` | 21 | **0** — component/widget API carries no markers; exports incl. `TruncatedText`, `fuzzyFilter`, `TuiMode` are unannotated | **0** |
| `@earendil-works/pi-ai` | 2 | `@deprecated` exists only in `compat.d.ts` / `legacy-api-aliases.d.ts`; pi-crew imports only the `Message` / `AssistantMessage` types | **0** |
| `@earendil-works/pi-agent-core` | 2 | **0** | **0** |

### The four SDK markers, all unused by pi-crew [V]

| Marker | Location (1.0.0 type defs) | What it marks | pi-crew usage | Risk |
|---|---|---|---|---|
| `@deprecated` | `pi-coding-agent/dist/core/extensions/types.d.ts:1410` — `ExtensionOAuthConfig.oauth.usesCallbackServer` | "Retained for source compatibility; canonical auth flows ignore it" | none | none — do not import |
| `@deprecated` | `pi-coding-agent/dist/core/provider-composer.d.ts:8` — same member on the provider surface | same | none | none |
| `@internal` | `pi-coding-agent/dist/core/model-resolver.d.ts:37` — `parseModelPattern` | "Exported for testing" | none | none |
| `@internal` | `pi-coding-agent/dist/core/model-runtime.d.ts:84` — `getCompatibilityRequestConfig` | compat fallback for unconfigured provider auth | none | none |

**Widget API stabilised?** Yes, de facto: pi-tui 1.0.0 type defs contain zero stability markers
(shard grep across the installed package) [S], and the pi-tui surface pi-crew uses (21 root
imports) is unannotated public API.

### 0.99.2 → 1.0.0 type-surface diff

Additive [V, tarball diff via shards]: `QuietStartup` + `quietStartup: "header"` (exported at
`dist/index.d.ts:22` with `TuiMode`, `FullscreenExitOutput` [V]), `models.generateImages()`,
`oauth.authServerMetadataUrl` (type at `dist/core/mcp-servers.d.ts:69` [V]).

One breaking change, unused by pi-crew: `McpOAuthCredentialStore.forServer(serverUrl)` became
`forServer(name, serverUrl)` — `dist/extensions/mcp/oauth.d.ts:44` [V], matching the CHANGELOG
entry "MCP OAuth credentials are now stored per server name and URL". pi-crew does not import
this class. Extension-facing types are otherwise byte-identical between 0.99.2 and 1.0.0 [S].

**Future-break risk ranking: LOW overall.** No imported symbol is marked; the only semantic
landmines are (1) the fullscreen default (behavior, not API — P0-1) and (2) `--provider`
without `--model` now erroring (P1-2).

---

## Q2 — Adoption: what can pi-crew take from 1.0.0 (and what was already there)?

### (a) runner-died-near-end — exit reasons, session state, resume

**Answer: 1.0.0 adds nothing here.** No structured exit-reason object, no new session-state-file
contract, no new programmatic resume API appears in the 1.0.0 CHANGELOG [V] or the
`-p` mode docs. Exit semantics are unchanged and deliberately lossy for pi-crew's case:
json mode "does not by itself produce a nonzero exit status" on a failed/aborted response
(`docs/cli-integration.md:46` [V]) — pi-crew's distrust of exit codes is **by-design correct**.

The un-adopted native capability is *pre-existing*: worker sessions are already persisted.

- Workers always spawn `--mode json -p` and only add `--no-session` when
  `sessionEnabled === false` — i.e. **worker session files are being written today and never
  read back** (`src/runtime/model/pi-args.ts:266-267` [V]).
- The first JSONL record on stdout is the session header carrying the session id
  (`docs/json.md:23-28` [V]); `agent_settled` marks the end of automatic work for the run
  (`docs/cli-integration.md:51` [V]). pi-crew's `src/runtime` currently has **zero** usage of
  `session-id` / `session-dir` / `agent_settled` (grep, re-run by 06_synthesize: 0 hits).

**Proposal (P1-1), incremental — no mode change:**

1. Capture the session id from the first-record header at spawn (or make it deterministic with
   `--session-id <id>`, which "opens the exact project session ID or creates it if absent" —
   `docs/cli.md:92-93` [V]) and store it on the task/run record.
2. Consider `--session-dir` pointed at run state (`.crew/state/...`) so worker sessions live with
   the run instead of `~/.pi/agent/sessions/` (`docs/cli.md:96-97` [V]; `docs/sessions.md:50` [V]
   documents the override precedence CLI > env > setting).
3. On signal death (`exitCode === null` in the exit-status settle path,
   `src/runtime/child-pi/child-pi.ts:903-968` [V] — the code already models `killed` /
   `timedOut` / final-drain race state), replay the session file tail to recover the final
   assistant message and settled state. This *augments* manifest polling with an authoritative,
   ordered record; it does not replace it.

### (b) Headless `-p` mode: flags, exit codes, resume

Correction carried from synthesis: **pi-crew already runs `--mode json -p` for every worker**
(`pi-args.ts:266` [V]); the surface/TUI variant strips that cluster
(`src/runtime/surface/surface-spawn.ts:142-149` [V, re-verified by 06_synthesize]). So the
question is not "adopt `-p`" but "what changed around it":

- `--provider` now **requires** `--model` and errors otherwise (`docs/cli.md:63-64` [V];
  CHANGELOG #10236). → P1-2: audit every arg-builder path (today `pi-args.ts` pushes `--model`
  only when a model resolves — confirm no path emits provider-only).
- `--session-id` / `--session-dir` / `--no-session` semantics as in (a); `--fork` constraints
  (`docs/cli.md:78-101` [V]).
- Exit codes: unchanged; error-vs-abort distinction remains event-stream-only
  (`docs/cli-integration.md:44-51` [V]). Nothing here replaces stdout parsing; RPC mode (P2-3)
  is the structured alternative if one-shot `-p` parsing ever becomes the bottleneck.

### (c) codemode / non-LLM classifiers

Two distinct surfaces — an earlier shard conflated them; the correction is load-bearing:

1. **Codemode-script surface** — `models.classify()` inside `codemode` scripts
   (`docs/models.md:116-131` [V]). Model-invoked JS sandbox; not usable for pi-crew's own
   orchestration decisions.
2. **Extension surface** — "Extensions call classifiers through `ctx.modelRegistry.classify()`,
   without codemode" (`docs/models.md:137-138` [V]). Callable from pi-crew's **host-process**
   extension code; **not** callable from child `pi -p` workers (separate processes, no `ctx`).

**Recommendation (P2-1, spike):** classify() is docs-proven but cost/latency-unproven in this
environment (classifier availability depends on provider keys — `docs/models.md:106-112` [V]).
Spike candidates that run in the host: retry/failure classification before burning an expensive
re-attempt, and cheap task→agent routing hints. Do not route *subagent turns* through codemode —
that surface belongs to the model, not the orchestrator.

### (d) Compaction hooks for worker context

- `session_before_compact` fires before auto-compaction and `/compact`; can cancel or supply a
  custom summary (`docs/compaction.md:296-313` [V]).
- `generateSummary()` / `generateSummaryWithUsage()` give direct programmatic summarization
  (`docs/compaction.md:167-171` [V]).

**Condition, stated explicitly:** these are extension events. They matter for workers only where
an extension is loaded — and pi-crew already injects the prompt-runtime extension into every
worker unconditionally (`pi-args.ts:318` pushes `--extension PROMPT_RUNTIME_EXTENSION_PATH` [V]),
so a listener could be added there to control/observe worker auto-compaction. Whether the hooks
fire identically in `-p` json mode has **not** been verified live — gate P2-2 on a probe before
building on it.

**Name-collision warning:** pi-crew has its own internal `prepareCompaction`
(`src/runtime/event-log-rotation.ts:260` [S]) — unrelated to the SDK's `prepareCompaction()`
(compaction.md:167 [V]). Keep the names straight in review.

### (e) Everything else from the diff

**P1-3 hygiene [V where cited]:**

- Adopt pi-tui `TruncatedText` (`pi-tui/dist/index.d.ts:17` [V]) across the ~10 files doing
  manual truncation [S].
- `persist: true` passed at `src/ui/widget/index.ts:525` [V] is dead: `pi-ui-compat.ts:47`
  destructures it out before calling the host `setWidget` [V]. Delete both sides.
- The version-guard shims in `pi-ui-compat.ts` are dead weight under the `^1.0.0` floor [S] —
  retire with the next breaking-ish cleanup.

**P2 batch:**

- Virtual models — per-request routing (`ModelRoute`, `VirtualModelDefinition`,
  `dist/index.d.ts:27` [V]; `docs/virtual-models.md`); natural fit for model-fallback.
- `prepareLoadout()` + bounded `ctx.executeTool()` (CHANGELOG 0.99.0 Added [V]) for pi-crew's
  custom tool composition.
- `fuzzyFilter` (`pi-tui/dist/index.d.ts:19` [V]) for any pi-crew autocomplete surface.
- Staged drop of the `@mariozechner/pi-coding-agent` fork probe (`src/runtime/peer-dep.ts:48`
  [V]) — it sits outside the earendil semver guarantees; confirm no install base needs it, then
  remove.

**Free wins (no pi-crew action) — with corrected release attribution:**

- Transcript heap: a long assistant message keeps ~1/5 of previous heap (CHANGELOG 1.0.0 Fixed [V]).
- Prompt-submission slowdown and model-catalog merge quadratic fix landed in **0.99.2**, not
  1.0.0 (CHANGELOG 0.99.2 Fixed, #10198 [V]) — both already in effect under the `^1.0.0` pin;
  the synthesis had lumped them under 1.0.0.
- Deferred MCP tools loaded by `tool_search` are no longer dropped on resume / `/reload`
  (CHANGELOG 1.0.0 Fixed [V]). New signal since §9 but adjacent to E1, not E1 itself: §9's
  KEEP-STATUS-QUO verdict is unchanged.

---

## Q3 — Hygiene: semver floor, peer/dev deps, pre-1.0 leftovers

**Keep `peerDependencies: "*"` + `devDependencies: ^1.0.0`.** The SDK's own packaging rule for
extensions mandates `peerDependencies` with a `"*"` range for host-provided packages and forbids
listing them in `dependencies` (`docs/packages.md:88` [V]). devDeps at `^1.0.0` give typecheck a
real floor without violating the rule.

**Bump-only-on-adoption.** Nothing proposed in this review *imports* a 1.0.0-only symbol — P1-1
uses CLI flags that predate 1.0.0, P1-2/P1-3 are removals. First genuine bump trigger: adopting
a 1.0.0-only API (e.g. `generateImages()`, `QuietStartup`). Until then, `^1.0.0` is correct.

**No pre-1.0 semver-major risk found.** pi-crew's pi-ai imports are type-only (`Message` /
`AssistantMessage`) and never touch the legacy-alias compat layer [S]. The four marked SDK APIs
are unused (Q1). Protect this state with CI grep-guards:

1. fail on any import resolving `@earendil-works/pi-ai` compat / legacy-api-aliases paths;
2. fail on `usesCallbackServer`;
3. warn on `@mariozechner` (tracks the P2 staged drop).

**engines mismatch (real, small):** the SDK declares `engines: { "node": ">=22.19.0" }`
(`pi-coding-agent/package.json` [V]) while pi-crew declares `>=22.0.0` (`package.json:13-15` [V]).
A user on Node 22.0–22.18 satisfies pi-crew but runs an SDK that declares itself unsupported.
Recommend aligning pi-crew's engines to `>=22.19.0` (or documenting the effective floor) in the
next release.

---

## Method & verification

Directly verified in this run (07_write, read-only spot-checks of the load-bearing citations):
`pi-args.ts:259-318`; `pi-coding-agent/docs/{cli,models,json,cli-integration,sessions,compaction,packages}.md`
at the cited lines; `dist/core/{extensions/types,provider-composer,model-resolver,model-runtime,mcp-servers,auth-…}.d.ts`
at the cited lines; `dist/extensions/mcp/oauth.d.ts:44`; `dist/index.d.ts:22,27,34`;
`pi-tui/dist/index.d.ts:17,19,28`; both `package.json` engines blocks; CHANGELOG 1.0.0 + 0.99.2
sections; pi-crew `src/ui/widget/index.ts:525`, `src/ui/pi-ui-compat.ts:47`,
`src/runtime/peer-dep.ts:48`, `src/runtime/child-pi/child-pi.ts:900-968`.
Cross-shard contradictions were resolved by 06_synthesize with direct file:line evidence
(`classify()` extension surface; `--mode json -p` already default).

Shard-derived and not re-opened [S]: import census (93 sites), pi-tui/pi-agent-core zero-marker
greps, extension-types byte-identity 0.99.2↔1.0.0, ~10 manual-truncation file count,
`event-log-rotation.ts:260`.

**Not answerable statically:** fullscreen-default impact on pi-crew overlays, dashboard, custom
footer, and tmux pane-scraping. That is why P0-1 exists: run the live T5/T10/T13 probe battery
(real-test skill) before claiming any UI-behavior parity in release notes.

## References

- CHANGELOG 1.0.0 / 0.99.2 — `/tmp/pi100/package/CHANGELOG.md` (also shipped in the installed package)
- Type defs — `pi-crew/node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-ai,pi-agent-core}/dist/`
- SDK docs — `pi-crew/node_modules/@earendil-works/pi-coding-agent/docs/` (cli.md, cli-integration.md,
  json.md, sessions.md, models.md, codemode.md, compaction.md, virtual-models.md, packages.md)
- pi-crew sources (read-only) — `src/runtime/model/pi-args.ts`, `src/runtime/child-pi/child-pi.ts`,
  `src/runtime/surface/surface-spawn.ts`, `src/ui/widget/index.ts`, `src/ui/pi-ui-compat.ts`,
  `src/runtime/peer-dep.ts`
- Prior records — `pi-crew/docs/mcp-exposure-design-review-2026-10-02.md` (§9, KEEP-STATUS-QUO);
  `pi-crew/docs/perf/pi-1.0.0-compat-research-2026-10-02.md` (compat wave);
  `pi-crew-sdd-2026-09-30-buoi1.md` §12–§20 (background)
- Run artifacts — `.crew/artifacts/team_20261003094832_beeed264e89afa71/` (shard evidence packs 01–05,
  synthesis 06)
