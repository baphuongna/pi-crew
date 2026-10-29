# SEC-2026-11 — Design

Nguyên tắc đầy đủ trong overview.md §2. Quyết định thiết kế chính theo wave:

## w1a — Broker authority
1. **Bare-token retirement**: spawn không có task identity không nhận bare per-run token; `wait.resolve` bắt buộc compound token (đối xứng với claim). Bare token ngừng mint hoàn toàn (preferred).
2. **Coordination binding**: mailbox row + steering line do broker/parent viết được **ký Ed25519** (keypair per-run, private ở parent/broker; child chỉ nhận public verify key qua stdin handshake). Consumer (`pollWorkerInbox`, `pollSteering`, `readMailbox`, resume replay) reject row không MAC hợp lệ = noise. Steering TOCTOU: re-validate per tick / fstat dev+ino + O_NOFOLLOW.
   - Backward-compat: row cũ không chữ ký chỉ được chấp nhận khi đọc ở chế độ `legacy` (resume state trước nâng cấp) — ghi warning; row mới thiếu chữ ký bị drop.
3. **Inbox render**: neutralize control chars + `</inbox-message` cho mọi field nội suy (from/to/requestId), mirror `fencePeerMessage`.

## w2 — Verify-gate grounding
- Gate phải đánh giá **đúng cây công việc**: worktree state (git status --porcelain + diff của worktree task) chứ không chỉ HEAD tree; memo key thêm worktree identity (path + worktree HEAD + index hash) để không còn key-mismatch; nonmanifest ground-truth không tự chấm từ chính output nó xác nhận — cần source-of-truth độc lập (file/tree check).

## w3 — DWF trust
- User-tier discovery chỉ chạy script host-process nếu file nằm trong đường dẫn chỉ user config ghi được (~/.pi/agent/) VÀ pass ownership check; project workspace planted file → không bao giờ `runtime:'dynamic'` từ user tier. Checkpoint hydration validate schema + verdict allowlist; forged verdict `ok:true` bị loại.

## w4a — Child-pi
- inFlight increment/decrement quanh forward (try/finally), gate `>= cap` hoạt động thật.
- Sandbox bind: walk skill dirs nhưng chỉ bind những thư mục skill thực tế (leaf dirs), không bind $HOME gốc; hoặc bind với `--dir` read-only từng skill file.

## w4b — Config/tool policy
- `runtime.embeddedWorkers` → sensitive (user-only); embedded path fail closed khi PI_CREW_SANDBOX=bwrap bật.
- resolveToolPolicy: read_only floor (bash/edit/write luôn exclude cho role read_only bất kể source/frontmatter); pi-args emit từ resolved policy.

## w5 — Root gate + resume
- dryRun carrier đi qua cùng matrix mutating như execution (preview cũng qua root gate cho action nhạy cảm); bổ sung delete/cleanup/init vào R11-S1 matrix.
- Resume: kế thừa budget/deadline từ manifest gốc (không reset vô hạn), maxTasks admission áp cho dispatch batch resume; adoptSpecialKind path re-check lock liveness như path thường.

## w6/w7/w8 — Nzọ nhỏ theo brief: symlink ancestor check trước cpSync; lock refresh không clobber holder mới (verify token trước write + re-check steal); dual-holder refactor rm thành rename-then-rm; render sanitize OSC/CSI/control chars; otlp redirect:"manual" + không log userinfo; run-import render qua sanitize; battery script quote-safe path matching; ci.yml glob khớp đúng artifact.

## Compatibility
- Không đổi wire format schema tool; thêm field optional có validation.
- State: thêm field signing/ký hiệu mới = optional, đọc cũ vẫn hoạt động (legacy warn).
