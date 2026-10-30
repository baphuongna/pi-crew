# SEC-2026-11 — Validation evidence

Quy ước chung: mọi test chạy riêng lẻ qua `node --experimental-strip-types --no-warnings --test <file>` với env `PI_CREW_*`/`PI_TEAMS_*` đã scrub (gotcha worker-env của repo); typecheck = `npm run typecheck`; mỗi fix có mutation-check hoặc regression test mirror PoC audit.

## Per-wave (11/12 hoàn tất — w1a đang validation cuối)

| Wave | Findings | Tests mới | Suites liên quan | Kết quả |
|---|---|---|---|---|
| w2-verifygate | verify-gate ×3 (HIGH) | 19 (verify-gate-worktree-integrity 18 + task-runner-verify-gate +1) | 80/80 trên 7 files | typecheck PASS, biome clean |
| w3-dwf-trust | user-tier trust + checkpoint (HIGH/MED) | 45 (dwf-state-store 25, runner-trust 8, prestep-guard 12) | +7 neighbor files 40/40 | typecheck PASS, env-var/event-type gates OK |
| w4a-childpi | inference inFlight + sandbox HOME (HIGH×2) | 9 (broker-cap 4, sandbox 5) | inference-broker 22/22, sandbox 9/9 | typecheck PASS |
| w4b-config | embeddedWorkers + tool floor (HIGH/MED) | 15+7 adjusted (>450 assertions) | 27+ suites xanh (embedded-drop 9/9, pi-args-loadout 18/18…) | typecheck PASS |
| w1b-binding | gatherReplies + api.claim (MED/LOW) | 17 (gather 8, claim 9) | 123 tests trên 6 suites | typecheck PASS |
| w5a-rootgate | dryRun exemption + action matrix (HIGH/MED) | 15 (root-gate-w5a) | 91/91 (37+11+34+8+1) | typecheck PASS |
| w5b-resume | budget/maxTasks/liveness (MED×2, LOW) | 9 (4 files) | 47 tests liên quan xanh | typecheck PASS (trừ 2 lỗi mailbox của w1a — đã được w1a tự sửa) |
| w6-locks-worktree | seedpaths + workspace-lock + locks (HIGH/MED/LOW) | 12 (3 files) | 98+46+25+18+26 = 213/213 | typecheck PASS; mutation-check 3/3 fix |
| w7a-render | theme/transcript/tool-renderers (MED×2, LOW) | 27 (5 files) | 85/85 + 46/46 + 77/77 | typecheck PASS, biome clean |
| w7b-otlp-import | otlp ssrf/userinfo + import render (MED/LOW/LOW) | 16 (12 otlp + 4 import) | 91/91 trên 11 suites | typecheck PASS, check-lazy-imports 0 |
| w8-ci | battery quoting + ci glob (MED/LOW) | 12 (battery-changed-paths) | 21/0 (+ sandbox sim bước CI) | typecheck PASS, YAML/bash -n OK |

## Parent-side wirings (2 deferred của batch A)

1. **Fail-closed sandbox gate → `planEmbeddedTier`** (hybrid-tier.ts): embedded routing bị REFUSE khi `PI_CREW_SANDBOX` bật (tier.decision warning, reason "sandbox-opt-in", task ở lại subprocess tier có bwrap). Tests: hybrid-tier 19/19.
2. **`dynamicScriptPin` stamp tại dispatch** (dynamic-workflow-runner.ts): điểm nhập đầu runner = dispatch → stamp {scriptPath, sha256(current bytes)} + persist TRƯỚC module load; mọi entry sau (resume) verify pin-mismatch fail-closed. Single-point stamping dùng đúng `resolveScriptPath` → không drift path. Tests: dynamic-workflow-runner-trust + dwf-state-store 33/33.

## Wired-later gaps đã đóng bởi các wave khác
- w5b tự đóng sampler-child `error` listener (B6 mirror) — deadline abort-after-exit từng crash host (pre-existing, chứng minh 5/5 trên HEAD).

## w1a (hoàn tất bởi leader sau takeover)
- Executor gốc + attempt-2 (pi-crew run nội bộ) bị ngắt sau ~55 phút validation; leader takeover: kiểm toán diff
  (515 dòng/6 src + 4 test mới), sửa slop no-double-cast (signMailboxMessage spread), route env reads qua
  getCrewEnv, đăng ký PI_CREW_MAILBOX_VERIFY_KEY (env-vars + forwarding decision table), sweep sequential
  41+88+7 PASS. Fix record: fix-records/w1a-broker-coordination.md.
- Bài học: registry C-1 validation throw lúc module-load khi thêm CREW_ENV_VARS entry thiếu forwarding decision —
  gây 211 file crash hàng loạt trong 1 lần full-run giữa chừng (đã fix + thêm snapshot pin).

## Full-suite chạy tươi trên tree đã commit (13 commits e8794132..71df800b + follow-up)
- `npm run test:unit` (concurrency 4): **10394 tests — 10378 pass, 6 fail, 6 cancelled**.
- 6 fail đã đối chiếu TỪNG FILE chạy sequential riêng lẻ: **tất cả PASS** (respond-discriminator 10/10,
  run-foreground-partial-watch 1/1, round24-deadlock 5/5, resume-liveness 6/6, resume-status 2/2,
  role-tools-integration 3/3, events-replay 8/8) + A6 escalate pins 3/3 ⇒ toàn bộ là timing-flake song song
  đã biết (deadline/watch-window/deadlock/escalate dưới tải 4-way; w5b đã ghi nhận cùng class trên HEAD).
- Registry snapshot fail duy nhất có thật (key mới thiếu pin) đã fix + commit.
- Gates: typecheck 0 lỗi; lint exit 0; format exit 0; check-env-vars 0; check-lazy-imports 0 (budget 541→542
  có doc); check-slop-rules clean; check-event-types-registry 0.

## Wave w9 — 4 needs_validation leads + residuals (2026-10-30)

Nhu cầu gốc: 4 leads "needs_validation" của audit KHÔNG phải vuln đã xác nhận, nhưng root cause của cả 4 đều
source-grounded + seam đã sandbox-pin trong audit; w9 đóng các phần deterministic/defensive (phần còn lại của
N2/N3 cần quan sát deployment thật — owner-observed checklist vẫn áp dụng cho xác nhận impact cuối).

| Wave | Lead/Residual | Fix | Tests |
|---|---|---|---|
| N2 (7f325e2e) | parity-spawn mcp-cut version-gated | pi-version probe failure re-arm TTL 60s (success memoize vĩnh viễn); nửa --tools rỗng đã đóng bởi w4b | 3 (mock-timer TTL) + wiring 2/2 |
| N1 (c1c062d1) | mcp-proxy name-denylist | allowlist-shaped post-creation assert trên legacy loader route (typed McpForeignExtensionError + event; fail-closed) | 5/5 + 53 existing |
| N3 (eb206898) | persisted-run-state unvalidated | loader-level: per-entry shape + runId binding + 10k cap; runKind allowlist normalize; non-object fail-closed | 10/10 + ~700 loader suites |
| N4 (ba93ee6d) | verification git unhardened | 16 sites (6+9+1 follow-up) qua hardenGitArgs+buildGitSafeEnv+assertWorktreePointerTrusted; PoC fsmonitor live re-validate trong test | 5/5 + 77 existing |
| r1 (03340c84) | w1b/w7b/w7a deferred | api mutating-op role gates (heartbeat/live-control/mailbox/foreground-interrupt), otlp parse-time userinfo refusal, event.args sanitize | 24 mới (14+7+3) |

Gates sau w9: typecheck 0; lint 0; format 0; env-vars/lazy/slop/event-types xanh (slop giữ baseline 41).
Owner-observed checklist (N1 adapter thật, N2 host pi<1.0.4, N3 single-workspace poison, N4 worker write-gate)
vẫn là bước xác nhận impact cuối — xem NEEDS-VALIDATION.md các mục tương ứng.
