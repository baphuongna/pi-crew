# Spike go/no-go — pi-rlm → Node port (pattern 01+04+05+08+09)

> **Kết quả: ✅ GO** — 17/17 test GREEN, spawn subprocess Node thật (không mock, không Bun).
> Ngày: 2026-08-08. Spec: `../../rlm-apply-pi-crew.md` mục 5 + 7.1.

## Mục đích

Chứng minh 8 pattern FLAGSHIP của pi-rlm port sang Node thuần chạy được TRƯỚC khi đầu tư full FLAGSHIP. 2 invariant quyết định:

- **(a) Bindings survive mid-cell failure** (pattern 05): cell 1 `throw` giữa chừng → cell sau vẫn thấy biến đã gán trước throw.
- **(b) Namespace revives across process boundary** (pattern 08+09): engine 1 snapshot → kill → engine 2 (process mới) restore → cell mới đọc được biến.

## Cấu trúc

```
src/runtime/scratchpad/
├── protocol.ts   (88 dòng)  — fd3 + nonce + envelope, port 1:1 từ pi-rlm
├── transform.ts  (363 dòng) — esbuild transformSync (strip) + acorn parse, decl→assignment, trailing-expr→setResult
├── guest.ts      (330 dòng) — namespace proxy + with(SCOPE) + v8.serialize + AsyncLocalStorage, KHÔNG Bun
├── engine.ts     (564 dòng) — EngineManager host, spawn(process.execPath, [--experimental-strip-types, guest.ts])
└── index.ts      (22 dòng)  — barrel

test/runtime/scratchpad/
├── protocol.test.ts        (72 dòng)
├── transform.test.ts       (59 dòng)
└── engine.spike.test.ts    (126 dòng) — 2 invariant + phụ trợ, spawn subprocess thật
```

## Cách chạy

```bash
cd /home/bom/source/my_pi/pi-crew
node scripts/test-runner.mjs --test-force-exit 'test/runtime/scratchpad/**/*.test.ts'
```

## Kết quả

```
# tests 17
# pass 17
# fail 0
```

## Port Node quan trọng (không Bun)

| pi-rlm (Bun) | port Node | xác nhận |
|---|---|---|
| `bun:jsc serialize/deserialize` | `node:v8` serialize/deserialize | ✅ guest.ts:32, snapshot/restore pass invariant (b) |
| `Bun.Transpiler` (DCE off) | `esbuild` transformSync + acorn | ✅ transform.ts, trailing-expr không bị drop |
| `Bun.inspect` | `node:util` inspect | ✅ guest.ts:31 |
| `spawn("bun", ["run", guest])` | `spawn(process.execPath, ["--experimental-strip-types", guest])` | ✅ engine.ts:173 |
| `Bun.$` guard / host bridge | **bỏ** (không cần cho spike) | — |

## Kết luận

**GO** — FLAGSHIP được xanh-light. Bước tiếp: FLAGSHIP Phase 1 (tool `execute` opt-in per role + snapshot vào artifact-store), rồi Phase 2 (crash-resume trong retry loop).

---

# Phase 2 — Crash-Resume (cross-attempt restore)

Phase 2 closes the crash-resume loop: a worker attempt N+1 (retry / crash-recovery
re-queue / manual re-run) automatically revives the namespace from the previous
attempt's snapshot, **without the model knowing** (besides a one-line notice).

## Flow

```
attempt N (scratchpad worker)
└─ execute → EngineManager → guest namespace
└─ flush (debounce / shutdown-quit / post-ok) → writeArtifact REDACTED
   → artifactsRoot/scratchpad/<taskId>.attempt-<i>.snapshot.json
        │  worker dies / fails / cancelled
        ▼
attempt N+1 spawn (prepareSpawnContext — the single choke point)
└─ findLatestScratchpadSnapshot(artifactsRoot, taskId)   ← snapshot-lookup.ts
   └─ latest MTIME wins (model-fallback `i` resets each retry round → number is
      NOT write-order; tie-break: lowest attempt = newest round)
└─ env PI_CREW_SCRATCHPAD_RESTORE (+ RESTORE_MTIME hint)
        ▼
attempt N+1 worker (scratchpad-lifecycle.ts)
└─ FIRST execute call → re-validate at READ time (D10) → restoreState →
   notice "[scratchpad] restored N vars from attempt-K; restored:[...]; failed:[...]"
```

## Env keys (parent → worker, set in `prepareSpawnContext` scratchpad gate)

| Key | Direction | Purpose |
|---|---|---|
| `PI_CREW_SCRATCHPAD` | parent→worker | "1" arms the execute tool (dormant gate) |
| `PI_CREW_TASK_ID` | parent→worker | snapshot relativePath provenance |
| `PI_CREW_ATTEMPT` | parent→worker | model-fallback index (per-attempt suffix) |
| `PI_CREW_ARTIFACTS_ROOT` | parent→worker | writeArtifact root |
| `PI_CREW_SCRATCHPAD_SNAPSHOT` | parent→worker | WRITE target (raw temp, never in artifacts) |
| `PI_CREW_SCRATCHPAD_RESTORE` | parent→worker | **Phase 2**: READ source (redacted artifact) |
| `PI_CREW_SCRATCHPAD_RESTORE_MTIME` | parent→worker | **Phase 2**: swap-detection HINT (forgeable, not authn) |
| `PI_CREW_KIND` / `PI_CREW_PARENT_PID` / `PI_CREW_GUEST` | engine→guest | **Phase 2 (D5)**: guest reports the WORKER pid (not the leader's) so an orphaned guest is flagged by the zombie scanner |

## Guards (D1–D13)

- **D1/D1b'** lookup at spawn, latest mtime, tie-break lowest attempt.
- **D3** restore once per session, lazy on first execute (D7 invariant kept).
- **D4** redacted secret → literal `"***"` placeholder (guest special-case; base64
  of a real value is never `"***"`).
- **D5/MAJOR-S1** production wiring: `getScratchpadEngine` overrides
  `PI_CREW_PARENT_PID=worker pid` (pure inheritance leaves guests LIVE forever).
- **D6** cap 4 MiB two-sided: write-side raw byteLength (trim failed→50 only when
  over cap); read-side file size + guest per-var 256 KiB.
- **D10** restore path re-validated at READ time (TOCTOU): containment +
  filename pattern + lstat regular + size + mtime pin.
- **D11** restore fail-open: any failure logs + continues on an empty namespace.
- **D12** scan strict (lstat/pattern/regular) — cross-agent poisoning is NOT a new
  trust boundary (same-uid team worker already writes artifacts); notice lists
  var names so the model re-verifies.
- **D13** base64 round-trip check before deserialize (flat redaction can inject
  `"***"` into a valid payload → silent corruption → failed[]).

## Threat model (Phase 2 additions — defense-in-depth within the same-uid boundary)

- **v8.deserialize of restore content is unauthenticated** (no HMAC). Bounded by
  the 4 MiB file cap + 256 KiB per-var cap + same-uid artifact dir. A planted
  snapshot with a crafted v8 blob can run deserialize gadgets in the guest — but
  the guest already runs at full worker trust (it holds provider keys + broker
  token), so this does not cross the existing boundary. An HMAC over the payload
  is a Phase 2.5/3 hardening if artifacts ever land in a shared location.
- **Secret-at-rest under a benign key name** persists as base64 for the run's
  retention (structural redaction is key-name based, best-effort). A sanitized-
  namespace policy is a Phase 2.5 concern.
- **Restore-source trust = same as any artifact**: a same-uid team worker can
  plant a matching-named snapshot; restore removes the "model chooses to read"
  step, so the notice deliberately lists the revived var names.

## CI note

The `test/runtime/scratchpad/*` spike tests (incl. the D1/D4/D6/D13 restore pins)
are NOT wired into `npm run test:unit` (which globs `test/unit/**`). Run them
directly per the Phase runbook: `node scripts/test-runner.mjs --test-force-exit
test/runtime/scratchpad/restore-e2e.spike.test.ts`.
