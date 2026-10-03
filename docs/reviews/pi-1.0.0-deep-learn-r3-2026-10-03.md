# Pi 1.0.0 SDK Deep-Learn — Round 3 Findings (R3) — pi-crew

- **Date:** 2026-10-03
- **Run:** `team_20261003161114_61dbe31cb8c7fd11` (parallel-research: discovery → 4 explorer shards → synthesis → this document)
- **Scope:** Third round of Pi 1.0.0 SDK mining. Round 1 (stability census + adoption backlog
  `P0-1…P2-4`, see [pi-1.0.0-adoption-review-2026-10-03.md](pi-1.0.0-adoption-review-2026-10-03.md))
  and Round 2 (live pain-point verification, §R2.1–R2.5 in the same file) are **closed and not
  re-discovered here**. This round mines the full docs corpus and behavior mechanics not covered
  by R1/R2: core mechanics (settings/env/sessions/compaction/trust), the extension/UI/embedding
  surface, and live probes of worker-context behavior.
- **Excluded by mandate (already covered/decided):** fullscreen/tui-mode (P0-1), session-id/dir
  + recovery (P1-1), `--provider`/`--model` contract (P1-2), compaction hooks (P2-2), `classify()`
  (P2-1, shelved — no creds), RPC mode (P2-3, prototype landed), MCP exposure (E1 KEEP-STATUS-QUO),
  virtual models + `prepareLoadout()` (P2-4, future-note), peer-dep fork warn-once, `TruncatedText`
  (verdict: not fit).
- **Inputs:** SDK docs under `node_modules/@earendil-works/pi-coding-agent/docs/`, type defs
  (`pi-coding-agent/dist/**`, `pi-tui/dist/index.d.ts`), pi-crew `src/` (read-only), probes in
  `/tmp/pi-deeplearn-r3` (read-only w.r.t. real `.crew` state).

## Provenance legend

- **[W]** — verified directly by the writer (07_write, this session): read the cited file:line.
- **[A]** — re-verified by the analyst (06_synthesize, this run): grep/read against `pi-crew/src`.
- **[S]** — shard evidence pack (02/03/05), each self-verified with file:line; not re-opened by
  the writer. Writer spot-checks sampled 6 load-bearing claims — all 6 matched (§3.3).

Effort: S < 1 day, M = days, L = week+.

## Coverage vs shard plan — read this first

This document claims **mining completeness only for the lanes actually dispatched and finished**.
Two planned lanes were never dispatched, and one probe pair was not run. Claims below are scoped
accordingly.

| Shard | Status | Notes |
|---|---|---|
| L1 core-mechanics | ✅ complete (02) | Read in full: `settings.md`, `configuration.md`, `environment-variables.md`, `sessions.md`, `compaction.md`, `prompt-templates.md`, `how-pi-works.md`, `security.md` (trust §), `cli.md` (flag surface). Not reported read: `session-format.md` (structure only; `json.md` partially covered in R2). |
| L2 extension/UI/embed | ✅ complete, **duplicated** (03 + 05) | Both shards read the same five SDK docs (`extensions.md`, `sdk.md`, `tui.md`, `themes.md`, `keybindings.md`) with complementary angles (03: pi-tui export surface + lifecycle hooks; 05: keybinding manager + IME + compat shims). ~50% budget duplication; no correctness cost — cross-checkable claims agreed except where noted in §2. |
| L3 models/talent | ❌ **never dispatched** | `models.md`, `codemode.md`, `skills.md`, `custom-provider.md`, `packages.md`, `mcp.md` delta — unmined. Task-packet questions **Q3a** (is pi-crew's `skillPaths` injection the standard mechanism? is there a better API?) and **Q3b** (does pi-crew's `scopeModels` config syntax match the 1.0.0 `--models` pattern standard?) are **unanswered**. R3-12 below touches `scopedModels` via `sdk.md` (an L2 read), but the L3 config-syntax fit question remains open. |
| L4 live probes | ~50% (02) | Done: (a) AGENTS.md discovery ✓, trust store inspection ✓ (P-C), `--offline` startup variant ✓ (P-B, negative result), env-vars doc census ✓. Not done: (b) skills-flag injection probe, (c) extension-load-cost probe **with `-e`** (02 measured the `--offline` variant, not the `-e` variant). |
| E residual-docs triage | ❌ **never dispatched** (partial accidental coverage) | Of the ~15 residual docs, `security.md` (trust §) was read by 02 and `slash-commands.md` by 03. The rest (`index`, `quickstart`, `usage`, `providers`, `message-types`, `tmux`, `shell-aliases`, `containerization`, `llama-cpp`, `termux`, `windows`, `terminal-setup`, `docs.json`) are unmined. |
| 04_explore-runtime | ⚠️ false-complete | Artifact contains only a one-line intermediate progress note ("continuing to read compaction.md §end + settings.md") [W] — no final report, no candidate matrix. Its assigned L1 content is fully covered by 02; no findings were lost. Process note for future dependency wiring: **read the artifact, not the status flag** (recurring state-flap pattern). |

**Leader decision requested (D3, §6):** dispatch one follow-up explorer for L3 + E + probes (b)/(c)
before closing the round. L3 carries two explicit task-packet questions that are currently open.

---

## 1. Executive matrix

Unified, deduplicated matrix. Shard-local IDs (03 `L2-x`, 05 `R3-L2-x`, 02 local numbering) map
1:1 into this numbering; no parallel IDs are used below.

| ID | Mechanism | Type | Pri | Effort | Adoption-fit (where it lands in pi-crew) |
|----|-----------|------|-----|--------|------------------------------------------|
| R3-1 | Run-static worker header via `--append-system-prompt` (compaction-surviving channel) | NEW-ADOPTION | **P1** | M | task-runner prompt assembly (`prompt-builder.ts` + `pi-args.ts`) |
| R3-2 | Worker self-report of `PI_SESSION_FILE`/`PI_SESSION_ID`/`PI_MODEL`/`PI_PROVIDER`/`PI_REASONING_LEVEL` | NEW-ADOPTION | **P1** | S | handoff template / worker prompt (provenance without log parsing) |
| R3-3 | Pin project-trust on worker spawns (`-na` vs `-a`; nothing passed today) | ALIGNMENT | P2 | S | `pi-args.ts` worker arg builder — **needs leader decision (D1)** |
| R3-4 | `agent_settled` / `agent_before_settle` as extension hooks (not stdout parsing) | NEW-ADOPTION | P2 | S | injected prompt-runtime extension (`prompt-runtime.ts`) |
| R3-5 | Rebindable crew shortcuts: `KeybindingsManager` (3rd `ctx.ui.custom()` factory param) + named action ids | ALIGNMENT | P2 | M | `crew-shortcuts.ts`, `keybinding-map.ts`, overlays |
| R3-6 | IME cursor: `CURSOR_MARKER` on hand-written cursor components | ALIGNMENT | P2 | S | `mailbox-compose-overlay.ts` + audit of hand-rolled inputs |
| R3-7 | Retire dead optional-guards / no-op compat shims under `^1.0.0` floor | ALIGNMENT | P2 | S | `crew-shortcuts.ts:76-79`, `pi-ui-compat.ts` |
| R3-8 | `ctx.modelRegistry.streamSimple()` for host-side LLM calls | NEW-ADOPTION | P3 | M | run summaries / task-packet compression (host process) |
| R3-9 | OSC-8 hyperlinks in crew footer widget | NEW-ADOPTION | P3 | S | `widget-renderer.ts` (clickable actions without fullscreen mouse) |
| R3-10 | `withFileMutationQueue()` around team-mutating tools | NEW-ADOPTION | P3 | S | team-tool mailbox/task mutations (in-parallel tool-call safety) |
| R3-11 | Tool exposure `deferred` for rarely-used tools | NEW-ADOPTION | P3 | M | worker prompt-runtime tool declarations → tool_search discovery |
| R3-12 | `scopedModels` on `createAgentSession` for live sessions | NEW-ADOPTION | P3 | S | `live-session-runtime.ts` (bind live-session model access to fallback list) |
| R3-13 | `AgentSessionRuntime.importFromJsonl()` as true-resume boot | NEW-ADOPTION | P3 | M–L | crash-resume complement to P1-1 read-only tail replay |
| R3-14 | `theme.style()` semantic-token colors | ALIGNMENT | P3 | S–M | status/panel palettes in `src/ui` |
| R3-15 | `--name` for worker sessions | NEW-ADOPTION | P3 | S | cosmetic — human-friendly session picker display |
| R3-16 | `AI_AGENT`/`PI_CODING_AGENT` markers to widen `doctor --zombies` scope | NEW-ADOPTION | P3 | S | zombie detection for orphaned non-crew pi processes |
| R3-17 | SDK in-process embedding as worker transport | NEW-ADOPTION candidacy → **recommend DOCUMENT-AND-DECLINE** | P3 (arch) | L | conflicts with process-isolation safety model — **needs leader verdict (D2)** |
| R3-18 | In-repo workers auto-load repo `AGENTS.md` into system prompt | CONFIRMED-BEHAVIOR | — (no action) | — | documented; benign overlap with pi-crew convention injection |

Three further items were conflict-resolved to dormant/deferred (unnumbered, see §4.2):
`cache_warming_decision` (P3, probe-gated), `provider_stream_event` (P3, latent),
`registerFlag()` (deferred to skip).

---

## 2. Candidate details

### R3-1 — Run-static worker header → `--append-system-prompt` (P1, NEW-ADOPTION, M)

**Problem.** The worker's run-static context — Protocol block, mailbox contract, workspace
structure, runtime context — is currently delivered inside the task.md **user message**
(`prompt-builder.ts` concatenation). Compaction cuts at user-message boundaries and **summarizes
the user-message span** (`compaction.md:150-160` [S]); the system prompt survives intact. Long
runs therefore lose exactly the content that must never be lost.

**Mechanism.** pi's per-agent `--system-prompt`/`--append-system-prompt` flags already accept a
file, and the plumbing exists end-to-end in pi-crew: `pi-args.ts:362-368` [W] writes
`input.agent.systemPrompt` to a 0600 temp file and selects the flag by
`systemPromptMode === "append"`. Move the run-static header to a per-run append-system-prompt
file; keep the task itself in the user message (it *should* be summarizable).

**Evidence.** P-A probe (§3.1) proves the system-prompt channel is populated and obeyed in `-p`
json mode. `compaction.md:150-160,296+` [S] for the summarization boundary.

**Condition.** One small probe that `--append-system-prompt` coexists with AGENTS.md discovery
(documented as orthogonal, not yet probed — shard 02 flagged this). ~10 min.

### R3-2 — Worker self-report of host `PI_*` env (P1, NEW-ADOPTION, S)

pi pre-sets `PI_SESSION_FILE`, `PI_SESSION_ID`, `PI_MODEL`, `PI_PROVIDER`, `PI_REASONING_LEVEL`
in the worker's bash-tool environment, resolved per command (`environment-variables.md` [S]).
pi-crew reads **zero** host `PI_*` variables (`src/` grep = 0 hits, re-run by 06_synthesize [A]).

**Adoption-fit.** Add one line to the worker prompt / handoff template: the worker echoes its own
env, giving the leader model-provenance and session identity directly in the result — no log
parsing, no stdout inference. Cheap, deterministic, and it composes with P1-1 (session ids the
host can already correlate).

### R3-3 — Pin project-trust on worker spawns (P2, ALIGNMENT, S) — leader decision D1

Today no trust flag is passed in the worker arg builder (`pi-args.ts:259-412` — no `-a`/`-na`
[S]), so worker trust behavior depends on the **ambient trust store**: `~/.pi/agent/trust.json`
stores absolute-path decisions (`/home/bom/source/my_pi: true`, `/tmp: true` — P-C probe, §3.1).
In non-interactive mode with `ask` default, protected resources are skipped
(`security.md:75-81` [S]) — meaning worker behavior varies by machine state, which breaks
run-to-run determinism.

**Decision needed (D1):**
- **Hermetic** (`-na`): consistent with the SEC-1 env-strip posture — workers trust nothing
  implicitly; all access granted explicitly.
- **Project-aware** (`-a`): consistent with R3-18 (in-repo workers already auto-load repo
  AGENTS.md); preserves the current de-facto behavior for repo-cwd workers.

These interact: if the leader picks hermetic trust, R3-18's AGENTS.md auto-load is *also*
suppressed for in-repo workers (context-file discovery is trust-free per `configuration.md:44-56`
[S] — actually discovery itself needs no trust, but resource access gating does). Recommend
deciding D1 together with a reading of R3-18.

### R3-4 — `agent_settled` / `agent_before_settle` as extension hooks (P2, NEW-ADOPTION, S)

pi-crew treats `agent_settled` as a **stdout-parsing concern only** (`child-pi.ts`,
`pi-json-output.ts`, `rpc/frame-client.ts`) [S]. The injected prompt-runtime extension registers
exactly 4 hooks — `before_provider_request`, `session_shutdown`, `session_before_compact`,
`before_agent_start` (`prompt-runtime.ts:837,1031,1051,1127` [S]) — and has **zero**
`agent_settled`/`agent_before_settle` handlers [A].

**Adoption-fit.** Hooking `agent_settled` in-child and emitting `pi.appendEntry()` makes the
completion marker an **authoritative session-file entry** — the same file P1-1 already replays —
instead of trusting stdout stream order (json mode exit codes are deliberately lossy by design;
R1 Q2a). `agent_before_settle` can additionally enforce the task-packet handoff contract before
settle. Small extension-only change; same lineage as the P1-1 replay work.

### R3-5 — Rebindable crew shortcuts via `KeybindingsManager` (P2, ALIGNMENT, M)

pi-tui exports `KeybindingsManager`, `setKeybindings`, `TUI_KEYBINDINGS`, and
`KeybindingDefinition(s)` (`pi-tui/dist/index.d.ts:22` [S]); the standard `keybindings.json`
model rebinds **named action ids** (`keybindings.md:9-27` [S]); the `ctx.ui.custom()` factory
passes a `KeybindingsManager` as its third parameter (ext `types.d.ts:121,148,166-171` [S]).
pi-crew consumes none of this: `crew-shortcuts.ts` hardcodes `alt+s`/`alt+c` behind an optional
`registerShortcut` [W], and overlays self-dispatch through **local** `BINDINGS` tables
(`keybinding-map.ts:1-30`, plus hardcoded `q`/escape in `transcript-viewer.ts:362,463` and
`mascot.ts:443` [S]).

**Maintenance cost is proven, not hypothetical:** `crew-shortcuts.ts:15-22` [W] carries a
manually maintained occupied-key census, and documents a real incident — an earlier `alt+d`
dashboard binding collided with `tui.editor.deleteWordForward` and was silently stripped by Pi's
conflict detector.

**Priority note.** Shard 03 filed this P3, shard 05 P2; synthesis resolved to **P2**: user
rebindability is the platform-standard expectation, and the manual collision list is a recurring
cost every time either keymap changes.

### R3-6 — IME cursor marker on hand-written inputs (P2, ALIGNMENT, S)

pi-tui's `Focusable` + `CURSOR_MARKER` contract positions the IME candidate window correctly for
CJK input (`tui.md` [S]). Status in pi-crew, corrected by synthesis:

- `Focusable` **is** partially adopted — `run-dashboard.ts:1112-1116` and
  `settings-overlay.ts:818-821` both declare `public focused = false` with an explicit
  contract comment [W]. (Shard 05 originally reported Focusable entirely unused; that was
  wrong — the analyst's re-read narrowed the finding.)
- `CURSOR_MARKER` is **never** used (0 hits [A]).

**Adoption-fit.** Hand-written cursor inputs — e.g. `mailbox-compose-overlay.ts` field rows
rendering `active ? CURSOR : " "` from a custom constant [W:111] — should adopt the marker so the
IME window tracks the logical cursor. Scope: add `CURSOR_MARKER` to hand-rolled text inputs and
audit overlays for cursor-bearing components.

### R3-7 — Dead guards / no-op shims under the `^1.0.0` floor (P2, ALIGNMENT, S)

The package floor is `^1.0.0` (R1 Q3), so pre-1.0 degradation paths are dead code:

- `pi.registerShortcut?.()` optional chaining "so older Pi versions degrade gracefully"
  (`crew-shortcuts.ts:76-79` [W]).
- `pi-ui-compat.ts` no-op guards for setWidget/setFooter/custom/setStatus written for pre-API
  hosts (`pi-ui-compat.ts:55,74,83,97` [S]; the `persist:true` strip at `:47` is already
  ticketed as R1 P1-3).

Extends R1-P1-3 from "one flag" to "the whole compat shim layer". Mechanical removal, keeps
type-safety.

### R3-8 — `ctx.modelRegistry.streamSimple()` for host-side LLM (P3, NEW-ADOPTION, M)

`extensions.md:222` [S]: "Use ctx.modelRegistry.streamSimple() for provider-neutral nested model
calls". pi-crew: 0 uses [A]; `src/extension/session-summary.ts` is non-LLM today (grep: no model
refs [S]). This is the **credible** host-side LLM path — unlike `classify()` (P2-1, shelved:
`getAvailableOfType("classifier")` = `[]` on this host), `streamSimple` uses normal credentialed
models. Fit: run summaries, task-packet compression, anything the host currently does with
string templating.

### R3-9 — OSC-8 hyperlinks in the crew footer widget (P3, NEW-ADOPTION, S)

OSC-8 links work in regular (non-fullscreen) mode and take precedence over enclosing click
regions (`tui.md:56-58` [S]); `setWidget` accepts string lines; pi-tui exports `hyperlink` and
`getOsc8LinkAtColumn` [S]. The crew widget renders plain strings today (`widget-renderer.ts`
[S]). Fit: clickable "open dashboard" / "ack ask" without entering fullscreen mouse mode.

### R3-10 — `withFileMutationQueue()` for team-mutating tools (P3, NEW-ADOPTION, S)

`extensions.md:118` [S]: file-mutating tools should wrap read-modify-write in
`withFileMutationQueue()`. pi-crew: 0 uses [A]. Tool calls originating from a single assistant
message run **in parallel**; pi-crew's team tools mutate `.crew` state and currently rely on
broker-side locking only. Fit: serialize the tool-side mutations as a second lock layer.

### R3-11 — Tool exposure `deferred` (P3, NEW-ADOPTION, M)

Extension tools support exposure levels (`deferred`/`hidden`/`model-only`/`codemode`) plus
namespaces (`extensions.md` Tool exposure [S]); pi-crew's registration passes no exposure
(anything non-default is 1 unrelated access [S]), so **every** tool declaration is always in the
model's context. Workers in `-p` load the `tool_search` built-in (docs-asserted, unprobed — see
probe gap §0). Fit: mark rarely-used tools `deferred` → discoverable on demand, shrinking worker
tool-declaration context. Verification of the tool_search assumption is a precondition (fold into
the D3 follow-up probes).

### R3-12 — `scopedModels` for live sessions (P3, NEW-ADOPTION, S)

`createAgentSession` accepts `scopedModels` (`sdk.md` session config [S]). pi-crew's live-session
embedding passes cwd/agentDir/resourceLoader/`SessionManager.inMemory`/SettingsManager/customTools
— but not `scopedModels` (`live-session-runtime.ts:805-815` [S]); 0 uses in `src/` [A]. Fit: bind
live-session model access to the configured fallback list. (The related L3 question — whether
pi-crew's `scopeModels` *config syntax* matches the 1.0.0 `--models` pattern standard — is
**open**, unmined lane.)

### R3-13 — `AgentSessionRuntime.importFromJsonl()` true-resume (P3, NEW-ADOPTION, M–L, future)

`sdk.md` documents resuming a session from a JSONL file into a new live session
(`AgentSessionRuntime` + examples 11/13 [S]). Fit: the **true-resume** complement to P1-1's
read-only tail replay — boot a SIGKILL'd worker's session file into a fresh process and continue
rather than merely harvest. Depends on P1-1 landing first (it produces the session-id capture).

### R3-14 — `theme.style()` semantic tokens (P3, ALIGNMENT, S–M)

pi-tui's `theme.style()` composes fg+bg+attrs with semantic tokens (`tui.md` "Apply theme
correctly" [S]). pi-crew `src/ui` has 0 `theme.style(` uses [A] (~179 sites use `theme.fg/bg`
[S]). Fit: status/panel palettes through semantic tokens instead of hand-composed fg+attr pairs.

### R3-15 — `--name` for worker sessions (P3, NEW-ADOPTION, S, cosmetic)

`cli.md:100` [S]. W2's deterministic `--session-id` already covers correlation; `--name` only
improves human-facing session-picker display. Take opportunistically when touching `pi-args.ts`
for R3-1.

### R3-16 — `AI_AGENT` / `PI_CODING_AGENT` markers (P3, NEW-ADOPTION, S)

`environment-variables.md` [S]: the CLI entry sets `AI_AGENT=pi` and `PI_CODING_AGENT=true`
(markers are CLI-entry-set, **not** SDK-embed-set — scope is CLI-spawned workers only).
`doctor --zombies` currently keys only on `PI_CREW_*`. Fit: widen zombie detection to orphaned
pi processes that are not crew children. Note this composes with the existing env-scrub
behavior rather than replacing it.

### R3-17 — SDK in-process embedding as worker transport (P3-arch, L) — leader verdict D2

`sdk.md:8-14,32-40,60-77,100-127` [S] documents the full embedding API — `createAgentSession()`,
`SessionManager.inMemory()`, `session.subscribe()`, `steer()`/`followUp()`/`abort()`,
`DefaultResourceLoader` with `extensionFactories`. **Never evaluated before R3** (absent from
R1/R2). It would eliminate child-spawn cost, the env-scrub gotcha class (`PI_CREW_*` leaks, see
knowledge.md 2026-08-15), and the RPC `extension_ui_request` flood (R2 §R2.5) in one stroke.

**But it conflicts with pi-crew's process-isolation safety model** — `executeWorkers=false` kill
switch, crash containment, runtime limits. In-process workers share the host's fate.

**Recommendation (D2): DOCUMENT-AND-DECLINE** — record the tradeoff (this section) and keep
process isolation, unless the leader explicitly wants a non-sandboxed "fast lane" for
cheap read-only subtasks. Synthesis flagged this as architecture-decided, not effort-decided.

### R3-18 — In-repo workers auto-load repo `AGENTS.md` (CONFIRMED-BEHAVIOR, no action)

Probe-verified (P-A, §3.1): a worker at a repo cwd loads the repo's `AGENTS.md` into its system
prompt, trust-free, and obeys it. `skill-instructions.ts:421` [S] already acknowledges this.
Consequence: pi-crew's convention injection can **duplicate** repo instructions for in-repo
workers. Assessed benign (redundancy, not contradiction) — documented here so future convention
changes check for overlap. This is also an input to D1 (R3-3): project-aware trust preserves this
behavior; hermetic trust may interact with it.

---

## 3. Probe evidence

All probes ran in `/tmp/pi-deeplearn-r3`, `timeout -k 5`, `PI_CREW_*` scrubbed from the probe
shell, session dirs pointed into `/tmp`. Real `.crew` state untouched. All exit codes 0 unless
noted.

### 3.1 Live probes (shard 02)

- **P-A — AGENTS.md discovery (R3-1/R3-18 evidence).** cwd `/tmp/pi-deeplearn-r3/proj/sub`,
  `AGENTS.md` placed in the **parent** dir, `pi --mode json -p` → session file contains an
  `<instructions path="…/proj/AGENTS.md">` record in the **system prompt**, and the assistant
  obeyed it (emitted the planted marker `R3MARK-AGENTS-LOADED`). Empty-cwd control: 0 loads.
  Conclusion: discovery is trust-free, walks parent dirs, works in `-p` json mode, lands in the
  system prompt, and is followed by the model.
- **P-B — startup `--offline` (honest negative).** baseline median 9.62 s vs
  `--offline` + `PI_SKIP_VERSION_CHECK=1` median 10.0 s (n=3 each). No benefit; startup cost is
  dominated by model latency (~9–12 s/turn). → SKIP entry §4.1.
- **P-C — trust store.** `~/.pi/agent/trust.json` stores absolute-path decisions
  (`/home/bom/source/my_pi: true`, `/tmp: true`) → worker trust today inherits ambient machine
  state (R3-3 evidence).

### 3.2 Static re-verifications (06_synthesize, this run)

- `pi-args.ts:368` — per-agent `--append-system-prompt`/`--system-prompt` exists (R3-1 infra).
- `prompt-runtime.ts` — 0 `agent_settled`/`agent_before_settle` handlers (R3-4).
- `src/` — 0 uses of SDK `scopedModels` (R3-12), `cache_warming_decision`,
  `provider_stream_event`, `registerFlag`, `withFileMutationQueue`, `streamSimple`;
  0 `theme.style(` in `src/ui` (R3-14).
- `crew-shortcuts.ts:8-79` — hardcoded keys + optional guard + manual collision list (R3-5/7).
- `04_explore-runtime.txt` — confirmed an intermediate progress note, not a final report.

### 3.3 Writer spot-checks (07_write, this session)

Sampled 6 load-bearing claims; **all 6 confirmed**:

1. `pi-args.ts:362-368` — `systemPromptMode === "append"` → `--append-system-prompt` (R3-1).
2. `crew-shortcuts.ts:1-79` (full file) — hardcoded `alt+s`/`alt+c`, `registerShortcut?.` guard,
   occupied-key census incl. the `alt+d` collision note (R3-5/7).
3. `mailbox-compose-overlay.ts:111+` — hand-rolled `active ? CURSOR : " "` field cursor (R3-6).
4. `run-dashboard.ts:1112-1116` — `public focused = false` + Focusable contract comment (R3-6).
5. `settings-overlay.ts:818-821` — same Focusable adoption (R3-6).
6. `04_explore-runtime.txt` — one-line progress note only (§0 false-complete row).

---

## 4. Skip-with-reason and mining completeness

### 4.1 SKIP table (merged across shards)

| Mechanism | Evidence | Reason |
|---|---|---|
| `--offline` / `PI_SKIP_VERSION_CHECK` | P-B probe (§3.1) | Measured: no benefit; model latency dominates. |
| prompt-templates | `prompt-templates.md` [S] | Expands **composer input** into slash commands — not a subagent prompt system. pi-crew's `@task.md` inclusion + system-prompt flags already cover its use. |
| compaction tuning (`reserveTokens`/`keepRecentTokens`/`modelOverrides`) | `compaction.md` [S]; `project-init.ts:152-156` [S] | Agent-dir scope is global (affects host) or trusted `.pi/settings.json` in worker cwd (pollutes user repo — pi-crew deliberately stopped writing AGENTS.md in v0.8.14). P2-2 hooks are the sanctioned control path. |
| `visual.ts` fork | `src/utils/visual.ts:7-18` [S] | **Intentional**: codepoint-wise truncate/wrap for emoji correctness + perf, documented in-file. Not an oversight. Actionable note: upstream-contribution candidate to pi-tui. |
| pi-tui layout primitives (hand-rolled `Container`/`Box`/`Text`/`Spacer`, spinner vs `Loader`) | `layout-primitives.ts:10-95` (110 lines, 2 consumers) [S]; pi-tui export census [S] | Perf-tuned forks. Possible exception: `SelectList` for `agent-picker-overlay.ts`. **Needs one published swap-vs-keep-fork rule** — the TruncatedText verdict set the precedent question per-item, which is arbitrary; make the rule once. |
| 5 lifecycle events (`user_bash`, `context_with_system`, `agent_before_settle` [beyond R3-4's use], `project_trust`, `mcp_servers_change`) | `extensions.md` [S] | 0 uses, no fit: host session doesn't control worker bash; no continuation use-case. |
| `settings.md` misc: `cacheWarming` (global-only), `retry.*`, `steeringMode`/`followUpMode`, `exposeSessionEnvironment` | `settings.md`, `environment-variables.md` [S] | Global-only / RPC-lane / unused. Note: SDK agent-retry is **on by default** in workers — check double-retry interplay with model-fallback when touching retry logic. |

### 4.2 Conflict-resolved dormant items (unnumbered)

Three items got contradictory shard verdicts; synthesis resolved them:

- **`cache_warming_decision`** — keep **P3, probe-gated**. Shard 03's SKIP mis-scoped the
  mechanism to one-shot workers; it actually targets **idle host sessions between runs**
  (`types.d.ts:1159`; pi.events metrics already wired at `extension/registration/observability.ts:156`
  [S]). Cost unmeasured → probe before scheduling.
- **`provider_stream_event`** — **P3-optional/latent**. Host-session first-token latency is a
  real signal distinct from worker event logging (`extensions.md:66-69` [S]), but low value until
  observability coverage demands it.
- **`registerFlag()`** — **deferred to skip**. No demonstrated need for a non-UI `pi --crew`
  entry (`types.d.ts:1195` [S]); commands/shortcuts cover the surface. Re-open if the leader
  wants formal headless invocation.

### 4.3 Already-aligned census (no candidate — completeness proof for mined lanes)

Verified as correctly adopted, listed so future rounds don't re-litigate:

- **W7 RPC UI policy** matches `rpc-extension-ui.md:9-20` (dialog timeout auto-resolve +
  fire-and-forget drain) — `src/runtime/rpc/ui-request-policy.ts:17` [S].
- **Theme deployment** uses the standard `~/.pi/agent/themes/` dir — `deploy-bundled-themes.ts:2-19` [S].
- **`CustomEditor`** extended per tui.md guidance — `ui/inline-panel/crew-editor.ts:25,62` [S];
  `KeybindingsManager` + `getMarkdownTheme` used in editor/agent-pane paths
  (`crew-editor.ts:65`, `agent-pane.ts:196` [S]).
- **`pi.events` bus** + request/reply RPC used idiomatically — `i18n.ts:203-218`,
  `cross-extension-rpc.ts:20-41` [S].
- **`appendEntry`** (8 files incl. `team-tool.ts:276`, `compaction-guard.ts:239/289`) and
  **`registerMessageRenderer`** (`message-renderers.ts:100-107`) [S].
- **Standard overlay options** (anchor/margin/maxHeight) — `inline-panel/index.ts:152` [S].
- **Live-session SDK embedding** incl. `bindExtensions` 30 s timeout —
  `live-session-runtime.ts:805-853` [S].
- **Ops tip:** `PI_TUI_WRITE_LOG` (`tui.md:103`) captures raw ANSI — useful for the T5/T6/T13
  real-test TUI probes.

### 4.4 Docs read with no remaining candidates

Every L1/L2 doc read in full produced either numbered candidates, a SKIP row (§4.1), or an
aligned-census entry (§4.3): `settings.md`, `configuration.md`, `environment-variables.md`,
`sessions.md`, `compaction.md`, `prompt-templates.md`, `how-pi-works.md`, `security.md` (trust §),
`cli.md`, `extensions.md`, `sdk.md`, `tui.md`, `themes.md`, `keybindings.md`,
`rpc-extension-ui.md`, `slash-commands.md`. **No claim of completeness is made for the L3 doc
set, the E residual set, or `session-format.md`** (§0).

---

## 5. Common threads

1. **Post-compaction survival + worker determinism** (R3-1/2/3/18): worker identity and static
   context currently live in lossy channels — the summarizable user-message span and the ambient
   machine trust store. The SDK offers durable, machine-checkable channels (system prompt,
   per-command env, explicit trust flags). This thread is the round's core finding.
2. **Pre-1.0 alignment debt** (R3-5/6/7 + the layout forks): pi-crew hand-writes what the SDK
   has since standardized (keybinding dispatch, focus/IME contracts, compat shims, layout
   primitives). Rather than per-item verdicts (the TruncatedText precedent), publish **one**
   swap-vs-keep-fork rule and apply it.
3. **Underexploited host-side surface** (R3-8/12, cache warming, provider stream, embedding):
   the worker side is deeply optimized; the host/live-session side uses a fraction of the SDK.
4. **Trust in derived signals** (R3-4): stdout parsing where authoritative session-file entries
   exist — the same lineage as the P1-1 replay work; fix once, in the session file.

---

## 6. Leader decisions requested

- **D1 (R3-3):** worker trust direction — hermetic (`-na`, matches SEC-1 strip posture) vs
  project-aware (`-a`, matches R3-18 AGENTS.md auto-load). Decide jointly with a reading of R3-18.
- **D2 (R3-17):** in-process embedding as worker transport. Recommendation:
  **document-and-decline** (this document §2 R3-17) unless a non-sandboxed fast lane is wanted.
- **D3 (coverage):** dispatch one follow-up explorer for **L3 (models/codemode/skills/
  custom-provider/packages/mcp-delta) + E residual docs + probes (b) skills-flag and (c) `-e`
  load-cost** before closing round 3. L3 contains two explicit task-packet questions (Q3a
  skillPaths standard, Q3b scopeModels syntax) that remain unanswered.

**Sequencing note:** R3-1 and R3-2 are independent of the unmined lanes and can be scheduled
immediately; R3-1's coexistence probe is ~10 min. R3-11's `tool_search` assumption should be
verified in the D3 probe batch.

---

*Written by 07_write from the 06_synthesize unified matrix (authoritative merge of shards
02/03/05; shard 04 false-complete, content covered by 02). No other pi-crew files modified; the
repo remains 24 commits ahead of origin under the 0.11.7 release hold.*
