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
