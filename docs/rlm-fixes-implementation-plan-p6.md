# P6 Design — Scratchpad stack-trace sourcemap (2026-08-12)

> Grounded in empirical probes (esbuild/acorn behavior) — NOT assumptions.

## Background / bug (§2.4 of deep review)

A scratchpad cell error stack shows transformed line numbers, not the original
cell source:
```
at Proxy.deep (eval at runCell (file:///.../guest.ts:260:19), <anonymous>:4:9)
at eval (eval at runCell (file:///.../guest.ts:260:19), <anonymous>:6:55)
```
`4:9` / `6:55` are relative to the TRANSFORMED body, not the cell the model
wrote. esbuild supports `sourcemap: true` but transform.ts doesn't enable it.

## Why NOT the naive single-layer (esbuild) approach — probe findings

| # | Claim tested | Result | Consequence |
|---|---|---|---|
| G1 | esbuild strip-types preserves line count | **REFUTED** — 7→5 lines (type annotations + multi-line signatures collapse) | Even a correct esbuild sourcemap maps to `rewritten`, which is already line-shifted from source by acorn's import pre-rewrite. Single-layer = wrong lines. |
| G2 | import pre-rewrite preserves lines | **REFUTED** — multi-line import collapses to 1-line replacement | The import pre-rewrite (acorn) shifts all subsequent lines. Any mapping must account for BOTH transforms. |
| G3 | column mapping needed vs line-only | acorn locations available | Line-based is the correct fidelity for this bug (model reads line numbers). Column is overkill for MINOR severity. |
| G4 | acorn `locations:true` provides node positions | **CONFIRMED** (start/end line+col) | We can build a position map WITHOUT a source-map dependency. |
| G5 | source-map lib available | **REFUTED** — no `source-map` / `@jridgewell/trace-mapping`; pi-crew uses none | No VLQ decoder dependency; we build our own line-map from acorn. |

## Selected approach (FINAL): 3-layer line map, esbuild sourcemap + VLQ decoder + tracking

Probes changed the design:
- G1: esbuild strip-types does NOT preserve lines (7→5) → **must use esbuild's own inline sourcemap**, not naive line identity.
- G5: no `source-map`/`trace-mapping` lib → **write a small VLQ decoder** (~40 lines, standard base64 VLQ).
- G4: acorn `locations` available → build body↔js tracking during splice.

Pipeline: `body (V8 error) → js → rewritten → code (model's source)`
1. **body → js**: track `bodyLine`↔`jsLine` during splice (replacements add/remove lines; use newline counts + acorn `locations`).
2. **js → rewritten**: esbuild `sourcemap: 'inline'` → decode VLQ to get, per js (generated) line, the source (rewritten) line.
3. **rewritten → code**: import pre-rewrite (multi-line import collapses to 1 line) → track `jsCursor` offsets; lines outside imports are identity-shifted.

Compose: `bodyLine → jsLine → rewrittenLine → codeLine`.

## Complexity & risk (honest)
- **effort:** ~1 day (report's 0.5 was optimistic; naive flip would be WRONG).
- **risk:** MEDIUM — VLQ decoder + compose bookkeeping; a bug gives wrong (but cosmetic) line numbers. Guard with tests.
- **not doing:** column mapping (overkill), remapping all frames (only the top cell frame).

## Tests

- `transformCell` returns correct `lineMap` for: no-import/no-type (identity),
  multi-line import, multi-line type annotation, function decl, trailing
  expression capture.
- `runCell` error: inject a cell that throws on a known line; assert the
  remapped stack line equals the source line the model wrote.

## Gate

- typecheck + scratchpad test subset pass.
- P6 does NOT block P1/P2/P3/P4/P5 (independent).
