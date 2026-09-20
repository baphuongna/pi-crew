# RR-010 — Hợp đồng snapshot/cleanup worktree (F01)

- **Lane:** high-risk — hard gate: destructive worktree path + external tool execution (`git`)
- **Status:** planned — **chưa triển khai**, cần phê duyệt của người (xem §8)
- **Finding:** F01 (review 2026-09-17, mức Cao) — **VERIFIED (mạnh hơn mô tả gốc)**
- **Nguồn:**
  - `docs/superpowers/plans/2026-09-17-review-remediation.md` §2.3, §2.4, §5 (RR-010)
  - `docs/archive/2026-09-17-pi-crew-review.md` §3 F01
  - `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01, §8.3
  - `docs/FEATURE_INTAKE.md` (Lanes → High-Risk; Risk Checklist; Classification)
  - `AGENTS.md:40` — luật đã có: "Worktree cleanup must preserve dirty worktrees unless `force` is explicitly set."
- **Ngày tạo:** 2026-09-17
- **Baseline:** `pi-crew@0.11.1`, commit `0b9fa771`
- **Số dòng:** lấy nguyên từ review + báo cáo xác minh tại commit `0b9fa771`
  (`src/worktree/worktree-manager.ts:686,696-703,727,855-863,1015-1023`). Khi source
  trôi, dùng tên hàm thay vì số dòng.

## 1. Vấn đề (WHY)

Task worktree bị tái sử dụng khi còn dirty (untracked file, tracked diff). Trước khi
xoá sạch để chạy lại, pi-crew ghi một "recovery snapshot" vào artifacts rồi mới
`git checkout -- .` + `git clean -fd`. Hợp đồng ngầm của luồng này là: *snapshot
thành công = dữ liệu cũ đã được sao lưu đầy đủ*.

Hợp đồng đó sai. `snapshotDirtyWorktree()` trả `boolean`, và chỉ trả `false` khi
`writeArtifact` ném lỗi. Mọi dạng mất mát khác — file bị cắt ở 256 KiB, entry
không đọc được, diff tracked lỗi — **không** làm snapshot thất bại, nên worktree
vẫn bị xoá. Đây không chỉ là "thiếu sót chưa xử lý": nó vi phạm luật đã ban hành
tại `AGENTS.md:40`.

Hệ quả là mất dữ liệu không thể phục hồi, và theo chiều ngược lại là một luật
an toàn đang tồn tại trên giấy nhưng không có hiệu lực thi hành.

## 2. Bằng chứng xác minh (đã có, không cần dựng lại)

Nguồn: `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01 (probe dùng
hàm thật `prepareTaskWorkspaceAsync` + `strace`, chạy trong `/tmp`, đã xoá).

| # | Probe | Quan sát |
|---|---|---|
| P1 | untracked file 307200 byte, gọi lại `prepareTaskWorkspaceAsync` | `first.reused = false`; `dirtyStatus = "?? big-untracked.bin\n"`; `second.reused = true`; **file gốc không còn**; artifact ghi `## Untracked file: big-untracked.bin (truncated: 307200 → 262144 bytes)` |
| P2 | file `chmod 000` (`secret.txt`, nội dung 111 byte) | `snapshotDirtyWorktree` trả `true`; artifact **không hề nhắc tới `secret.txt`** → mất **hoàn toàn**, không phải chỉ mất phần đuôi >256 KiB |

P2 là điểm làm F01 nặng hơn mô tả gốc: giới hạn 256 KiB không phải biên duy nhất
của mất mát. Bất kỳ entry nào rơi vào nhánh `continue` (không stat/không đọc được)
đều biến mất khỏi artifact *và* khỏi worktree.

## 3. Risk flags (`docs/FEATURE_INTAKE.md` → Risk Checklist)

| Risk flag | Áp dụng | Vì sao |
|---|:-:|---|
| State mutation | ● | ghi artifact recovery; quyết định xoá nội dung worktree |
| Concurrency | | không có shared mutable state trong path này |
| Child process | ● | worktree dùng cho task chạy child Pi worker |
| Error handling | ● | `catch` hiện tại biến lỗi thành "thành công" |
| External tools | ● | `git diff`, `git checkout -- .`, `git clean -fd` |
| API contract | | không đổi tool API của `team` |
| Platform | | `chmod 000` không kiểm thử được trên Windows (xem AC3) |
| Backward compat | | đổi kiểu trả về của hàm export `snapshotDirtyWorktree` |
| Dependencies | | không thêm gói |
| Security | ● | thao tác xoá dữ liệu không thể phục hồi; ranh giới tin cậy của "backup đủ" |

**Kết luận phân loại:** 5 cờ khớp bảng risk checklist của plan §2.3 (State mutation,
Child process, Error handling, External tools, Security) + hard gate "External tool
execution" và "Removing or weakening error handling" → **high-risk**.

## 4. Affected modules

| Module | File | Vai trò |
|---|---|---|
| Worktree | `src/worktree/worktree-manager.ts` | `snapshotDirtyWorktree` + hai cổng cleanup (sync/async) |
| State (đọc) | `src/state/stores/artifact-store.ts` | `writeArtifact` — nơi ghi snapshot (không đổi định dạng) |
| Tests | `test/integration/worktree-snapshot-dirs-binary.test.ts`, `test/unit/worktree/worktree-async.test.ts` | test hiện có phải cập nhật theo contract mới |
| Docs | `docs/TEST_MATRIX.md`, `docs/decisions/` | harness delta (§8) |

## 5. Acceptance criteria

Mỗi AC phải khẳng định được bằng một test cụ thể (tên file nêu ở `exec-plan.md`).

1. **AC1 — Bất biến "backup không đầy đủ ⇒ bytes gốc còn nguyên".** Với một file
   untracked lớn hơn cap (307200 byte) trong worktree tái sử dụng, sau lần gọi
   `prepareTaskWorkspaceAsync` (và bản sync `prepareTaskWorkspace`) file đó **vẫn
   tồn tại** với nội dung nguyên vẹn, trừ khi caller truyền `force` tường minh.
2. **AC2 — Không còn `boolean` làm tín hiệu duy nhất.** `snapshotDirtyWorktree`
   trả một kết quả có cấu trúc nêu được: thành công/không, danh sách entry bị cắt,
   danh sách entry bị bỏ qua, và lỗi diff (nếu có). Test assert được từng trường
   (ví dụ file 307200 byte ⇒ danh sách truncated chứa tên file đó; file `chmod 000`
   ⇒ danh sách skipped chứa tên file đó).
3. **AC3 — Entry không đọc được không được phép dẫn tới xoá.** Với file `chmod 000`
   (self-skip trên `win32`), snapshot phải **không** trả trạng thái đầy đủ; worktree
   giữ nguyên; artifact vẫn được ghi và **có nhắc tên file** kèm lý do bỏ qua.
4. **AC4 — Truncation một file đơn lẻ không đủ để cho phép xoá.** Cùng input như
   AC1, quyết định "cho phép dọn" phải là `false`. Hàm quyết định là hàm thuần
   (nhận kết quả snapshot + `force`) để test được mà không cần chạy git thật.
5. **AC5 — `readFileSync` không đọc quá cap (allocation bound).** Snapshot một file
   untracked lớn (fixture sparse ≥ 64 MiB) không làm tiến trình cấp phát theo kích
   thước file. Hai cách assert, ưu tiên cách tất định: (a) tách helper đọc file và
   assert số byte đọc tối đa ≤ `MAX_FILE_BYTES + 1`, hoặc (b) đo `rssDelta` với
   ngưỡng rộng (`< 64 MiB`, chỉ Linux/macOS). Lý do cần AC riêng: `readFileSync`
   hiện đọc **toàn bộ** file rồi mới cắt, nên cap không bảo vệ khỏi allocation lớn
   (review §3 F01 nêu đúng điểm này).
6. **AC6 — Diff tracked lỗi cũng là "không đầy đủ".** `catch { trackedDiff = "" }`
   hiện tại không phân biệt "không có thay đổi tracked" với "không lấy được diff";
   sau fix, trường hợp lỗi diff phải dẫn tới cùng nhánh bảo toàn như AC1. Test ở
   mức hàm quyết định (AC4) + một test bơm lỗi diff qua seam của helper.
7. **AC7 — Có lối thoát `force` tường minh, và nó phải quan sát được.** Khi `force`
   được set, cleanup vẫn chạy dù snapshot không đầy đủ, **và** có log
   (`logInternalError`) nêu rõ lý do. Khi `force` không được set, không nhánh nào
   xoá dữ liệu. (Story này **không** thêm event type mới — chỉ đổi nội dung message
   của log đã có — nên không phải đăng ký `TEAM_EVENT_TYPES`.)
8. **AC8 — Cả hai nhánh sync và async.** Mọi AC ở trên được kiểm tra cho
   `prepareTaskWorkspace` **và** `prepareTaskWorkspaceAsync` (review yêu cầu tường
   minh "chạy cả sync và async reuse").
9. **AC9 — Không hồi quy hành vi hợp lệ.** File untracked nhỏ hơn cap, file binary,
   file trong untracked directory, và tên file non-ASCII vẫn được sao lưu đầy đủ và
   vẫn cho phép dọn worktree (các assert ST-1/ST-1b hiện có, cập nhật theo contract
   mới, phải còn pass).
10. **AC10 — Artifact không được dùng làm bằng chứng "đã sao lưu đầy đủ".** Việc
    ghi artifact thành công không được là điều kiện đủ để xoá; test AC1/AC3 phải
    chứng minh điều này (artifact tồn tại *và* file gốc còn nguyên).

## 6. Out of scope

- Không đổi định dạng artifact markdown hiện có (`worktree-recovery/<taskId>-<ts>.md`).
- Không sửa `cleanupAgentWorktree` / `cleanupCreatedWorktree` / `git worktree remove`
  (đường dọn worktree đã tạo, không phải đường tái sử dụng).
- Không sửa F03 (cwd delegation) dù cùng chạm `worktree-manager.ts` — thuộc RR-012.
- Không thêm UI xác nhận tương tác; `force` là tham số lập trình.
- Không đổi semantics `force` của management deletes (`team cleanup force=true`).
- Không xử lý trường hợp người dùng tự chạy `git clean` bên ngoài pi-crew.

## 7. Dependencies

- **Không phụ thuộc story nào** (Đợt 1 theo plan §2.4). RR-014 (F15) phụ thuộc RR-011,
  không phụ thuộc RR-010.
- Thứ tự triển khai khuyến nghị của plan §6 đặt RR-010 sau RR-013 và RR-015 (CI
  false-green phải sửa trước để tin được kết quả test của story khác).
- Phụ thuộc môi trường: cần `git` trong PATH cho test integration (đã có tiền lệ
  self-skip: `hasGit()` trong `test/integration/worktree-snapshot-dirs-binary.test.ts`).

## 8. Cổng phê duyệt và harness delta

`docs/FEATURE_INTAKE.md` → High-Risk: "Ask human confirmation before implementation".
Story này **chưa được triển khai**; rủi ro chính là xoá dữ liệu worktree không thể
phục hồi (plan §6).

Harness delta dự kiến khi triển khai:

| Artifact | Thay đổi |
|---|---|
| `docs/decisions/` | Decision record mới (stub ở `design.md` §8) |
| `docs/decisions/README.md` | Thêm hàng vào index |
| `docs/TEST_MATRIX.md` | Thêm hàng RR-010 (planned → implemented) |
| `docs/stories/README.md` | Thêm RR-010 vào bảng Active |
| `docs/product/` | **Không có file nào** mô tả worktree hôm nay (`docs/product/README.md` liệt kê `worktree.md` nhưng file không tồn tại — chỉ có `platform.md`, `runtime-safety.md`, `team-run.md`, `team-tool.md`). Chọn một: (a) tạo `docs/product/worktree.md`, hoặc (b) ghi hợp đồng vào `docs/product/runtime-safety.md` §State Integrity. Chốt lúc implement; ghi lựa chọn vào decision record. |

## 9. Tham chiếu

- Design chi tiết: `docs/stories/RR-010/design.md`
- Exec plan: `docs/stories/RR-010/exec-plan.md`
- Validation: `docs/stories/RR-010/validation.md`
- Luật liên quan: `AGENTS.md:40`
- Tiền lệ high-risk: `docs/decisions/2026-08-17-governed-nesting.md`
