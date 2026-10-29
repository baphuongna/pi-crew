# SEC-2026-11 — Remediation 30 finding bảo mật từ audit độc lập run-1

- **Lane:** high-risk — hard gate: state mutation + concurrency + child process + external tool + security boundary (gần như mọi flag trong FEATURE_INTAKE checklist)
- **Status:** in_progress — phê duyệt của người đã có (chủ repo: "start fix all", 2026-11)
- **Nguồn (source of truth cho từng finding):**
  - Báo cáo audit: `/home/bom/security-audit-skill/pi-crew/run-1/REPORT.md`
  - Chi tiết reproduction + remediation: `.../FINDINGS-DETAIL.md`, `.../findings.json` (30 record `verdict:"confirmed"`)
  - Fix briefs per wave: `.../fix-briefs/w*.md` (trích strategy + suggested code_changes từ findings.json)
  - Baseline: `pi-crew@0.11.50`, commit `6063f377` (đúng commit audit)
- **Ngày tạo:** 2026-11
- **Phạm vi:** 30 finding confirmed (11 high / 13 medium / 6 low). Loại trừ: 4 needs_validation (chưa phải vuln — theo dõi riêng), 3 rejected.

## 1. Vấn đề (WHY)

Audit độc lập (skill security-audit, full mode, 47 verifier + 34 fresh re-verify, 2 validator PASS) xác nhận 30 lỗ hổng/hardening gap trên 5 cụm:

1. **Authority seams** — check tồn tại 1 lớp nhưng dữ liệu durable hoặc đường dẫn anh em bỏ qua nó (broker bare-token, coordination files không sender-binding, verify-gate memo/worktree grounding, root-gate dryRun/action matrix, api claim).
2. **Worker-writable state làm execution authority** (dwf-checkpoint replay forged verdicts, user-tier workflow planting thực thi trong host process).
3. **Boundary knob settable bởi tier thấp hoặc bị bypass tĩnh** (embeddedWorkers routing vào in-process bỏ sandbox+scrub, sandbox --skill walk bind $HOME, project frontmatter tools mở rộng role floor).
4. **Resource control chết hoặc disarm được** (inference-broker inFlight không tăng, resume tắt budget/deadline + skip maxTasks admission).
5. **Low-trust text chạm terminal/LLM context thiếu sanitize** (tool-renderers OSC-52, theme gallery, imports listing, inbox metadata fence escape).

## 2. Nguyên tắc remediation (design.md tóm tắt)

- **Fail closed** tại mọi brokered spawn thiếu task identity; retire bare-runId token.
- **Authority phải có bằng chứng mật mã**: coordination rows ký bởi broker/parent (key không bao giờ phát cho child), consumer verify, row không hợp lệ = noise.
- **Knob routing nhạy cảm → user-only** (nhất quán với runtime.mode/isolationPolicy/preferLiveExecution đã sensitive).
- **Floor không thể mở rộng**: frontmatter/config tier thấp chỉ được *thu hẹp*, không bao giờ *mở rộng* vượt role tier — KHÔNG đảo D5 (full-parity toolset vẫn default; chỉ thêm read_only floor + phát emission từ resolved policy).
- **Grounding đúng phạm vi**: verify-gate phải chấm đúng công việc của task (không chỉ git index/HEAD tree); memo key phải khớp phạm vi nó bào chữa cho.
- **Sanitize tại biên render** cho mọi field attacker-influenced (mirror pattern `sanitizeUntrustedLine`/`fencePeerMessage` đã có).
- Giữ kill switch/env knob pattern sẵn có; không phá API công khai; không đổi format state mà không có fallback đọc.

## 3. Phân wave (ownership theo file, không chồng lấn)

| Wave | Findings | Files sở hữu |
|---|---|---|
| w1a | broker-bare-run-token, coordination-durable-files, inbox-render | src/runtime/broker/**, src/state/coordination/mailbox.ts, src/prompt/prompt-runtime.ts, src/extension/registration/lifecycle-handlers.ts |
| w1b | gatherreplies, api.claim-task | src/runtime/goal-workflow/dynamic-workflow-context.ts, src/extension/team-tool/api/task-claims.ts |
| w2 | verify-gate ×3 | src/runtime/verification/**, src/runtime/task-runner.ts (vùng verify gate) |
| w3 | discover-workflows.user-tier, dwf-checkpoint | src/runtime/task-runner/pre-execution.ts, src/runtime/goal-workflow/dynamic-workflow-runner.ts, src/runtime/dwf-state-store.ts, src/state/types.ts |
| w4a | inference-broker-inflight, sandbox-home-overshoot | src/runtime/child-pi/inference-broker.ts, src/runtime/child-pi/sandbox.ts |
| w4b | embeddedWorkers, toolpolicy floor | src/schema/config-schema.ts, src/config/sanitize-project-config.ts, src/agents/agent-config.ts, src/runtime/model/pi-args.ts |
| w5a | rootgate dryRun + action matrix | src/extension/team-tool/destructive-gate.ts, src/extension/management.ts |
| w5b | resume budget/maxtasks, adoptSpecialKind | src/extension/team-tool.ts, src/runtime/team-runner.ts, src/extension/team-tool/run-deadline.ts, src/state/stores/state-store.ts |
| w6 | seedpaths symlink, workspace-lock, locks dual-holder | src/worktree/worktree-manager.ts, src/runtime/workspace-lock.ts, src/state/coordination/locks.ts |
| w7a | theme-render, transcript-escape, tool-renderers | src/ui/theme-discovery.ts, src/ui/settings-overlay.ts, src/utils/safe-terminal-text.ts, src/ui/inline-panel/agent-transcript.ts, src/ui/tool-renderers/**, src/extension/team-tool/inspect.ts |
| w7b | otlp ssrf + userinfo, imported-manifest render | src/observability/exporters/otlp-exporter.ts, src/extension/run-import.ts, src/extension/team-tool/lifecycle-actions.ts |
| w8 | battery quoting, ci glob | scripts/pre-publish-battery.mjs, .github/workflows/ci.yml |

## 4. Validation

Per-wave: `npm run typecheck` + test files mới/sửa chạy riêng. Sau mỗi batch: typecheck toàn repo. Cuối: `npm test` đầy đủ. Mọi finding phải có regression test chứng minh fix (mirror PoC trong FINDINGS-DETAIL.md ở mức unit/integration — không live-probe).

## 5. Rollback

Mỗi wave commit riêng trên main; revert chọn lọc theo commit được ghi trong exec-plan.
