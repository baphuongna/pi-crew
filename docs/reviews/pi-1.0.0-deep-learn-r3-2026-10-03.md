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

---

## Round 3b — Gap closure (L3 + E + probes)

- **Date:** 2026-10-03 (same day, follow-up)
- **Mandate:** D3 (§6 of this document) — close the two never-dispatched lanes (L3 models/talent,
  E residual docs) and the two missing probes (L4 b/c) before round 3 closes.
- **Executor:** direct agent `01_01-agent` (run `team_20261003163341_0e66b43cf21dac1e`, team
  `direct-executor`). All citations below were read directly by the writer **[W]** (docs, SDK
  `dist/`, pi-crew `src/`) or produced by the R3b probes **[P]** in `/tmp/pi-deeplearn-r3/`
  (new files prefixed `b-`/`c-`/`r3b-`; R3-round files `a1/a2/proj/empty/sess` untouched).
  `PI_CREW_*` scrubbed from every probe child env (worker-shell gotcha, knowledge.md 2026-08-15).
- **Deliverable:** this section only. §0/§1 tables above are untouched (audit trail); the updated
  completeness view lives in §R3b.7.

### R3b.1 New candidates (R3-19…R3-23) — same format as §1

| ID | Mechanism | Type | Pri | Effort | Adoption-fit (where it lands in pi-crew) |
|----|-----------|------|-----|--------|------------------------------------------|
| R3-19 | Hermetic worker spawns: `-ne` (`--no-extensions`) + keep explicit `-e prompt-runtime` — kills the ~1.4 s/spawn ambient package-extension tax AND the ambient untrusted surface (host MCP tools + host-side team tools in workers) | ALIGNMENT (needs leader decision — reverses D5 default) | **P2** | S–M | `pi-args.ts` worker arg builder (line 339 already passes prompt-runtime via `--extension`) |
| R3-20 | `scopeModels` pattern parity: strip `:<thinking>` suffix, support `?`/`[` glob chars, match model `name`, try `provider/id` + bare-id forms — or reuse the SDK's own matcher | ALIGNMENT | P3 | S | `model-scope.ts:55-72` (`matchesModelPattern`) vs SDK `model-resolver.js:204-270` |
| R3-21 | Crew skills bypass `--no-skills` via the `resources_discover` hook → `inheritSkills: false` is half-effective; cwd `skills/` (untrusted project content) is also injected regardless of trust | CONFIRMED-BEHAVIOR → **needs leader verdict (D4)**: intended-infra or fix | P3 | S (doc) / M (fix) | `hook-registration.ts:65-77`; interacts with `pi-args.ts:357` |
| R3-22 | Container-isolated workers (plain Docker / Docker Sandboxes / OpenShell / Gondolin) | NEW-ADOPTION candidacy → **recommend DOCUMENT-AND-DECLINE** (same family as R3-17) | P3-arch | L | conflicts with the current runtime-limits sandbox posture; re-open only if an untrusted-task threat model materializes |
| R3-23 | Deduplicate skill advertisement: host `<available_skills>` (system prompt) and pi-crew's "Applicable Skills" index block both advertise name+description+path for every selected skill | ALIGNMENT | P3 | S | `skill-instructions.ts` (SR-02 index block) × `--skill`-driven host advertisement (skills.js:275-298) |

**R3-19 detail.** Probe C (§R3b.6) measured first-stdout-record at **431 ms** with
`--no-extensions --no-skills` vs **1806 ms** with the ambient package stack — the ambient
extension discovery/load (pi-crew host extension + 4 other configured packages) costs
**~1.37 s per spawn**, paid by every worker (D5: "extension discovery hoạt động như main
session"). The standard CLI explicitly supports the hermetic combination: "Disables discovered,
configured, and built-in extensions. Explicit `-e` paths still load" (`cli.md:186-187`) — and
`pi-args.ts:339` already passes prompt-runtime explicitly, so workers would keep the coordination
layer. The probe shell also showed the ambient surface leak concretely: a plain `-p` spawn
declares `team`, `crew_agent`, `Agent` (pi-crew host tools) plus 8 direct-exposure MCP tools
(firecrawl, zai_mcp, web_search_prime, hostinger×5) — see §R3b.6; hermetic spawns show only
`read/bash/edit/write`. Tradeoff to decide: D5 parity (workers see user extensions/MCP) vs
~1.4 s/spawn + untrusted-surface reduction. Composes with D1 (R3-3) and E1 WI-4.

**R3-20 detail.** See §R3b.3 (Q3b) for the full divergence table.

**R3-21 detail.** Probe b-2 (§R3b.6): with `--no-skills --skill <probe>`, the user's 3
`~/.pi/agent/skills` skills and 8 other-package skills correctly disappear — but all **34
pi-crew skills remain advertised**, because the host extension's `resources_discover` hook
(`hook-registration.ts:65-77`) injects `packageRoot()/skills` (and the session-cwd `skills/`
dir) through the extension-resource path, which pi merges **after** the `noSkills` gate
(`resource-loader.js:419-423` gated set vs `:318-331` `updateSkillsFromPaths` extension merge).
Consequences: (1) `inheritSkills: false` (`pi-args.ts:357`) does not remove crew skills from
the worker system prompt — 34 name+description entries of context in every such worker; (2) the
same hook injects the **worker-cwd `skills/` dir** — untrusted project skill content
(pi-crew's own labeling, `skill-instructions.ts` trust block) gets advertised to workers
regardless of `inheritSkills` or project trust. Either document crew-skills-as-infrastructure
(same stance as prompt-runtime, `pi-args.ts:338` comment) or gate the cwd injection on trust.

### R3b.2 Q3a — is `--skill <path>` the standard 1.0.0 mechanism? (YES; no better API for process workers)

**Answer (1 line):** `--skill <path>` IS the documented standard channel (`cli.md:188-189`,
repeatable; `--no-skills` cannot suppress it — `cli.md:190-191`), it automatically gets the
host's progressive disclosure, and no better CLI API exists for process-spawned workers — the
finer-grained `skillsOverride` on `DefaultResourceLoader` exists only on the SDK embedding path
that R3-17 declined. **Evidence:**

- **Flag surface [W]:** `cli.md:188-189` — "`--skill <path>`: Loads a skill file or directory and
  is repeatable"; `cli.md:190-191` — "`-ns, --no-skills`: Disables discovered and configured
  skills. Explicit `--skill` paths still load." No `--skills` (plural) variant exists in the
  1.0.0 docs; `--skill`+`--no-skills` is the complete surface.
- **Progressive disclosure is built into the mechanism [W]:** at startup pi adds each skill's
  `name`/`description`/`location` to the system prompt as `<available_skills>` XML and nothing
  more (`skills.js:275-298` `formatSkillsForPrompt`; wired via `system-prompt.js:99-103`); the
  full `SKILL.md` loads only when the task matches (`skills.md` "Understand how skills load").
  CLI `--skill` paths enter the **same** discovered set (`resource-loader.js:419-423` merges
  `cliEnabledSkills`/`additionalSkillPaths` into `updateSkillsFromPaths`) — so `--skill` does
  not bypass progressive disclosure. **Probe-verified [P]:** b-1/b-2 system prompts contain the
  `<available_skills>` entry for the probe skill (name+description+location) with **no** full
  body and **no** co-located `notes.md` leak (§R3b.6).
- **pi-crew's usage is aligned [W]:** `pi-args.ts:357-358` emits exactly `--no-skills` (when
  `inheritSkills === false`) + repeatable `--skill <dir>` from `skillPaths` (fed by
  `skill-instructions.ts:418` render). pi-crew's SR-02 "index mode" block is an *additional*
  selection/confidence/trust layer on top — redundant with the host advertisement in
  name+description+path (→ R3-23) but not wrong.
- **Discovery-based alternative is worse for workers [W]:** relying on pi's discovery locations
  (`~/.pi/agent/skills`, `~/.agents/skills`, project `.agents/skills` walking cwd ancestors,
  `skills.md` "Add it to Pi") would be cwd-dependent, would pollute user repos, and stops at the
  repo root; explicit `--skill` is precisely the designed programmatic channel.
- **SDK-only better API (not applicable) [W]:** `DefaultResourceLoader({ skillsOverride })`
  (sdk.md "Configuring a session"; example `examples/sdk/04-skills.ts`) gives full programmatic
  filter+merge control — but only inside an embedded session (R3-17: document-and-decline).

### R3b.3 Q3b — does pi-crew `scopeModels` match the 1.0.0 `--models` pattern standard? (mostly; 4 concrete divergences)

**Answer (1 line):** pi-crew reads the **same allowlist source** (pi's own
`SettingsManager.getEnabledModels()`, `model-scope.ts:143-165`) and mimics the semantics order,
but its re-implemented matcher diverges from the standard `resolveModelScopeFromModels()` in 4
points — most importantly `:<thinking>` suffixes are **not stripped**, so a pattern like
`anthropic/claude-sonnet-5:high` in `enabledModels` falsely rejects the plain model id →
**hard error** for caller-supplied models (`model-fallback.ts:819`). Needs ALIGNMENT (R3-20).

The standard (`cli.md:71-72` `--models <patterns>` = "exact IDs, fuzzy matches, case-insensitive
globs, and optional `:<thinking>` suffixes"; `settings.md:16` `enabledModels` "Uses the same
format as `--models`"), implemented in `model-resolver.js:204-270` `resolveModelScopeFromModels`
[W], vs pi-crew `model-scope.ts:55-72` `matchesModelPattern` [W] — which itself claims parity in
its header (`model-scope.ts:9-13`) but does not fully deliver it:

| # | Standard behavior (1.0.0) | pi-crew behavior | Impact |
|---|---|---|---|
| 1 | `:<thinking>` suffix optional in patterns; stripped before matching (glob branch `model-resolver.js:214-222`; fuzzy branch `parseModelPattern` `:155-200`) | Suffix never stripped; raw pattern compared | **False out-of-scope → hard error** for caller-level models when user patterns carry suffixes |
| 2 | Glob chars = `*`, `?`, `[` (minimatch, `model-resolver.js:210`) | Only `*` (own `*`→`.*` regex, `model-scope.ts:47-53`) | `?`/`[...]` patterns degrade to substring match — usually still passes, but not equivalent |
| 3 | Fuzzy fallback matches model `id` **or `name`** (`model-resolver.js:114-115`) | `id` only (`model-scope.ts:71`) | Gate stricter than host; display-name references rejected |
| 4 | Globs tried against `provider/modelId` **and** bare `id` (`model-resolver.js:228-232`) | Single string form as configured | Provider-less model strings may miss provider-scoped globs |

Fix options (R3-20): minimal — strip a trailing valid-thinking suffix + treat `?`/`[` as glob
chars; full — resolve the allowlist through the SDK's own matcher (it is exported:
`model-resolver.d.ts:39`) or gate membership against `resolveModelScopeFromModels()` output.
Note the *hard-error* path makes divergence 1 user-visible, not cosmetic
(`model-fallback.ts:816-820`, `errors.ts:67`).

### R3b.4 L3 doc-by-doc yield record (completeness evidence for the lane)

All five docs read in full [W]; mcp.md read in full and compared against E1 §9 (delta only).

| Doc | Yield |
|---|---|
| `models.md` | Q3b standard extracted (§R3b.3); `--models`/`enabledModels`/`/scoped-models` wiring. No new candidate beyond R3-20. `/login` credential precedence + `models.json` `!command` interpolation: no pi-crew fit (host-managed creds). no-yield otherwise. |
| `codemode.md` | no-yield for adoption (codemode off by default; `classify()` already shelved P2-1). **Evidence gain:** `searchTools()`/`describeTool()`/`ALL_TOOLS` + "deferred … not listed, so the description stays the same while MCP servers connect" corroborate R3-11's discovery model. |
| `skills.md` | Q3a standard extracted (§R3b.2). No new mechanism beyond R3-23 (dedupe note). `disable-model-invocation`, `/skill:name` args, Agent-Spec `~/.agents/skills` locations: already covered by pi-crew's selection layer; no-yield. |
| `custom-provider.md` | no-yield — provider extensions are host-side integrations; pi-crew ships no providers. (`streamSimple` custom-stream contract already captured as R3-8 context.) |
| `packages.md` | **no-yield — already aligned:** pi-crew's manifest is exactly the documented form: host packages in `peerDependencies` with `"*"`, `pi` key `{extensions:["./index.ts"], skills:["./skills"]}`, `pi-package` keyword (package.json:124-130,25 [W]; rule at packages.md "Declare dependencies"). Object-form package resource filters and `autoload:false` delta-scoping: no current need. |
| `mcp.md` (delta vs E1 §9) | **no new candidate.** Two evidence notes: (1) "The first prompt waits up to 10 seconds only for servers with `direct` tools" — worker spawns inheriting ambient direct-exposure MCP servers (probe §R3b.6 shows 8 such tools declared) can pay up to +10 s first-prompt latency → strengthens E1 WI-4 and R3-19; (2) "Pi activates `tool_search` for a server with `deferred` exposure" → closes R3-11's precondition question (see §R3b.6). Resource tools / OAuth `authServerMetadataUrl` / `toolExposure` patterns: E1 KEEP-STATUS-QUO already governs. |

### R3b.5 Residual-docs triage (E lane — 13 files, verdict each)

Scan depth: headings + key sections for onboarding/reference pages; full read for
`tmux.md`/`containerization.md`/`shell-aliases.md` (flagged "đáng đọc kỹ"). All [W].

| Doc | Verdict (1 sentence) |
|---|---|
| `index.md` | no-yield — pure navigation overview. |
| `quickstart.md` | no-yield — end-user install/first-task onboarding; "choose how to customize" chooser maps to mechanisms already mined. |
| `usage.md` | no-yield — interactive-session usage; `/copy` `/export` `/share` `/debug` are host-session UX (pi-crew workers are `-p`/surface panes; `/debug`'s `pi-debug.log` is an ops curiosity only). |
| `providers.md` | no-yield — credential/env setup per provider; pi-crew deliberately does not manage provider creds (env must survive SEC-1 strip for workers to run — known behavior). |
| `message-types.md` | no-yield — type reference already consumed via the SDK's `.d.ts`; `BranchSummaryMessage`/`CompactionSummaryMessage` replay concerns are P1-1/P2-2 territory (R1/R2). |
| `tmux.md` | **conditional doc-note, no code candidate:** pi-crew's surface panes host *full interactive pi sessions* (`surface-worker.ts:6-8`), so if a user ever composes multi-line input inside a pane, the doc's `extended-keys on` + `extended-keys-format csi-u` tmux.conf guidance applies — today steering is mailbox-side and pi-crew sets no tmux key config (grep `extended-keys|csi-u` in `src/` = 0 hits), so no action; worth one line in the crew surface docs. |
| `shell-aliases.md` | no-yield — `shellPath`/`shellCommandPrefix` are user-global settings pi-crew doesn't touch (grep = 0 hits); the `!command`-in-settings pattern duplicates what models.json already provides. |
| `containerization.md` | **R3-22** (document-and-decline, §R3b.1) — whole-process Docker / Docker Sandboxes (credential-substituting proxy) / OpenShell / Gondolin micro-VM are a heavier isolation tier than pi-crew's runtime-limits sandbox; record the option, keep the current model. |
| `llama-cpp.md` | no-yield — local GGUF router ops; pi-crew model routing is provider-agnostic and already works with any configured provider. |
| `termux.md` | no-yield — Android/Termux install specifics. |
| `windows.md` | no-yield — native-Windows/WSL shell selection (`shellPath` resolution order); pi-crew is not Windows-targeted today. |
| `terminal-setup.md` | no-yield — per-terminal key/IME troubleshooting for humans at a terminal; the IME cursor contract as an extension concern is already R3-6. |
| `docs.json` | no-yield — site navigation metadata; confirms the corpus list used by this triage. |

### R3b.6 Probe evidence (L4 b + c + control + opportunistic R3-11)

All runs: `timeout -k 5` outer wrapper, real exit codes reported, `PI_CREW_*` scrubbed,
sessions under `/tmp/pi-deeplearn-r3/sess-{b,c}`, cwd `/tmp/pi-deeplearn-r3/probe-cwd`, scratch
skill `b-skill/r3probe/SKILL.md` (frontmatter `name: r3-probe-skill`). Scripts kept:
`r3b-probe-b-skills.py`, `r3b-probe-c-extcost.py` (+ inline C-arm block recorded in run log).

**(b) Skills-flag injection — 2 runs, both exit 0.**

- **b-1** `timeout -k 5 120 pi --mode json -p --session-dir …/sess-b --skill /tmp/pi-deeplearn-r3/b-skill/r3probe "<list all skills>"` → exit 0, 579 records, wall 17.9 s. System-prompt `<available_skills>` = **46 entries incl. `r3-probe-skill`**; full SKILL.md body absent (progressive disclosure ✓); co-located `notes.md` absent (no bundle leak ✓); assistant listed `r3-probe-skill` then `PROBE-DONE`. *(The one-turn prompt did not trigger reading SKILL.md, so the in-body marker `R3PROBE-SKILL-LOADED` is absent from the reply — advertisement, not body, is the contract; consistent with skills.md.)*
- **b-2 (variant)** same + `--no-skills` → exit 0, 1196 records, wall 43.3 s. `<available_skills>` = **35 entries: `r3-probe-skill` + all 34 pi-crew skills**; the user's 3 `~/.pi/agent/skills` skills and 8 other-package skills correctly suppressed. Confirms `cli.md:191` (explicit `--skill` survives `--no-skills`) live, and exposes R3-21 (crew skills arrive via `resources_discover`, not discovery).

**(c) Extension-load cost with `-e` — 3 runs/variant, all exit 0, metric = spawn→first stdout record (type `session`, emitted before any model call).**

- Extension path: `PROMPT_RUNTIME_EXTENSION_PATH` = `<packageRoot>/src/prompt/prompt-runtime.ts` (`pi-args.ts:17`) — **exists as an independent source file**; no synthetic substitute needed.
- **A** `pi --mode json -p --offline` → first-record **1806 ms median** (2565/1759/1806).
- **B** `pi --mode json -p --offline -e <prompt-runtime.ts>` → **1797 ms median** (1766/1797/1805). **B−A = −9 ms** — incremental `-e prompt-runtime` load cost is within noise (A's own spread is ±800 ms).
- **C (control, added)** `… --offline --no-extensions --no-skills` → **431 ms median** (430/431/469). **A−C ≈ 1.37 s = ambient package-extension stack cost per spawn** (pi-crew host extension + 4 configured packages — stderr shows `[pi-crew] Session shutdown…` in A *and* B, proving the ambient load is present in both arms; B measures only the incremental `-e`). → R3-19.
- Wall-clock sanity: all runs completed a full model turn (A 11.9–15.6 s; B ~9.2 s; C ~5-9 s), consistent with R3 P-B (model latency dominates total run, extensions dominate startup).

**Opportunistic R3-11 verification (tool surfaces from the same outputs).** Declared tools in
the system-prompt tools section: b-1/b-2/c-B1 = `read, bash, edit, write, team, crew_agent,
Agent, mcp, mcp__firecrawl, mcp__zai_mcp, mcp__web_search_prime, mcp__hostinger_{hosting,domains,dns,billing,reach,vps}`;
c-C3 = `read, bash, edit, write` only. Findings: (1) **`tool_search` is NOT declared in plain
`-p` sessions on this host** — R3-11's docs-asserted assumption is **false by default**;
`tool_search` activates only when a `deferred`-exposure server/tool exists (mcp.md "Control tool
exposure"), so R3-11 additionally needs `"defaultTools": ["+tool_search"]`-style activation
(or an SDK `createToolSearchExtension()` factory, sdk.md) before `deferred` tool declarations
become discoverable — precondition now closed. (2) Ambient host-side tools (`team`, `crew_agent`,
`Agent`) and 8 direct-exposure MCP tools reach every default-discovery worker spawn (D5) —
concrete tool-level evidence for R3-19 and E1 WI-4.

### R3b.7 Updated completeness (supersedes §0 rows — old table left intact for audit)

| Shard / item | Status after Round 3b | Closed by |
|---|---|---|
| L3 models/talent | ✅ complete (models/codemode/skills/custom-provider/packages full; mcp delta vs E1 §9) | Round 3b §R3b.4 |
| E residual-docs triage | ✅ complete (13/13 files verdicted, §R3b.5; `security.md` trust § + `slash-commands.md` were already read in R3) | Round 3b §R3b.5 |
| L4 probe (b) skills-flag | ✅ complete (2 runs, exit 0, §R3b.6) | Round 3b §R3b.6 |
| L4 probe (c) `-e` load-cost | ✅ complete (3 variants × 3 runs, exit 0, §R3b.6) | Round 3b §R3b.6 |
| Q3a (skillPaths standard?) | ✅ answered — standard; no better CLI API (§R3b.2) | Round 3b |
| Q3b (scopeModels parity?) | ✅ answered — 4 divergences, ALIGNMENT R3-20 (§R3b.3) | Round 3b |
| R3-11 `tool_search` precondition | ✅ verified false-by-default; activation requirement recorded (§R3b.6) | Round 3b |

**Remaining known-unmined:** `session-format.md` (structure only, per §0 — unchanged);
`json.md` partial (R2). No new leader decisions beyond **D4 (R3-21)** and the R3-19 D5-reversal
decision were introduced; D1/D2/D3 from §6 stand, with D3 now satisfied by this section.

*Round 3b written by executor 01_01-agent (direct-executor team). Files touched:
this document only. Probes and scratch under /tmp/pi-deeplearn-r3 (R3-round files untouched).*
