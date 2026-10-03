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
| P0-1 | Verify all pi-crew surfaces under fullscreen-by-default; pin `--tui-mode` on spawned surface processes | 1.0.0 changed default TUI mode; overlays/dashboard/pane-scraping may render differently | CHANGELOG 1.0.0 "Changed" [V]; `src/runtime/surface/surface-spawn.ts:142-149` spawns a TUI variant without mode pinning [V]; **live-verified R2 (§R2.1): `readScreen` scrollback scrape (`-S`) loses history under fullscreen default — pin `regular`** | P0 (verified; fix pending) | S probe / S fix |
| P1-1 | Session-file recovery for SIGKILL'd runners: capture session header id at spawn, replay tail on `exitCode === null` | runner-died-near-end: host killed exit=137 while background run completed | `src/runtime/model/pi-args.ts:266-267` workers already persist sessions [V]; `docs/json.md:23-28` header record [V]; `src/runtime/child-pi/child-pi.ts:903-968` exit-status settle [V]; **live-proven R2 (§R2.2): anatomy + SIGKILL tail-recovery validated — GO** | P1 | M |
| P1-2 | Audit every arg-builder path for `--provider` without `--model` | was silently ignored, now **errors** (#10236) | `docs/cli.md:63-64` [V]; CHANGELOG 1.0.0 Fixed [V] | P1 | S |
| P1-3 | Hygiene: adopt pi-tui `TruncatedText`; drop dead `persist:true`; retire version-guard shims | duplication + dead code under the `^1.0.0` floor | `pi-tui/dist/index.d.ts:17` [V]; `src/ui/widget/index.ts:525` passes `persist` [V]; `src/ui/pi-ui-compat.ts:47` strips it [V] | P1 | S–M |
| P2-1 | `ctx.modelRegistry.classify()` for host-side cheap decisions (retry triage, routing hints) — spike first | subagent turns are expensive; classifiers answer typed questions | `docs/models.md:137-138` [V]; host-process only (see Q2c); **live R2 (§R2.3): blocked-on-credentials on this host (`getAvailableOfType("classifier")` = `[]`)** | P2 | M spike |
| P2-2 | Compaction hook `session_before_compact` in the injected prompt-runtime extension *(R2 scope fix: `generateSummary()` is not extension-exported — dropped)* | control worker auto-compaction | `docs/compaction.md:296-313` [V]; `pi-args.ts:318` unconditional `--extension` [V]; **live R2 (§R2.4): extension bus fires in `-p`; hook itself still unfired-live** | P2 | M |
| P2-3 | RPC mode (`RpcClient` / `runRpcMode`) for controllable long-lived workers | replace one-shot `-p` stdout parsing for steering-heavy roles | `dist/index.d.ts:34` exports [V]; `docs/cli-integration.md` "Control Pi with RPC"; **live R2 (§R2.5): steer round-trip proven; `extension_ui_request` flood + dialog-blocking are design gates** | P2 | L |
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

---

## Round 2 — Live verification (2026-10-03)

- **Run:** `team_20261003101450_71becef2534e9675` (parallel-research: static shards 03/05 + live-probe shards
  02/04 → synthesis 06 → this append, 07_write).
- **Why this round exists:** Round 1 left P0-1 gated on a live probe, P1-1 design-only, and P2-1/P2-2/P2-3
  at docs-grade evidence. This round converts each into live evidence.
- **Method:** all probes ran in scratch `/tmp/pi-adoption-r2/` via wrapper `px.sh` (unsets every `PI_CREW_*`
  env var before `exec pi` — real `.crew` state untouched), on a dedicated tmux socket (`tuisock`). No
  global install, no user-config writes. Every spawn timeout-bounded; SIGKILL liveness-checked.
- **Provenance tags (this round only):**
  - **[R2-V]** — verified directly by 07_write reading the cited scratch file (contents quoted inline).
  - **[R2-S]** — live output recorded by probe shards 02/04 (exit codes, help text, measurements);
    consistent across both shards but not re-executed by 07_write.
- **Exit-code honesty:** completed `-p`/RPC runs recorded exit=0 by both shards; the SIGKILL probe's kill
  was confirmed by process-liveness check, not exit code alone. Stream completeness (records ending in
  `agent_settled` / orderly shutdown lines) corroborates the clean exits. Per the workspace lesson
  (background work can complete after a timeout kill), exit codes are treated as secondary to
  stream/session-file evidence.

### R2.1 — P0-1 fullscreen-by-default: LIVE-CONFIRMED, pin `--tui-mode regular`

**Verdict.** The 1.0.0 fullscreen default does not crash or visibly break pi-crew surfaces, and the
alt-screen lifecycle is clean — but it silently empties the *scrollback* capture path that pi-crew's
`readScreen` always uses. Action: pin `--tui-mode regular` on surface TUI spawns (S effort).

**Evidence** (fresh tmux pane per run; MARKER = distinctive line echoed to the shell *before* pi
started; capture via `tmux capture-pane`):

- `pi --help` exposes `--tui-mode fullscreen|regular`, fullscreen being the default; exit=0 [R2-S, 02].
- **Fullscreen (default), scrollback capture** (`capture-pane -p -S -200`) → `tui-fs-scroll.txt`:
  **0 MARKER hits** in the entire capture [R2-V, file read in full] — pre-pi scrollback history is gone.
- **`--tui-mode regular`, same recipe** → `tui-reg-scroll.txt:1` opens with `MARKER-BEFORE-PI-REG`
  [R2-V] — shell history above the TUI survives.
- **Viewport capture** (`capture-pane -p`, no `-S`): works in BOTH modes — fullscreen `tui_full_chat.txt`
  shows the prompt `Reply with exactly: HI` and the reply `HI` mid-capture [R2-V]; regular analog per
  02 [R2-S].
- **Alt-screen exit is clean:** post-ctrl+d capture `tui-fsx-after.txt` shows pre-pi `MARKER3-BEFORE`
  preserved, pi's exit output (`[pi-crew] Session shutdown … Cleanup complete`), and `POST-PI-MARKER
  rc=0` from the resumed shell [R2-V]; `#{alternate_on}` went 1→0 across the exit [R2-S, 02].

**Reconciling the 02-vs-04 divergence.** Shard 02 concluded "no mandatory action" because its captures
were viewport-only (correct — viewport capture is unaffected); shard 04 measured the scrollback path and
called for pinning. Direct read of the real call site settles it: `src/runtime/surface/tmux-provider.ts`
`readScreen` **always** passes `-S -<lines>` (`capture-pane -p -t <id> -S -<max(1,lines)>`) [R2-V —
provider source read this round], so pi-crew's screen-scrape *is* the scrollback path. Shard 04's
verdict is the correct one for pi-crew.

**Recommended action.** In `src/runtime/surface/surface-spawn.ts`, pin `--tui-mode regular` on the TUI
spawn — insertion point directly after `const tuiArgs = stripHeadlessModeArgs(input.piArgs);` (~line
271), before `resolveCommand(tuiArgs)` [R2-V — call site read]. Viewport-only consumers are unaffected
either way; banner/skills/extensions/footer all render under fullscreen [R2-V], so dashboard surfaces
degrade only via history loss.

### R2.2 — P1-1 session-file recovery: GO, live-proven

**Verdict.** Session-file anatomy is fully mapped and the tail-recovery algorithm works under SIGKILL,
with loss bounded by turn granularity.

**Evidence:**

- `--session-dir /tmp/pi-adoption-r2/sessions` accepted; files land **flat** as
  `<ISO-ts>_<session-id>.jsonl` (11 files observed) [R2-V].
- `--session-id adopt-r2-fixed` run twice (`Reply with exactly: ONE`, then `TWO`): **one file**
  `2026-10-03T10-19-13-265Z_adopt-r2-fixed.jsonl` holds both turns — header
  (`{"type":"session","version":3,"id":"adopt-r2-fixed",…,"cwd":"/tmp/pi-adoption-r2"}`),
  `model_change` (`zai/glm-5.3`), `thinking_level_change`, then user/assistant pairs `ONE→"ONE"` and
  `TWO→"TWO"`, each assistant carrying `"stopReason":"stop"` [R2-V]. Run 2's stdout (`p2b2.out`)
  re-emits the session header with the **same id** and terminates with `agent_settled` [R2-V].
  Same-id rerun therefore appends to one file; the id is stable across runs.
- **SIGKILL mid-stream:** task "run `sleep 4 && echo done-N` 12 times"; `kill -9` after turn 1 settled.
  stdout stream `mykill.stdout` = 249 records with `message_update`s still in flight (247 per 02
  [R2-S]) [R2-V count]. The session file `…_adopt-r2-mykill.jsonl` = 9 records: header, `model_change`,
  `thinking_level_change`, user(task), a **complete** turn-1 assistant (thinking + text + `toolCall
  "sleep 4 && echo done-1"`, `"stopReason":"toolUse"`), `toolResult` `done-1`, a system record
  (`toolsAdded` …) — and **nothing** for the in-flight later turns [R2-V]. Kills landing before the
  first turn ends leave user-only tails with no assistant record at all [R2-S, 02 — 8-line `p2c*.out`
  streams].
- Persistence is per-completed-message (atomic at `message_end`): no partial or torn assistant records
  observed in any killed file [R2-V mykill; R2-S early kills].
- Fresh fixed-id stderr: `Warning: No project session found with id 'adopt-r2-kill4'; creating a new
  session with that id.` (`p2c4.err`) — create-if-absent semantics confirmed [R2-V].

**Recovery algorithm (validated).** Tail-scan the JSONL backwards: the last `message` record with
`role:"assistant"` (with its `stopReason`, usage, toolCalls) is the last settled turn and is fully
recoverable; a tail ending at user/`toolResult` without a following assistant means "died mid-stream",
  loss bounded by turn granularity. Tolerate a truncated final line regardless (never observed, but a
  killed writer can theoretically tear one). Build on the SDK exports `parseSessionEntries` /
`migrateSessionEntries` / `SessionManager` [R2-S, 05 — cited at `dist/index.d.ts`] rather than a
hand-rolled parser.

**Recommended action.** Proceed with P1-1 as proposed in §Q2(a): capture the session id at spawn (or
force `--session-id <taskId>`), point `--session-dir` at run state, replay the tail on
`exitCode === null`.

### R2.3 — P2-1 `classify()`: blocked-on-credentials on this host

**Verdict.** NO-GO for the spike on this host — the blocker is classifier *credentials*, not API
shape. The never-rejects contract is confirmed live.

**Evidence** — extension probe (`--extension /tmp/pi-adoption-r2/probe-ext/probe.ts`) under
`--mode json -p`; stderr verbatim from `p3b.err` [R2-V]:

```text
[PROBE:p3b] before_agent_start fired
[PROBE:p3b] before_provider_request fired
[PROBE:p3b] classify: available classifiers = []
[PROBE:p3b] classify: known classifier models = ["cloudflare-workers-ai/typesafe/jev","opencode/jev-1.13","opencode/jev-1.13-free","openrouter/~typesafe/jev-latest","openrouter/inception/mercury-decide:free","openrouter/jaredpalmer/kev-4b"]
[PROBE:p3b] classify: using opencode/jev-1.13-free
[PROBE:p3b] classify: result={"api":"typesafe-system-one","provider":"opencode","model":"jev-1.13-free","answers":{},"stopReason":"error","errorMessage":"Provider is not configured: opencode",…}
[PROBE:p3b] session_shutdown fired
```

Reading: `getAvailableOfType("classifier")` returns `[]` (nothing credentialed) while the catalog
(`getModelsOfType("classifier")`) lists 6 models — catalog present, credentials absent. `classify()`
returned a structured result with `stopReason:"error"` instead of throwing [R2-V], matching the
`model-registry.d.ts:40-48` never-rejects contract [V, R1]. This also resolves shard 04's open
uncertainty (catalog-absent vs cred-absent).

**Recommended action.** Shelve the spike until a classifier provider is credentialed. No pi-crew code
should call `classify()` expecting an answer on this host today. Leader decision: which provider
(opencode free tier vs a gateway-key route).

### R2.4 — P2-2 compaction hooks: infra-proven, hook-unfired + scope correction

**Verdict.** PARTIAL: the extension bus demonstrably fires in `-p` mode (the biggest R1 gate), but
`session_before_compact` itself was never live-fired. One scope correction against R1's item text.

**Evidence:**

- Extension bus fires under `--mode json -p` with an injected `--extension`: `before_agent_start`,
  `before_provider_request`, `session_shutdown` all logged by the probe (`p3b.err`, quoted in §R2.3)
  [R2-V]; run exit=0 [R2-S].
- `session_before_compact` did not fire in any probe run — no compaction threshold was reached
  (auto-compaction checks between turns after tools finish — `docs/compaction.md:37` [V, R1]; forcing
  it needs a near-overflow context ≈1M tokens on glm-5.3, out of probe budget) [R2-S]. Submitting
  `/compact` as a `-p` prompt is not a slash-command there: the model answers in prose [R2-S, 02].
- **Scope correction:** `generateSummary()` is **not** extension-exported — 0 hits in
  `extensions/types.d.ts` [R2-S, 02]. R1's P2-2 row listed it; the extension-reachable surface is
  `session_before_compact` blocking/cancel/custom-summary only. Backlog row narrowed accordingly.
- The in-repo analog already runs in the interactive host: `compaction-guard.ts:272,283` listens for
  the same event [R2-S].

**Recommended action.** Treat P2-2 as infra-proven / hook-unfired. One bounded live-fire test
(small-context model + filler to threshold) closes the last unknown; otherwise proceed on docs +
host-analog evidence and label it as such.

### R2.5 — P2-3 RPC mode: feasible-green with two mandatory design gates

**Verdict.** RPC works end-to-end for the steering use case and is the right replacement for stdout
parsing in long-lived workers — *if* the client handles UI-request records and dialogs.

**Evidence:**

- `pi --mode rpc --no-session` speaks newline-delimited JSON on stdio [R2-S]; on stdin close it shuts
  down orderly — `rpc.stderr` shows `[pi-crew] Session shutdown - cleaning up resources / Cleanup
  complete / Received SIGTERM - starting cleanup` [R2-V]; recorded exit=0 [R2-S].
- `get_state` → typed state incl. `steeringMode`, `autoCompactionEnabled`, `sessionId`,
  `contextWindow: 1 000 000` [R2-S]; `prompt` → `disposition:"started"`; `agent_settled` observed
  [R2-S].
- **Steering round-trip proven:** mid-turn `steer` landed; the final assistant text read back as
  `"finished STEERED"` [R2-S, 04]. Full command surface confirmed in `docs/rpc-commands.md`: `steer`,
  `follow_up`, `abort`, `set_steering_mode`, `compact`, `set_auto_compaction`, `set_auto_retry` [R2-S].
- **Caveat 1 — `extension_ui_request` flood:** `rpc-plain.out`: of the first 16 records, **15 are
  `extension_ui_request`** (`setStatus`/`setWidget` for `pi-crew`, `pi-crew-active`, `pi-crew-tasks`,
  `mcp`, `pi-crew-bar`) [R2-V]. Shard 02 measured one trivia turn at 48 records / 163 415 bytes with
  31/48 ui-requests [R2-S]; 04 measured 46–65 % [R2-S]. A headless RPC client must answer or drain
  these.
- **Caveat 2 — dialogs block:** UI *dialog* requests block until answered [R2-S, 04] → pi-crew's `ask`
  tool over RPC can deadlock a worker unless the client implements an answer policy. This is a design
  gate, not a bug.
- Framing is LF-only line protocol — Node's readline defaults are unsafe for it [R2-S, 04]; child
  lifecycle is bound to the RPC process.

**Recommended action.** Keep P2-3 at L effort, gated on (a) an `extension_ui_request` answer/drain
policy and (b) a dialog-answer policy for `ask`. Reuse exported `RpcClient` / `runRpcMode`
(`dist/index.d.ts:34` [V, R1]) rather than a hand-rolled driver; re-run the `--approve` probe cleanly
once (04's rpc3 anomaly: zero records, likely driver race) before trusting it.

### R2 backlog deltas

| Item | R1 evidence state | R2 state | Nature change |
|---|---|---|---|
| P0-1 | docs + static, gated on live probe | live-verified: scrollback scrape affected; viewport + exit clean | verify → fix (pin `regular`, S) |
| P1-1 | design (§Q2a proposal) | live-proven GO (anatomy + SIGKILL tail-recovery) | design → implementable |
| P2-1 | docs spike candidate | blocked-on-credentials on this host; never-rejects confirmed | spike → shelved pending creds |
| P2-2 | docs-gated | infra-proven / hook-unfired; `generateSummary()` dropped from extension scope | gate narrowed |
| P2-3 | docs feasibility | steer round-trip live-proven + two design gates (ui-request flood, dialog blocking) | feasibility → gated-green |

### R2 leader decisions

1. **P0-1:** pin `--tui-mode regular` now (S effort, `surface-spawn.ts` right after
   `stripHeadlessModeArgs`) vs defer to the next surface-touching change. Recommended: now — without
   the pin, `readScreen` consumers silently lose history under the 1.0.0 default.
2. **P2-1:** which classifier provider to credential (opencode free tier vs gateway key), or shelve.

### R2 remaining unknowns (bounded)

- `session_before_compact` live-fire in `-p` (needs an overflow-context test; docs + interactive-host
  analog both point yes).
- The TUI probe did not exercise pi-crew's `PI_CREW_AUTO_EXIT` path (env scrubbed to protect real
  `.crew` state; render behavior is env-independent, but that exit path remains unprobed).
- Torn/truncated session lines were never observed — the recovery reader should still tolerate a short
  tail.
- 04's `rpc3.py --approve` re-run produced zero records (likely driver race); one clean re-run before
  P2-3 implementation.

### R2 evidence index

All under `/tmp/pi-adoption-r2/` (scratch, not committed): `px.sh` (env-scrub wrapper),
`probe-ext/probe.ts` + `ext/probe-ext.ts` (extension probes), `ext-events.log`, `p3b.err` (classify
chain), `sessions/*.jsonl` (11 session files incl. `…_adopt-r2-fixed.jsonl`, `…_adopt-r2-mykill.jsonl`),
`mykill.stdout|err|pid`, `p2b1/p2b2.out` (fixed-id reruns), `tui-fs-scroll.txt` / `tui-reg-scroll.txt`
(MARKER scrollback), `tui_full_chat.txt` (viewport), `tui-fsx-after.txt` (post-exit), `rpc-plain.out` /
`rpc.stderr` / `rpc2.py` / `rpc3.py` / `rpc-driver.py` (RPC). Shard outputs:
`.crew/artifacts/team_20261003101450_71becef2534e9675/results/{02,04}_explore-*.txt`.

---

## Future design (not adopted) — W6(c), 2026-10-03

- **Virtual models for model-fallback.** SDK virtual-model types (`ModelRoute`, `VirtualModelDefinition`, `dist/index.d.ts:27`) could encode per-lane fallback routes host-side (fallback observes provider health; single retry surface) — deferred because routes must live in the host's `models.json` (out-of-repo artifact) and pi-crew loses visibility into which route fired.
- **`prepareLoadout()` + `ctx.executeTool()`** (CHANGELOG 0.99.0) — pre-declared tool sets with bounded execution fit future tool composition (skill/resource discovery as declared tools; loadout boundary as tool gate for a future RPC transport); not adopted — newer than the tested floor's semantics and the current prompt pipeline works.
