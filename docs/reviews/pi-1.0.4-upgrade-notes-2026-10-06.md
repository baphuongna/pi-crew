# Pi 1.0.4 Upgrade Notes — pi-crew

- **Date:** 2026-10-06
- **Run:** `team_20261006101029_3e1f7b7662ec14a4` (parallel-research: 1 discovery + 4 explorer/analyst shards → synthesis → this write)
- **Scope:** Opportunity + risk dig of the Pi 1.0.4 SDK surface for pi-crew (HEAD `7caf408e`), across four
  lanes: (1) child-pi spawn surface, (2) extension API, (3) model/provider surface, (4) TUI + misc.
  READ-ONLY against pi-crew `src/` — this file is the sole deliverable of the wave.
- **Environment split (matters throughout):** the **host session runs pi 1.0.4**
  (`/home/bom/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/`, version
  field verified this run — hereafter `$PI`), while pi-crew's **own `node_modules` still holds 1.0.0**
  (`/home/bom/source/my_pi/pi-crew/node_modules/@earendil-works/pi-coding-agent/`, `"version": "1.0.0"`
  verified this run — hereafter `$PI100`). The 1.0.0 copy made a real `$PI100` ↔ `$PI` diff possible
  (shards had assumed it was not — see §Method).
- **Prior records:** [pi-1.0.0-adoption-review-2026-10-03.md](pi-1.0.0-adoption-review-2026-10-03.md)
  (R1+R2, items P0-1…P2-4), [mcp-exposure-design-review-2026-10-02.md](../mcp-exposure-design-review-2026-10-02.md)
  §9 (KEEP-STATUS-QUO), `docs/bugs/SECURITY-AUDIT.md` (brace-expansion precedent).

## Provenance legend

- **[V]** — verified directly in this run by reading the cited file:line (06_synthesize re-verification
  pass and/or 07_write spot-checks listed in §Method).
- **[S]** — shard evidence pack (shards 02–05, each self-verified with file:line); not re-opened.
- **[R]** — re-confirmed during the conflict-resolution pass (see next section).

## Conflict resolution (read this before the table)

The four shards disagreed on one load-bearing premise: **does `--no-extensions` disable built-in MCP?**

- Shard 02 (and 03's framing) claimed it does not — hermetic workers leak ambient MCP; made `--no-mcp`
  a P0 hardening item.
- Shards 04/05 claimed it does.

Resolved against source [R]:

- `$PI/dist/core/resource-loader.js:404-406` — under `noExtensions`, only explicitly-passed `-e` CLI
  paths load.
- `$PI/dist/core/package-manager.js:739-742` — `builtin:mcp` is a built-in *extension*, discovered
  through the extension-discovery path that `--no-extensions` disables.
- `$PI/dist/main.js:634` — `--no-mcp` maps to `disabledBuiltinExtensions: ["mcp"]`, i.e. it is a
  finer-grained carve-out of the same mechanism.
- Contrast, 1.0.0: `$PI100/dist/core/resource-loader.js:500` filtered out ALL `builtin:` paths —
  shard 02's premise describes pre-1.0.4 behavior / parity mode, not current hermetic behavior. The D5
  note it cites (`src/runtime/model/pi-args.ts:347-356`) describes the leak *before* the R3-19/D5
  reversal (2026-10-04), as motivation.

**Verdict: on pi 1.0.4, pi-crew's default hermetic workers (`--no-extensions`) are already MCP-clean.
`--no-mcp` drops from P0 to P3 parity-optional (U9).** The only remaining P0 is the dependency bump
itself (U1).

---

## Executive summary

**Nothing pi-crew ships today breaks on 1.0.4.** The spawn-flag surface pi-crew builds
(`--mode json -p`, `--session-id/--session-dir/--name`, `--no-approve`, `--append-system-prompt`,
`--extension`, `--tools`, `--no-extensions`, `--no-skills`) is unchanged 1.0.0→1.0.4 [V/S]. The
extension-API type surface is strictly additive (§Lane 2 diff: 5 additions, 0 removals, 0 signature
changes). pi-tui still exports `CURSOR_MARKER`/`hyperlink` — now as *documented* public contract
(DR3 retired, U13).

The real work is:

1. **U1 (P0):** bump devDeps `^1.0.0`→`^1.0.4` + lockfile refresh. pi removed its npm-shrinkwrap in
   1.0.1, so pi's transitives float; pi-crew's lock currently resolves `brace-expansion 5.0.9`
   (dev-scope) where pi pins 5.0.12 (#10288).
2. **Behavioral drift, not breakage:** `--tools` no longer cuts MCP on 1.0.4 (affects parity mode and
   surface panes — U2), azure provider rename (user config, 1.0.3 — U3), `.pi/mcp.json` project
   overrides on trusted-project panes (U5), and one pre-existing rendering bug worth fixing while
   nearby (DR4, U6).

### Canonical table (U1–U16)

Shard-local numbering (02: U1–U12, 04: U1–U14, 05: U1–U12) is merged into one canonical list. Effort:
S < 1 day, M = days, L = week+.

| ID | Item | Priority | Effort | Evidence (pi 1.0.4 ↔ pi-crew) | Status tag |
|----|------|----------|--------|-------------------------------|------------|
| U1 | Bump devDeps `^1.0.0`→`^1.0.4` + lockfile refresh + `npm audit` gate | **P0** | S | CHANGELOG 1.0.1 (#10288 pins brace-expansion 5.0.12; #5653 removes shrinkwrap) ↔ `package.json` devDeps `^1.0.0` (~:148-151); lockfile resolves `^5.0.8`→5.0.9 under `@earendil-works/pi-coding-agent/node_modules/minimatch` (`"dev": true`, ~:2393-2399) | [V/R] |
| U2 | `--tools` 1.0.4 semantics: MCP tools kept unless an `mcp__` entry exists; `*` patterns now valid | P1 | S | `docs/cli.md:119-138` ↔ `src/runtime/model/pi-args.ts:376,384` (verbatim pass-through) | [V] |
| U3 | Azure provider rename (breaking in 1.0.3): `azure-openai-responses`→`azure`; env `AZURE_OPENAI_*` unchanged | P1 | S | CHANGELOG 1.0.3 ↔ `src/utils/env-filter.ts:32-33` already keys `azure`/`azure-openai`; 0 refs to old id in `src/` | [S×2, spot-checked V] |
| U4 | `THINKING_LEVELS` missing `max` (pi has 7 levels) | P2 | S | `docs/cli.md:70` ↔ `pi-args.ts:9` (6 levels, `max` absent) | [V both] |
| U5 | `.pi/mcp.json` project overrides (1.0.1) reach trusted-project surface panes | P2 | S | `docs/mcp.md:32-42` ↔ `child-pi.ts` `stripHeadlessOnlyFlags` (~:415-419) keeps ambient stack on panes | [V] |
| U6 | DR4: `consumeAnsi` lacks APC branch → `CURSOR_MARKER` counted as ~6 columns in truncate/wrap | P2 | S | pi-tui `CURSOR_MARKER` is documented public contract ↔ `src/utils/visual.ts:73-86` | [S:03] |
| U7 | `pi.registerToolRenderer()` (1.0.1) for tools not registered by us | P3 | S–M | `types.d.ts:1221` + `ToolRendererResolver` `:506` (absent in `$PI100`, grep=0 [V]) ↔ 0 uses; per-tool `renderCall` at `team-tool.ts:300`, `subagent-tools.ts:338` | [V/S] |
| U8 | `getPromptGuidelines`/hidden-tools-rules fix (#10343) | P3 | doc | `types.d.ts:426` (absent in `$PI100` [V]) ↔ R3-23 `skill-instructions.ts:346-351` uses the host `<available_skills>` channel — unaffected | [V/S] |
| U9 | `--no-mcp` flag (1.0.4) for parity-mode hardening | P3 | S | `dist/cli/args.js:155` (absent in `$PI100` args.js [V]) ↔ `pi-args.ts:410` has only `--no-extensions`; no host-version floor mechanism exists (grep=0 [V]); strict parser rejects unknown flags (`pi-args.ts:313-316` comment [V]) | [V/R] |
| U10 | Clef/jev classifiers → input for the pending P2-1 `classify()` decision | P2 | decision | `docs/models.md:129-164` (classify() without codemode; creds table; `opencode/jev-1.13-free` needs only `OPENCODE_API_KEY`) ↔ 0 classify uses; host auth.json has no classifier creds | [S:03/02] |
| U11 | `samplingParamsByThinkingLevel` (1.0.2) | P3 | doc | CHANGELOG 1.0.2 + `model-config.d.ts:52` ↔ user-level models.json; pi-crew no-op (`provider-extensions.ts` only discovers `-e` provider packages) | [S] |
| U12 | codemode image-read (#10251) | P3 | — | CHANGELOG 1.0.4 ↔ no role grants codemode (`role-tools.ts` grep=0) | [S:05] |
| U13 | DR3 RETIRED: `CURSOR_MARKER`/`hyperlink` exported + documented | verify | no-op | pi-tui `tui.d.ts:113`, `index.d.ts:30-31`, README:311-328, `docs/tui.md:48` ↔ imports at `mailbox-compose-overlay.ts:26`, `settings-overlay.ts:7` | [V×3 shards + diff] |
| U14 | Output-file perms 0o600 (1.0.3) | P3 | no-op | `dist/utils/output-files.js:13` (`OUTPUT_FILE_MODE=0o600`) ↔ 0 output-file readers in pi-crew `src/`; same OS user | [S] |
| U15 | Home/End keybinding change (1.0.3) | P3 | note | CHANGELOG 1.0.3 ↔ overlays self-bind home/end (`agent-view-overlay.ts:176-180`) | [S] |
| U16 | Session flags/resume STABLE 1.0.0→1.0.4 | verify | no-op | `args.js` `--print`/`--no-approve`/`--append-system-prompt`/`--session-id`/`--session-dir`/`--no-session`/`--name` all present [S:04] ↔ `session-recovery.ts` assumptions intact; #10249 fixes MCP transport shutdown (fewer worker exit hangs) | [S] |

---

## Lane 1 — Child-pi spawn surface

pi-crew's argv builder is `src/runtime/model/pi-args.ts` (the task brief named `child-pi-spawn.ts`;
discovery corrected the anchor — spawn options/env plumbing lives there, flags live in pi-args.ts [S:01]).

### Flag surface: unchanged [U16]

Every flag pi-crew emits still parses identically on 1.0.4: `--mode json -p` (`pi-args.ts:314`),
`--no-session`, `--session-id`/`--session-dir`/`--name` (`:316-330`), `--model`/`--thinking`,
`--tools`/`--exclude-tools` (`:376,384`), `--extension` (`:375`), `--no-extensions`/`--no-skills`
(`:410-411`), `--append-system-prompt` (`:422,438`), `--no-approve` (`:462`) — all verified present in
`$PI/dist/cli/args.js` [S:04] and in `docs/cli.md:69-125` [V]. No changelog entry 1.0.1–1.0.4 touches
session flags or json-mode format, so `session-recovery.ts` tail-recovery assumptions hold. Bonus:
#10249 (1.0.4) fixes MCP transport shutdown — reduces worker hang-at-exit risk when MCP servers are
connected (parity mode / surface panes).

### `--tools` semantics drift [U2] — the one real spawn-surface change

- pi 1.0.4 (`docs/cli.md:119-138`): `--tools` entries may be `*` patterns; **MCP tools are kept**
  (registered, matchable via `mcp__server__tool` patterns) when no `mcp__` entry names them —
  "an MCP tool that no entry names or matches is never declared directly". Pre-1.0.4, `--tools`
  removed MCP tools entirely (CHANGELOG 1.0.4 "Fixed" — [S], wording-based; no 1.0.0 behavioral probe).
- pi-crew (`pi-args.ts:376,384`) passes frontmatter `tools:`/`disallowedTools:` verbatim.
- **Who is affected:** NOT default hermetic workers (`--no-extensions` kills built-in MCP — conflict
  verdict above). Affected: parity-mode workers (`runtime.hermeticWorkers=false` /
  `PI_CREW_HERMETIC_WORKERS=0`) and surface TUI panes with declared `tools:` — ambient/project MCP
  servers now stay *connected* (latency/network/credential reach) even though their tools are not
  auto-declared.
- **Free upside (0 code change):** frontmatter `tools: read,bash,mcp__jira__*` now works on 1.0.4 —
  verbatim pass-through means per-server MCP allowlists are already expressible.
- **Mitigation (optional, cross-version-safe):** append `--exclude-tools mcp__*` for parity spawns.
  On pre-1.0.4 hosts the pattern value matches no literal tool name → benign no-op; on 1.0.4 it cuts
  MCP. This is static inference, not probed [R inferred]. **Scoping note from this run:** the default
  loadout test asserts `!args.includes("--exclude-tools")`
  (`test/unit/runtime/model/pi-args-loadout.test.ts:19`) — any such append must be conditional on
  non-hermetic spawns or the test breaks.

### `--no-mcp` [U9] — parity-optional, gated

`--no-mcp` exists only on 1.0.4 (`$PI/dist/cli/args.js:155`; grep in `$PI100` args.js = 0 [V]). pi uses
a strict option parser that rejects unknown flags — a hazard pi-crew's own `pi-args.ts:313-316`
comment already warns about — and pi-crew has **no host-version floor mechanism** (grep for version
gate = 0 [V]). If ever adopted (parity "hermetic-lite": cut MCP, keep other ambient extensions),
it requires a host-version check or kill-switch; hard-fails on hosts <1.0.4 otherwise.

### thinking `max` [U4]

pi's CLI documents 7 levels incl. `max` (`docs/cli.md:70`); pi-crew's `THINKING_LEVELS`
(`pi-args.ts:9`) has 6, no `max` — frontmatter `thinking: max` is rejected by `isValidThinkingLevel`.
Trivial fix; unrelated to the upgrade (the gap also exists against 1.0.0's docs).

## Lane 2 — Extension API

### Full `extensions/types.d.ts` diff, `$PI100` ↔ `$PI` [V — performed by 07_write, closes the shard-05 gap]

Both copies exist on this machine, so the "additions beyond changelog" gap was closable. Result —
**5 additions, 0 removals, 0 signature changes** (1711 → 1722 lines):

| Addition | `$PI` line (approx) | Notes |
|---|---|---|
| `ToolLoadout.getPromptGuidelines(name): readonly string[]` | :426 | backs hidden-tools-rules (#10343) |
| `export type ToolRenderers = Pick<AnyToolDefinition, "renderShell" \| "renderCall" \| "renderResult">` | :505 | new type |
| `export type ToolRendererResolver = (toolName, next) => ToolRenderers \| undefined` | :506-509 | resolver chain |
| `ExtensionAPI.registerToolRenderer(resolver)` | :1221 | between `registerEntryRenderer` and `sendMessage` |
| `Extension.toolRenderers?: ToolRendererResolver[]` | ~:1565 | loader-side, optional |

Everything else — all 40+ `on()` event overloads, `ExtensionUIContext`, `ToolDefinition`,
`ProviderConfig`, virtual-model surface, the four stability markers (2× `@deprecated`
`usesCallbackServer`, 2× `@internal`) — is byte-identical. Marker count is unchanged from the 1.0.0
review's census; none sit on surfaces pi-crew imports.

### `registerToolRenderer()` [U7] — defer until a rendering need exists

Renders calls/results for tools *not* registered by the extension (resumed sessions, MCP tools);
resolvers run in extension-load order with `next()` fallback (`docs/extensions.md:188-190`). pi-crew
today only uses per-`ToolDefinition` `renderCall`/`renderResult` (`team-tool.ts:300`, `subagent-tools.ts:338`,
`src/ui/tool-renderers/index.ts:73`). If adopted, follow the optional-chain feature-detect pattern of
`src/extension/message-renderers.ts:100-107` — peer `*` means older hosts must not crash.

### hidden-tools-rules / `getPromptGuidelines` [U8] — info-only, favorable

1.0.4 (#10343): tools hidden from declarations are dropped from system-prompt rules, and skills hints
no longer name a tool whose file-reader is hidden. pi-crew's R3-23 skill advertisement rides the host
`<available_skills>` section (fed by `--skill` flags, `pi-args.ts:412`), structurally unaffected
[V/S]. Net effect for pi-crew: `--tools`-pinned workers get leaner, more accurate prompts for free
after U1.

## Lane 3 — Model/provider surface

### Azure rename [U3] — user-config risk, not code

1.0.3 renamed provider id `azure-openai-responses`→`azure`; env vars `AZURE_OPENAI_*` unchanged;
`auth.json`/`models.json`/`settings.json` entries using the old id need renaming; old versions lose
prompt cache on migrated configs (CHANGELOG). pi-crew: `env-filter.ts` PROVIDER_ENV_KEY_MAP already
has `azure` and `azure-openai` keys (both → `AZURE_OPENAI_*`) [V spot-check]; no `azure-openai-responses`
string anywhere in `src/` [S×2]. Action: ops/release-notes line only.

### Clef/jev classifiers [U10] — decision input for P2-1

`docs/models.md:129-164`: extensions call `ctx.modelRegistry.classify()` without codemode; credential
table lists cloudflare-workers-ai (needs `CLOUDFLARE_API_KEY`+`CLOUDFLARE_ACCOUNT_ID`), typesafe,
openrouter, and **`opencode/jev-1.13-free` (free, needs only `OPENCODE_API_KEY`)** — the cheapest
unblock path for the P2-1 spike that R2.3 found credential-blocked. Host-side only (extension ctx,
not child workers). Still blocked on this host today: no classifier creds present [S:03]. This is a
leader decision, not a code item.

### `samplingParamsByThinkingLevel` [U11] — no-op

1.0.2 adds per-thinking-level sampling overrides in user-level `models.json`
(`model-config.d.ts:52` [S]). pi-crew doesn't manage models.json; workers inherit via `--model id:level`.
Ops-doc note at most.

## Lane 4 — TUI + misc

### DR3 retired [U13], DR4 still real [U6]

- pi-tui 1.0.4 exports `CURSOR_MARKER` (`tui.d.ts:113`, re-exported `index.d.ts:31`) and `hyperlink`
  (`index.d.ts:30`), AND documents both as public contract (pi-tui README:311-328; pi `docs/tui.md:48`)
  [V×3 shards]. The "undocumented export can vanish" risk is gone; remaining residual is ESM-load on
  hypothetical older hosts. The P3 namespace-import hardening is now optional polish.
- DR4 is pre-existing and upgrade-independent: `consumeAnsi` (`src/utils/visual.ts:73-86`) has no APC
  branch, so the 6-byte APC cursor marker counts as visible columns in truncate/wrap paths [S:03]. S fix.

### `.pi/mcp.json` project overrides [U5] — trusted panes only

1.0.1 added project-level `mcp.json` overrides (`enabled`/`exposure`/`toolExposure` per server,
`docs/mcp.md:32-42`), read only after project trust. Headless workers are safe by construction:
`--no-approve` (`pi-args.ts:462`) pins distrust, so project files don't load [V; security.md:40,50].
Surface TUI panes deliberately strip `--no-approve`/`--no-extensions` (`stripHeadlessOnlyFlags`,
`child-pi.ts` ~:415-419 [V]) → a pane in an already-trusted project now inherits project MCP
overrides. This is intended pi behavior, but mcp-exposure-review §9 (2026-10-02) predates 1.0.1 —
needs a short addendum there, not code.

### Output-file perms [U14], Home/End [U15], shrinkwrap/brace-expansion [U1 scope]

- 1.0.3 made output files user-readable-only (`OUTPUT_FILE_MODE=0o600`, `output-files.js:13` [S]).
  Scope = truncated tool output / binary MCP resources / codemode images — NOT session files. pi-crew
  has 0 output-file readers; workers and host run as the same OS user. No break.
- 1.0.3 moved Home/End to editor line start/end, transcript top/bottom to Ctrl+Home/End. pi-crew
  overlays self-bind raw home/end for scroll (`agent-view-overlay.ts:176-180` [S]) — keys still
  deliver; optionally add Ctrl+Home/End aliases for convention parity.
- 1.0.1 removed pi's npm-shrinkwrap ("library consumers can now override") and pinned
  `brace-expansion 5.0.12` directly (#10288). pi-crew's lock resolves 5.0.9 via
  `@earendil-works/pi-coding-agent/node_modules/minimatch` (`brace-expansion ^5.0.8`) — **dev-scope**
  (`"dev": true` on the minimatch entry [V this run]) so runtime installs are unaffected, but
  `npm audit` will keep flagging it until refresh. Precedent: `docs/bugs/SECURITY-AUDIT.md:340`.

---

## Compat-risk table

| Change (pi side) | pi-crew surface touched | Risk | Item |
|---|---|---|---|
| Azure provider id rename (1.0.3) | none in code; USER configs (`auth.json`/`models.json`/`settings.json`) | **MED** (ops) | U3 |
| `--tools` MCP-keep semantics (1.0.4) | parity-mode workers + surface panes with declared `tools:` | LOW (drift: servers connect; tools still not auto-declared) | U2 |
| `.pi/mcp.json` overrides on trusted-project panes (1.0.1) | surface panes only (intended ambient behavior) | LOW (doc) | U5 |
| Transitive drift after shrinkwrap removal (1.0.1) | devDependencies tree; brace-expansion 5.0.9 flagged | MED until U1 (audit gate) | U1 |
| `--no-mcp` on host <1.0.4 | only if U9 adopted without version floor → worker hard-fail (strict parser) | LOW-unless-adopted | U9 |
| Output-file 0o600 (1.0.3) | none (0 readers, same user) | NONE | U14 |
| pi-tui `CURSOR_MARKER`/`hyperlink` exports | imports intact + now documented | NONE | U13 |
| Session/json-mode flags | none | NONE | U16 |
| Extension API type surface | strictly additive (5 additions, 0 removals — §Lane 2 diff) | NONE | U7/U8 |

## Decision table (for the leader)

| Bucket | Items | Rationale |
|---|---|---|
| **MUST-DO (with the upgrade)** | **U1** — bump devDeps `^1.0.0`→`^1.0.4`, refresh lockfile, gate on `npm audit` + `npm run test:critical` + `typecheck` + `npm run ci` | closes brace-expansion finding; refreshes the type floor the diff above was computed against; only P0 |
| **NÊN-LÀM (should)** | U4 (`max` level), U2-lite (`--exclude-tools mcp__*` scoped to parity spawns; cross-version-safe), U3 azure ops-note, U5 §9 addendum, U6 DR4 fix | all S-effort; none block the bump; U2-lite must respect the `pi-args-loadout.test.ts:19` default assert |
| **ĐỂ-SAU (defer)** | U7 (registerToolRenderer), U8 (doc note), U9 (`--no-mcp`, needs floor), U11, U12, U13-hardening (optional), U14, U15 | additive/optional; no current consumer or need |
| **LEADER DECISION** | U10: P2-1 classifier credentials (free `opencode/jev-1.13-free` vs Cloudflare pair vs keep shelved). Second: build a host-version floor mechanism or not — unlocks U9 and future gated flags | input for the pending P2-1 spike; floor is a one-time S–M investment |

## Method & verification

Run shape: 01 discovery → shards 02 (core), 03 (UI/extension), 04 (runtime/spawn), 05 (extension-deps)
→ 06 synthesis (canonical U-list + conflict verdict) → 07_write (this file). All lanes read source on
both sides; changelog was hypothesis-map only.

07_write re-verified in this session, beyond the 06 pass [V]:

1. Versions: `$PI/package.json` = 1.0.4; `$PI100/package.json` = 1.0.0.
2. pi-crew argv builder content: `pi-args.ts:9` (THINKING_LEVELS, no `max`), strict-parser NOTE
   (~:309-315), D5 comment (~:345-360), `--tools`/`--exclude-tools`/`--extension`/`--no-extensions`/
   `--no-skills`/`--skill`/`--no-approve` push sites in order; `child-pi.ts` `stripHeadlessOnlyFlags`
   (~:415-419); `env-filter.ts` PROVIDER_ENV_KEY_MAP (`azure`, `azure-openai`); `package.json`
   peer `*` ×4 + devDeps `^1.0.0` ×4.
3. Full `$PI100` ↔ `$PI` diff of `dist/core/extensions/types.d.ts` (both files read end-to-end):
   the 5 additions in §Lane 2, nothing else. No other `.d.ts` was diffed by 07_write (model-config,
   provider-composer, index.d.ts deltas rest on shard citations).
4. Unit-test grep (shard-02 open question): `test/unit/runtime/model/pi-args-hermetic.test.ts` (full
   read) and `pi-args-loadout.test.ts` (full read) contain **zero MCP-flag argv asserts** — no test
   constrains `--no-mcp`/`mcp__*` today; the one relevant default assert is
   `!args.includes("--exclude-tools")` (loadout test, default-loadout case), which scopes any U2-lite
   append to non-hermetic spawns. `pi-args-session-flags.test.ts` / `pi-args-trust-pin.test.ts` /
   `pi-args-system-prompt-append.test.ts` not re-opened [S].
5. Lockfile: `brace-expansion ^5.0.8` chain under
   `node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch` with `"dev": true` (~:2393).

Not verifiable statically (carried forward as caveats): pre-1.0.4 `--tools`-vs-MCP behavior is
CHANGELOG-wording-based [S] (no 1.0.0 behavioral probe was run); Clef availability is
credential-gated; the `mcp__*` benign-no-op claim on pre-1.0.4 hosts is static inference (a non-matching
exclude value excludes nothing). No pi-crew code was modified and no tests were run (none apply to a
docs-only change).

## References

- pi 1.0.4 install — `/home/bom/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/`
  (CHANGELOG.md; docs/{cli,extensions,mcp,models}.md; dist/cli/args.js; dist/core/{resource-loader,package-manager}.js
  + main.js; dist/core/extensions/types.d.ts; dist/utils/output-files.js; dist/core/model-config.d.ts)
- pi 1.0.0 copy (diff baseline) — `pi-crew/node_modules/@earendil-works/pi-coding-agent/`
- pi-tui 1.0.4 — sibling package in the release dir (`dist/tui.d.ts`, `dist/index.d.ts`, README)
- pi-crew sources (read-only) — `src/runtime/model/pi-args.ts`, `src/runtime/child-pi/{child-pi,child-pi-spawn,session-recovery}.ts`,
  `src/utils/{env-filter,visual}.ts`, `src/runtime/skill-instructions.ts`, `src/extension/registration/{team-tool,subagent-tools}.ts`,
  `src/ui/**`, `package.json`, `package-lock.json`, `test/unit/runtime/model/pi-args-*.test.ts`
- Prior records — `docs/reviews/pi-1.0.0-adoption-review-2026-10-03.md`; `docs/mcp-exposure-design-review-2026-10-02.md` §9;
  `docs/bugs/SECURITY-AUDIT.md:340`
- Run artifacts — `.crew/artifacts/team_20261006101029_3e1f7b7662ec14a4/results/{01..06}_*.txt`
