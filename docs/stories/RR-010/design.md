# RR-010 — Design: hợp đồng snapshot/cleanup worktree (F01)

- **Lane:** high-risk
- **Status:** planned (design đề xuất — chưa triển khai)
- **Nguồn số dòng:** `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01
  (xác minh tại commit `0b9fa771`). Số dòng lấy nguyên từ báo cáo xác minh; khi
  source trôi, dùng tên hàm thay vì số dòng.

## 1. Khiếm khuyết chính xác

### 1.1 Cap và nhánh truncation — `src/worktree/worktree-manager.ts:686-703`

```ts
686: const MAX_FILE_BYTES = 256 * 1024;
696: const buf = fs.readFileSync(abs);          // đọc TOÀN BỘ file trước
700: if (originalSize > MAX_FILE_BYTES) {
701:   data = buf.subarray(0, MAX_FILE_BYTES);   // cắt SAU khi đọc
702:   note = ` (truncated: ${originalSize} → ${MAX_FILE_BYTES} bytes)`;
```

Hai điều cùng nằm ở đây:

- **Cắt là im lặng.** `note` chỉ là văn bản trong artifact; nó không ảnh hưởng
  giá trị trả về. Hàm vẫn đi tiếp tới `return true`.
- **Cap không chặn allocation.** `readFileSync(abs)` đọc trọn file vào RAM trước
  khi `subarray` cắt. Với file 2 GiB, tiến trình vẫn cấp phát 2 GiB. Comment
  `// ST-1: per-file byte cap — skip/truncate larger files with a note to avoid OOM`
  mô tả một bảo đảm mà mã không thực hiện (review §3 F01 nêu đúng: "`readFileSync()`
  đọc cả file trước khi cắt, nên cap hiện tại không bảo vệ khỏi allocation lớn").

### 1.2 `return true` là lối thoát thành công duy nhất — `:727`, `:734`

```ts
727: return true;      // sau writeArtifact — lối thoát thành công DUY NHẤT
```

```ts
734: return false;     // chỉ trong catch NGOÀI (lỗi của writeArtifact)
```

Hai dòng này không liền kề: `727` kết thúc khối `try`, `734` nằm trong `catch`
ngoài của cùng hàm.

`false` chỉ xuất hiện khi `writeArtifact` ném. Mọi đường "không sao lưu được đầy
đủ" khác đều kết thúc ở `727` với `true`.

### 1.3 Diff tracked lỗi bị bỏ qua — `:676-681`

```ts
676: let trackedDiff = "";
677: try { trackedDiff = git(worktreePath, ["diff", "HEAD", "--binary"]); }
679: catch { trackedDiff = ""; }
```

`""` là giá trị hợp lệ cho "không có thay đổi tracked". Nhánh `catch` tạo ra
**cùng** giá trị đó cho "không lấy được diff" — hai tình huống khác nhau về bảo
toàn dữ liệu nhưng không phân biệt được ở downstream. Snapshot thiếu diff tracked
mà vẫn trả `true` nghĩa là mọi thay đổi trên file đã tracked (không nằm trong
`git diff` vì lỗi) sẽ bị `checkout -- .` xoá mà không có bản sao.

### 1.4 Entry không đọc được bị bỏ qua — `:716-718`

```ts
716: } catch {
717:   /* skip unreadable/unstat-able entry */
718: }
```

`continue` sang entry kế tiếp, vòng lặp kết thúc bình thường, hàm trả `true`.
Đây là cơ chế đứng sau probe P2: file `chmod 000` (`secret.txt`, 111 byte)
**không xuất hiện trong artifact** và **bị `clean -fd` xoá**.

### 1.5 Cổng cleanup dùng đúng giá trị đó

Sync — `:855-863`:

```ts
855: const snapshotOk = snapshotDirtyWorktree(manifest, task, worktreePath, dirtyStatus);
856: if (snapshotOk) {
862:   git(worktreePath, ["checkout", "--", "."]);
863:   git(worktreePath, ["clean", "-fd"]);
```

Async — `:1015-1023`, cấu trúc giống hệt với `await gitAsync(...)`.

Nhánh `else` đã tồn tại và **đúng** (`worktree.reused.dirtyPreserved`: "Snapshot
failed — preserving dirty worktree ... skipping git checkout/clean to prevent data
loss"). Vấn đề không phải thiếu nhánh bảo toàn, mà là `snapshotOk` gần như luôn
`true`.

### 1.6 Vi phạm luật đã ban hành

`AGENTS.md:40`:

> Worktree cleanup must preserve dirty worktrees unless `force` is explicitly set.

Luồng reuse hiện tại xoá dirty worktree mà không có `force` nào được set và không
có cổng phê duyệt nào — nó chỉ dựa vào `snapshotOk`. F01 vì vậy là vi phạm một
luật đang có, không phải một khoảng trống chưa ai nghĩ tới.

## 2. Vì sao các guard hiện tại không chặn được

| Guard hiện có | Vì sao không đủ |
|---|---|
| `if (snapshotOk)` | `snapshotOk` chỉ phản ánh "writeArtifact không ném", không phản ánh độ đầy đủ của nội dung |
| `note` truncation trong artifact | Chỉ là metadata văn bản; không tham gia quyết định |
| `catch` ngoài → `false` | Chỉ bắt lỗi của `writeArtifact`, không bắt lỗi của từng entry |
| `try/catch` quanh từng entry | Cố ý nuốt lỗi để "không chặn luồng reuse" (comment `:717`) — tức chọn availability thay vì integrity |
| `dirtyStatus` từ `git status --porcelain -uall` | Chỉ liệt kê đường dẫn; không nói entry có đọc được hay không |
| Comment đầu hàm ("Best-effort: a snapshot failure only logs") | Ghi rõ chủ đích best-effort — nghĩa là contract *hiện tại* là best-effort, còn luật `AGENTS.md:40` đòi integrity |

Gốc rễ: hàm trả `boolean` trong khi miền trạng thái cần biểu diễn là
**{đầy đủ, không đầy đủ, thất bại}** cộng với lý do. Một bit không chở được
thông tin đó, nên caller buộc phải suy diễn — và suy diễn sai.

## 3. Hướng sửa được chọn

Nguyên tắc từ plan §3.5: **không dùng "đã ghi artifact" làm bằng chứng "đã sao lưu
đầy đủ"**. Cụ thể:

### 3.1 Đổi kiểu trả về thành kết quả có cấu trúc

`snapshotDirtyWorktree` trả một object (tên minh hoạ; chốt tên khi implement):

```ts
export interface WorktreeSnapshotResult {
	/** true CHỈ khi mọi entry dirty đã được sao lưu đầy đủ và diff tracked (nếu có) lấy được. */
	complete: boolean;
	artifact?: ArtifactDescriptor;
	/** Entry bị cắt theo cap, kèm kích thước gốc. */
	truncated: Array<{ path: string; originalSize: number }>;
	/** Entry không đọc/không stat được — mất hoàn toàn khỏi artifact. */
	skipped: Array<{ path: string; reason: string }>;
	/** Lỗi khi lấy `git diff HEAD --binary` (undefined = không có lỗi). */
	trackedDiffError?: string;
	/** Lỗi khi ghi artifact (nếu có) — tương ứng `false` cũ. */
	writeError?: string;
}
```

`complete === true` khi và chỉ khi `truncated` rỗng, `skipped` rỗng,
`trackedDiffError === undefined`, `writeError === undefined`. Đây là bất biến
thuần tuý, test được không cần git.

### 3.2 Tách hàm quyết định (thuần, test được)

```ts
export function shouldDiscardDirtyWorktree(result: WorktreeSnapshotResult, force: boolean): boolean {
	return force || result.complete;
}
```

Hai cổng `:855-863` và `:1015-1023` thay `if (snapshotOk)` bằng hàm này. Nhánh
`else` giữ nguyên hành vi bảo toàn (`dirtyPreserved`) và thêm thông tin lý do
(`truncated`/`skipped`/`trackedDiffError`) vào `logInternalError`.

### 3.3 `force` tường minh

Cần một `force` đi tới hàm quyết định. Đường cấp phát: `RunLockOptions`-style
options object trên `prepareTaskWorkspace` / `prepareTaskWorkspaceAsync`, hoặc
config `worktree.forceCleanDirty`. **Chọn option tường minh trên hàm**, không
chọn config — lý do: luật `AGENTS.md:40` nói "unless `force` is explicitly set",
tức quyết định thuộc call-site của thao tác phá huỷ, không thuộc cấu hình toàn cục
bật một lần rồi quên. (Xem §5 — phương án bị loại.)

### 3.4 Đọc có giới hạn (allocation bound)

Thay `readFileSync(abs)` bằng đọc có trần: mở file, đọc tối đa
`MAX_FILE_BYTES + 1` byte để phát hiện "còn dữ liệu phía sau", rồi đóng. Entry
vượt cap đi vào `truncated` và **không** được coi là đã sao lưu. Không cần thêm
phụ thuộc: `fs.openSync` / `fs.readSync` / `fs.closeSync` là đủ.

Hệ quả phải chấp nhận: file lớn hơn cap giờ dẫn tới **không dọn** worktree thay
vì dọn kèm mất đuôi. Đây là thay đổi hành vi có chủ đích — đúng theo AC1/AC4.

### 3.5 Diff tracked: phân biệt "rỗng" với "lỗi"

Giữ `trackedDiff = ""` cho nhánh thành công-rỗng, nhưng ghi
`trackedDiffError` trong `catch`. `complete` tính tới trường này.

## 4. Phương án bị loại

| Phương án | Vì sao loại |
|---|---|
| **Tăng cap lên rất lớn (ví dụ 64 MiB)** | Chỉ đẩy biên xa hơn; không giải quyết entry không đọc được (P2), không giải quyết allocation (cap vẫn đọc trọn file), và biến mất mát thành "hiếm hơn" thay vì "không xảy ra" |
| **Coi truncation là chấp nhận được, chỉ cảnh báo mạnh hơn** | Trực tiếp vi phạm `AGENTS.md:40`; artifact vẫn là bằng chứng sai |
| **Base64 hoá toàn bộ file để "không cắt"** | File 2 GiB → artifact ~2,7 GiB; đổi mất dữ liệu lấy OOM, và vẫn thất bại ở entry không đọc được |
| **Bỏ hẳn cleanup (không bao giờ xoá dirty worktree)** | Phá luồng clean-slate reuse: worktree dirty tồn đọng chặn lần chạy sau. `force` là lối thoát cần thiết, không phải bỏ |
| **Chỉ dựa vào `git stash` thay vì snapshot** | `stash` không bao phủ untracked nếu thiếu `-u`, không phục hồi được từ artifact (khác cơ chế lưu trữ hiện có), và thêm trạng thái ngoài `artifactsRoot`; ngoài ra `git stash` cũng là thao tác git phá huỷ cần cùng mức guard |
| **Bật `force` qua config toàn cục** | Biến "phê duyệt cho một lần" thành "phê duyệt vĩnh viễn"; người dùng bật một lần rồi mọi run sau mất dữ liệu im lặng |
| **Cho caller tự quyết bằng cách để hàm ném lỗi** | Làm luồng reuse thất bại hoàn toàn (không có đường bảo toàn mềm); nhánh `dirtyPreserved` hiện có cho thấy chủ đích là "giữ nguyên và đi tiếp" |

## 5. Ảnh hưởng dữ liệu và trạng thái

- **Không đổi định dạng artifact.** Vẫn `worktree-recovery/<taskId>-<Date.now()>.md`,
  `kind: "diff"`, `retention: "run"`. Chỉ thêm phần mô tả entry bị bỏ qua (nội dung
  artifact không phải state đọc bởi máy).
- **Không đổi schema state.** `manifest.json`, `tasks.json`, `events.jsonl` không
  đổi shape.
- **Đổi kiểu trả về của hàm export `snapshotDirtyWorktree`** — API nội bộ của
  `worktree-manager.ts`. Grep call-site trước khi sửa (exec-plan step 1); có
  call-site trong `test/integration/worktree-snapshot-dirs-binary.test.ts`.
- **Hành vi runtime đổi:** worktree dirty chứa file > cap (hoặc entry không đọc
  được) sẽ **không** được dọn tự động nữa. Đây là điểm cần nêu trong changelog và
  trong product doc — lưu ý `docs/product/README.md` liệt kê `worktree.md` nhưng
  file này **không tồn tại** trong repo hôm nay; chọn tạo mới hoặc bổ sung
  `docs/product/runtime-safety.md` §State Integrity.
- **Log mới:** nhánh bảo toàn đã có `worktree.reused.dirtyPreserved`; thêm trường
  lý do vào message (không thêm event type mới ⇒ không phải đăng ký
  `TEAM_EVENT_TYPES`, không chạm `check:event-types`).

## 6. Backward compatibility

| Bề mặt | Tác động | Xử lý |
|---|---|---|
| `snapshotDirtyWorktree` (export nội bộ) | Đổi kiểu trả về `boolean` → object | Cập nhật mọi call-site trong cùng PR; không có consumer ngoài repo (không nằm trong `pi` extension API) |
| `prepareTaskWorkspace` / `prepareTaskWorkspaceAsync` | Thêm tham số options tuỳ chọn | Additive; call-site cũ không đổi hành vi về chữ ký, nhưng **hành vi** đổi ở nhánh dirty (xem §5) |
| Artifact markdown | Không đổi định dạng bắt buộc | Test hiện có assert nội dung vẫn pass |
| Test cũ | `worktree-snapshot-dirs-binary.test.ts` assert `snapshotOk === true` | Phải đổi sang `result.complete === true`; nội dung assert giữ nguyên |
| Người dùng đang dựa vào auto-clean | Mất tính năng "tự dọn" cho worktree có file lớn | Ghi rõ trong CHANGELOG + product doc (tạo `docs/product/worktree.md` hoặc bổ sung `docs/product/runtime-safety.md`); `force` là lối thoát |
| Windows | `chmod 000` không mô phỏng được | Test AC3 self-skip trên `win32`; AC1/AC4/AC5/AC9 chạy trên cả ba OS |

## 7. Cân nhắc bảo mật

- **Bảo toàn > availability** ở đường phá huỷ. Đây là chuyển dịch chủ đích theo
  `AGENTS.md:40` và `docs/FEATURE_INTAKE.md` (T3 — irreversible: bulk delete).
- **`readFileSync` có trần** giảm bề mặt DoS cục bộ: một file untracked khổng lồ
  trong worktree hiện có thể ép tiến trình cấp phát bộ nhớ lớn ngay trong luồng
  dọn dẹp. Sau fix, allocation bị chặn ở `MAX_FILE_BYTES + 1`.
- **Đường dẫn vẫn đi qua `writeArtifact`** (`resolveInside` + `resolveRealContainedPath`)
  nên không thay đổi bề mặt path traversal; `rel` vẫn lấy từ `git status` và được
  `path.join(worktreePath, rel)` — không đổi trong story này.
- **Không thêm thao tác git mới.** `checkout -- .` và `clean -fd` giữ nguyên nhưng
  chỉ chạy khi `complete` hoặc `force`.
- **`force` là quyết định của caller**, không đọc từ input người dùng cuối trong
  story này (không thêm tham số tool `team`) ⇒ không mở bề mặt command injection.
- **Accepted risk giữ nguyên:** entry bị bỏ qua không thể phục hồi từ artifact; sau
  fix, điều đó được nêu tên trong artifact (`skipped`) và chặn việc xoá — nhưng
  nếu caller set `force`, mất mát vẫn xảy ra. Cần ghi rõ trong decision record.

## 8. Decision record stub (tạo lúc implement)

Đường dẫn đề xuất: `docs/decisions/2026-09-XX-worktree-snapshot-completeness.md`
(đặt ngày thật khi implement; cập nhật `docs/decisions/README.md`).

```markdown
# Worktree snapshot completeness gate — dirty worktree preserved unless `force`

Date: YYYY-MM-DD
Status: Proposed | Accepted
Relates to: AGENTS.md:40, RR-010 (F01), src/worktree/worktree-manager.ts

## Context

snapshotDirtyWorktree() returned a boolean whose `true` meant only "writeArtifact
did not throw". Truncation at 256 KiB, unreadable entries, and a failed tracked
diff all still returned `true`, so the reuse path ran `git checkout -- .` +
`git clean -fd` and destroyed data the artifact did not contain (probe P2:
a chmod 000 file disappeared from BOTH the artifact and the worktree). This
violated AGENTS.md:40.

## Decision

- snapshotDirtyWorktree returns a structured result (complete/truncated/skipped/
  trackedDiffError/writeError) instead of a boolean.
- A pure predicate (shouldDiscardDirtyWorktree) decides whether the destructive
  cleanup runs: `force || result.complete`.
- Untracked reads are capped at MAX_FILE_BYTES+1 bytes; exceeding the cap marks
  the entry truncated (never "backed up").
- `force` is an explicit call-site option, not a global config flag.

## Alternatives Considered

1. Raise the cap — rejected: moves the boundary, does not remove it; still reads
   the whole file.
2. Accept truncation with a louder warning — rejected: violates AGENTS.md:40 and
   keeps the artifact as false evidence.
3. Base64 the whole file — rejected: artifact size explodes; unreadable entries
   still lost.
4. Never clean dirty worktrees — rejected: breaks clean-slate reuse; `force`
   must remain an escape hatch.
5. Global config flag for force — rejected: turns per-action approval into
   permanent silent approval.

## Consequences

Positive:
- Dirty worktree bytes survive unless force is explicitly set (AGENTS.md:40
  becomes enforceable, not aspirational).
- Allocation during snapshot is bounded.

Tradeoffs:
- A worktree containing an untracked file larger than 256 KiB will no longer be
  auto-cleaned; the operator must set `force` (or move the file) — documented in
  CHANGELOG + the product doc (create `docs/product/worktree.md` or extend
  `docs/product/runtime-safety.md` §State Integrity).
- Snapshot still cannot recover an unreadable entry; it now names it and blocks
  the delete instead.
```

## 9. Tham chiếu

- `docs/stories/RR-010/overview.md` — AC và risk flags
- `docs/stories/RR-010/exec-plan.md` — thứ tự RED→GREEN
- `docs/stories/RR-010/validation.md` — thang kiểm chứng
- Code: `src/worktree/worktree-manager.ts` (`snapshotDirtyWorktree`, hai cổng reuse)
- Xác minh: `docs/archive/2026-09-17-pi-crew-review-verification.md` §4 F01, §8.3
- Luật: `AGENTS.md:40`; phân loại: `docs/FEATURE_INTAKE.md`
