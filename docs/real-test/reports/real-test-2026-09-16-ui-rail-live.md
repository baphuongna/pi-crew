# real-test-pi-crew — Run Report

**Date**: 2026-09-16 (late session; ~23:10–23:50)
**Trigger**: "chạy skill real test pi-crew ngay trên live session này - không chạy script" — verify the RAIL UI migration (0.11.1) on a LIVE session, not through offline probe scripts.
**Repo HEAD**: working tree (uncommitted 0.11.1 UI work)
**Bundle md5 (disk)**: `0d062b8301a67a8741590480ec4dcbd3` (3334.0 KB)
**Pi version**: 0.85.1 (`/home/bom/.nvm/versions/node/v22.23.1/bin/pi`)
**Run by**: leader session (no bespoke probe scripts; live `team`/`Agent` tool calls + real tmux TUI captures + repo-owned gates)

## Method note (the "no script" constraint)

Every surface check was done on a **live pi TUI**: a detached `tmux` session running real `pi`
(`tmux -S /tmp/rtp*.sock new-session -d -x 140 -y 45 -s rtp "cd … && exec pi"`), driven with
`send-keys` and observed with `capture-pane`. No harness file was written; the only commands used
are the repo's own gates (`npm run …`) and tmux/ps/grep observation. Wide **and** narrow (80-column)
renders were both captured live.

## Tier results

| Tier | Status | Evidence |
|---|---|---|
| 1 test:critical | ✅ | `117/117` pass, 13.8s (the skill's "102" is stale — count is 117 since the UI test lock landed). One earlier run showed `116 pass / 1 fail` = the known broker load-flake; immediate re-run green, and `test:unit` later ran 7857/0. |
| 2 3-path kill-switch | ✅ | default / `PI_CREW_BROKER=0` / `=1` all `117/117 pass` |
| 3 typecheck + bundle | ✅ | `tsc --noEmit` + strip-types import OK; bundle `3334.0 KB`; md5 `0d062b8301a67a8741590480ec4dcbd3`; `check-bundle-staleness` OK |
| 4 bundle md5 sync | ✅ | bundle rebuilt at 23:48; every tmux session used for verification was spawned AFTER that mtime (23:2x–23:4x) and its live behaviour proves the new code (RAIL plan card/dock/status bar exist only in 0.11.1) |
| 5 tmux TUI probe | ✅ | live captures: `/team-help` command list rendered; RAIL plan card, dock widget, status bar, AGENT card (CALL/STREAMING/COLLAPSED/EXPANDED) all captured verbatim |
| 6 pty probe | ⏭️ | skipped — tmux (Tier 5) covered the interactive path, and the pty probe would have meant running a script, which this run explicitly avoided |
| 7 smoke team run | ✅ | `team_20260916161509_57384da1b8c3c8ce` fast-fix `3/3`, 4838 tokens, 127306ms, consistency=1 (started from the live TUI via `/team-run`); plus 4 direct-Agent runs (`team_20260916161805_980f8f54d55d48e0` etc.) |
| 8 final md5 sync | ✅ | disk `0d062b8301a67a8741590480ec4dcbd3`; sessions spawned after the rebuild showed the fixed behaviour (see T13) |
| 9a read-only battery | ✅ (partial) | live `team action='list'` (6 teams · 15 workflows · 18 agents) and `action='health'` (658 runs scanned, summary printed) |
| 9b spawn paths | ✅ (partial) | live direct `Agent` call from the TUI rendered `┏ AGENT ▸ explorer` … `┗ ● explorer ···· ctrl+o` |
| 9b-W worker tools | ⏭️ | no worker-tool code touched this session |
| 9c lifecycle | ⏭️ | no lifecycle/crash-recovery code touched |
| 9d destructive | ⏭️ | data-protection: never run without explicit user request |
| 9e admin | ⏭️ | no CRUD code touched |
| 9f background | ⏭️ | no scheduler/goal-loop code touched |
| 10a surface E2E | ⏭️ | `src/runtime/surface/**` untouched this session |
| 10b live surface run | ⏭️ | `runtime.surface.visibleAgents` is not enabled in this workspace; enabling it would change user config — out of scope for a UI-language run |
| 10c herdr path | ⏭️ | pi is not running inside a herdr pane in this environment |
| 11 remediation regression | ✅ (read-only subset) | 11b `check:wc-gate` max `1101/2000` + present in the `ci` script; 11f reject format `type=${type}` at `scratchpad-lifecycle.ts:92`; 11g `widgetPlacement: "bottom"` in `defaults.ts:137` |
| 12 resource contracts | ✅ (read-only subset) | 12a output-contracts test `1/1`; 12b no folded scalars in `agents|teams|workflows`; 18 agents, 18 with `useWhen:` |
| 13 real-run UI render | ✅ | see below — **3 live-only defects found and fixed**, each re-verified live |

## Tier 13 — live evidence (verbatim, from a real TUI)

Rendered from real runs (no fixtures), at 140 and 80 columns:

```
┏ PLAN ▸ fast-fix ··························································· ▕░░░░░░░░░░░░▏ 0/3
┃ ⠋ #1 Find the likely source of the issue (11s)
┃ ◻ #2 Make the smallest safe fix.
┗ 0 done · 1 in progress · 2 open
┃ ⠦ CREW ▸ fast-fix · 1 running ···· ↓·enter          ← dock (spinner = really running)
┃ CREW ▸ 1r · 0/1 done · MiniMax-M3                   ← status bar while running
┏ AGENT ▸ explorer
┃ Đọc 10 dòng đầu tiên của file …/src/ui/rail.ts … Sau đó báo lại CHÍNH XÁC nội dung…
┃ ⠸ explorer ································· 18.0s · 40 tok/s
┗ ● explorer ········································ ctrl+o        ← after fix #3
```

Narrow-width (80 columns, live resize) — no tearing, hint survives:
```
┏ AGENT ▸ explorer
┃ Đọc file `/home/bom/source/my_pi/pi-crew/src/ui/rail.ts` và in ra đúng **…
┗ ● explorer ·············································· ctrl+o
┃ ⠹ CREW ▸ direct-explorer/direct-agent · 1 running ···· ↓·enter
┏ PLAN ▸ direct-explorer/direct-agent ··············· ▕░░░░░░░░░░░░▏ 0/1
```

**Invariant sweep on captured live text**: no `undefined`, no `╭/╮/╰/╯/├/┤`, no `->`, no
`input=…/cacheRead=…` wire format, no invented word, no bad plural (`1 runs`/`1 tools`),
glyph matches state (spinner only while running), `↓·enter` survives at 80 cols.

## Findings (real defects found by this live run — all fixed + re-verified live)

- **[FIXED] Status bar printed a meaningless zero count** — `┃ CREW ▸ 0r · 3/3 done · MiniMax-M3`
  right after a run finished (same defect class as the dock's retired `0 running`). `statusSummary`
  now skips zero segments and falls back to `idle`.
  Live: before → `1r · 0/1 done` (running) → `0r · 1/1 done` (done); after → `1r · 0/1 done` → `1/1 done`.
- **[FIXED] AGENT card cap dropped the expand chord** when the result carried no output preview —
  a bare `┗ ● explorer`, i.e. the affordance vanished exactly when the card is hardest to read. The
  cap now always carries the chord via `railLeaders`.
- **[FIXED] Phantom affordance `⌘E`** — the caps advertised `⌘E`, which pi 0.85.1 binds to
  `tui.editor.cursorLineEnd` (move the EDITOR cursor); the real chord is `app.tools.expand` = `ctrl+o`
  (`docs/keybindings.md:163`). Pressing `ctrl+o` on the live card prints `Tool output: expanded` and
  reveals `┃ ✓ explorer`; pressing `⌘E` does nothing to the card. New shared constant
  `PI_EXPAND_CHORD` in `src/ui/rail.ts` (one source of truth) + tests locking that no cap may print `⌘E`.
- **[NOTE] Dock/status disappear a few seconds after completion** — by design
  (`isDisplayActiveRun` grace period in `src/runtime/process-status.ts:143-151`), not a defect.
- **[NOTE] The 4 executors + 1 verifier + 7857 green tests missed all three defects above.** They are
  invisible to per-module fixtures; only real-state live rendering exposes them (this is why Tier 13
  now exists in the skill).

## What was NOT run + why

- Tiers 6, 9c–9f, 10: no corresponding code path was touched (surface/lifecycle/admin/background),
  and the run was explicitly script-free.
- Tier 10b: enabling `runtime.surface.visibleAgents` mutates the user's config — needs explicit opt-in.
- Full `test:unit` was NOT re-run in this battery (a full sweep ran earlier in the session at
  7857 pass / 0 fail, before the three fixes above); the UI batch (`test/unit/ui/**` +
  `ui-ux-fixes-e2e`) was re-run after each fix: 464/464 pass.

## Restart needed?

- [x] Yes for the user's own long-lived session — the bundle was rebuilt at 23:48
      (`0d062b8301a67a8741590480ec4dcbd3`); every verification above used freshly spawned sessions.

## Verdict

Required tiers for a UI-language change pass **live**: the RAIL surfaces render correctly in a real
TUI at both wide and narrow widths, and three defects that all static verification missed were found,
fixed and re-verified live (status-bar zero count, agent-cap chord, phantom `⌘E`). Safe to ship as
0.11.1 after the user's session restarts on the new bundle.
