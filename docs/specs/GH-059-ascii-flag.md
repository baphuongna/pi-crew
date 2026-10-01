# GH-059 — analyze-run.mjs `--ascii` mode (glyph-free perf reports)

## Status

done (2026-10-01 — WI-1..WI-5 complete; see Evidence)

## Lane / Priority

normal · P3 (dev-tooling output format; zero runtime impact — script is standalone, see Design §0)

## Source

- GitHub issue [#59](https://github.com/baphuongna/pi-crew/issues/59) — reporter: `yaburan` (Yuriy Abramov), offers a PR.
- Verified repro 2026-09-30 on run `team_20260927150342_8c4ab23a5daaa452`:
  `node scripts/analyze-run.mjs <runId> --crew-root ./.crew` →
  `docs/perf/perf-report-<runId>.md` has **39/122 lines flagged** by the
  reporter's vault-lint ranges, **16 distinct glyphs**: 🔴 🔵 🟡 ⚪ ⚠ ⚡ ✅
  ⏱ 📋 💡 💰 📈 📊 🐌 🚨 + U+FE0F.
- Blast-radius audit (read-only, 2026-09-30): emoji live ONLY in the two md
  renderers (`renderSubagentFile` :987, `renderMarkdown` :1068, literals
  ≥:1007). JSON (:890-948) and CSV (:952) outputs are glyph-free. Sole
  consumer is `test/unit/scripts/analyze-run-audit.test.ts` (numeric asserts
  on JSON only). No CI workflow, `src/` file, or curated doc parses the
  reports or their glyphs. All outputs gitignored (`.gitignore:52-56`).

## Problem

Generated perf reports are full of emoji/dingbats. Markdown vaults with a
no-glyphs lint rule reject every fresh report — the reporter hand-cleans
40+ lines per run before storing. Glyphs also break table alignment in
monospace renderers. Consumers who want ASCII have no opt-in.

## Goals / Non-goals

**Goals**

- Opt-in `--ascii` CLI flag + `PI_CREW_ASCII=1` env fallback.
- ASCII mode covers **both** md outputs: main report
  `docs/perf/perf-report-<runId>.md` AND per-agent drill-downs
  `bench/results/<runId>.agents/<taskId>.md` (issue text misses the latter;
  skipping it leaves the reporter's lint still failing).
- Sequence-aware (VS16) replacement — no stray U+FE0F bytes left behind
  (FE0F is itself inside the lint ranges).
- Semantic markers per issue: `CRITICAL/ERROR/BLOCKED/RETRY/WARN` labels,
  `[SLOW]` slow-phase flag, `[OK]/[FAIL]/[WARN]/(i)/(~)/(!)` status+severity.
- Default (no flag) output byte-identical to today — regression-locked by
  test.

**Non-goals**

- Config key `observability.ascii` — script imports only `node:fs/path/
  readline` (:19-21), no config system; wiring it in is not worth the
  coupling for a dev tool.
- Same treatment for sibling emitters (`scripts/verify-skill.ts` — 11 emoji
  lines; mention as follow-up in issue reply only).
- Changing report language (Vietnamese), structure, thresholds, JSON/CSV.

## Design

### §0 — Standalone constraint (drives everything)

`scripts/analyze-run.mjs` imports nothing from `src/` — flags/env only.

### §1 — Hook: post-process sweep at the 2 write sites

Do NOT edit ~40 emoji literals inside the renderers. Wrap the two md
write-sites (per-agent :970, main :978):

```js
writeFileSync(mdPath, ASCII ? toAscii(md) : md)
```

### §2 — Substitution table (ORDER MATTERS: composite → sequence → glyph → net)

| # | Pattern (regex, global) | Replacement | Sites / rationale |
|---|---|---|---|
| 1 | `🔴🔴 Nghiêm trọng` | `CRITICAL` | sevLabel :1184 — per-glyph would give `(!)(!)` |
| 2 | `🔴 Lỗi` / `🟡 Blocked` / `🟡 Retry` / `⚪ Warning` | `ERROR` / `BLOCKED` / `RETRY` / `WARN` | sevLabel :1184 |
| 3 | `(\d+(?:\.\d+)?ms|\d+(?:\.\d+)?s|\d+m\d+s) 🔴` | `$1 [SLOW]` | slow markers — REFINED during implementation: timeline cells are `${fmtMs()}${flag()}` WITHOUT bold, so anchor on fmtMs duration formats (`626.3s 🔴`), which also covers bottleneck `**626.3s** 🔴` (:1070, :1171) |
| 4 | `🔴 = phase vượt` / `🔴>30s` | `[SLOW] = phase vượt` / `[SLOW]>30s` | legend :1128 + table header :1119 stay consistent with #3 |
| 5 | `⚠️` (U+26A0 **+ U+FE0F**) | `[WARN]` | inline warnings :1013, :1099, :1160, :1211, :1239 — must match FULL sequence |
| 6 | `⏱️` (U+23F1 **+ U+FE0F**) | `` (drop) | decorative heading :1117 |
| 7 | `🔴` / `🟡` / `🔵` / `⚪` | `(!)` / `(~)` / `(~)` / `(i)` | severity icons :1012, :1107, :1108 legend, recs :1290/:1298 |
| 8 | `✅` / `❌` / `✓` | `[OK]` / `[FAIL]` / `[ok]` | status :1007, :1035, :1102, :1153, :1189, :1303 |
| 9 | `📋\|💰\|🐌\|🚨\|📊\|💡\|📈\|⚡\|🔍` | `` (drop) | decorative headings — 🔍 added during implementation: `--events` mode emits an extra `## 🔍 Per-event` heading the original census missed (caught by WI-4 gate, 1 leftover line) |
| 10 | `[\uFE00-\uFE0F\u200D]` | `` (drop) | SAFETY NET — any leftover VS16/ZWJ stays inside lint ranges |
| 11 | per-line `^(#+)[ \t]+` (after empty subs) | `$1 ` | collapse double-space from dropped heading emoji |

### §3 — Flag plumbing

- `parseArgs` (:24-43): `--ascii` → `args.ascii = true`; default
  `args.ascii ||= process.env.PI_CREW_ASCII === "1"`.
- Update BOTH usage strings (:33 `-h`, :40 error).
- Header comment :15: mention `--ascii` mode.

### §4 — Test (extend `test/unit/scripts/analyze-run-audit.test.ts`)

Existing harness already spawns the analyzer on a fixture run and reads
outputs (:272-275). Add:

1. **ascii-clean test**: run with `--ascii`; read main report AND ≥1
   `.agents/<taskId>.md`; assert **zero** matches of the reporter's lint
   ranges `[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}
   \u{2B00}-\u{2BFF}\uFE00-\uFE0F\u200D]` (`u` flag) in BOTH files; assert
   ≥1 ASCII marker present (e.g. `[SLOW]` or a heading like `## Tóm tắt`).
   Fixture must exercise heading emoji + `⚠️`/`✓` at minimum — verify, and
   enrich fixture data if the current one is glyph-poor.
2. **default-unchanged test**: run without flag; assert main report still
   contains emoji (locks current behavior against accidental global sweep).

## Acceptance Criteria

- [x] AC1: `--ascii` parsed; `--help` and usage-error strings document it
- [x] AC2: `PI_CREW_ASCII=1` env enables ascii mode without the flag
- [x] AC3: main report in ascii mode has 0 codepoints in lint ranges
- [x] AC4: per-agent `.agents/<taskId>.md` in ascii mode has 0 codepoints in lint ranges
- [x] AC5: composite labels render `CRITICAL/ERROR/BLOCKED/RETRY/WARN`
- [x] AC6: slow-phase markers render `[SLOW]` in flag (:1070), header (:1119), legend (:1128) consistently
- [x] AC7: default mode output still contains emoji (regression lock)
- [x] AC8: JSON + CSV outputs byte-identical in both modes (ex `generatedAt` timestamp — inherent nondeterminism)
- [x] AC9: full existing `analyze-run-audit.test.ts` suite green
- [x] AC10: no stray U+FE0F/U+200D anywhere in ascii-mode md outputs

## Validation Plan

| Gate | Command | Expectation |
|---|---|---|
| Tests | `node scripts/test-runner.mjs test/unit/scripts/analyze-run-audit.test.ts` | all green incl. 2 new tests |
| Lint | `npm run lint` (if biome covers `scripts/`) | clean |
| Manual repro | `node scripts/analyze-run.mjs team_20260927150342_8c4ab23a5daaa452 --crew-root ./.crew` then `--ascii` variant; python range-grep both outputs | 39 flagged lines → **0**; default unchanged |
| AC8 | diff `bench/results/<runId>.json` between modes | identical |

## Work Items

| ID | Item | Status |
|---|---|---|
| WI-1 | parseArgs `--ascii` + env + usage strings + header comment | DONE |
| WI-2 | `toAscii()` sweep table + wire 2 write-sites | DONE |
| WI-3 | Tests: ascii-clean (both outputs) + default-unchanged | DONE (4 tests) |
| WI-4 | Manual repro evidence → fill Evidence section | DONE |
| WI-5 | CHANGELOG entry (+ specs/README index row) | DONE |

## Evidence

All captured 2026-10-01, `pi-crew` worktree, Node v22.23.1:

- **Tests**: `node scripts/test-runner.mjs test/unit/scripts/analyze-run-audit.test.ts`
  → **32/32 pass** (28 existing + 4 new GH-059 cases: ascii-clean both
  outputs, per-agent `[ok]`/`[FAIL]` markers, default-keeps-emoji,
  `PI_CREW_ASCII=1` env gate). One test-authoring fix en route: fixture
  HAS anomalies (run.cancelled → run_not_completed), so the asserted
  empty-anomaly `[OK]` line never renders — re-asserted against the
  `[WARN]` heading + `(!)/(~)/(i)` legend instead.
- **Lint**: `npx biome check` on both changed code files → clean. Two
  biome corrections during implementation: (a) `matchAll` needs `g` flag;
  (b) `noMisleadingCharacterClass` rejects VS16/ZWJ inside a character
  class — test regex uses alternations.
- **Manual repro** (run `team_20260927150342_8c4ab23a5daaa452`, flags
  `--events --agents`):
  - default: **40 flagged lines** in main report (39 previously measured
    without `--events`; the extra line is the `## 🔍` heading)
  - `--ascii`: main report **0 flagged lines**; 4 per-agent files
    **0 flagged lines**; `[SLOW]` renders consistently in table header
    (`Active work [SLOW]>30s`), cells (`5m4s [SLOW]`), and legend
    (`([SLOW] = phase vượt 30s — điểm chậm)`)
  - AC8: `bench/results/<runId>.json` deep-equal across modes after
    removing `generatedAt` (timestamp is inherent nondeterminism)
  - Sweep found during WI-4: first `--ascii` run left 1 flagged line —
  `## 🔍` (U+1F50D) exists only under `--events`; enumerated ALL
  non-Vietnamese codepoints in the script (23 distinct) to confirm no
  other gaps; `→ ≠ ≥ ≫` (U+21xx/22xx) are OUTSIDE the reporter's lint
  ranges and stay.
- Changed files: `scripts/analyze-run.mjs`,
  `test/unit/scripts/analyze-run-audit.test.ts`, `CHANGELOG.md`,
  `docs/specs/README.md`, this spec. Outputs from the repro were deleted
  (gitignored anyway).

## Notes

- Reporter's repro path in the issue (`docs/perf-report-<runId>.md`) is
  stale — actual output since 2026-09-29 is `docs/perf/perf-report-<runId>.md`
  (`.gitignore:49-53`, CHANGELOG :40). Mention when replying.
- `bench/microbench/README.md:7` documents the legacy path (pre-existing
  staleness, out of scope).
- Issue reply after merge: invite the reporter's PR or point at ours; note
  the per-agent drill-down coverage + VS16 handling as additions beyond
  their local patch.
