# MuxSurface — Layout Tab riêng per-task + right/down luân phiên

> **Spec bổ sung** cho `2026-08-26-mux-surface-design.md` (A1 cơ bản giữ nguyên;
> bổ sung quy chuẩn **layout** khi nhiều task chạy song song — thay thế hành vi
> "mọi pane dồn bên phải cùng 1 tab" hiện tại).
>
> **Trigger**: user chỉ ra "spawn luôn split right, không có quy chuẩn luồng →
> nhiều task đồng thời loạn". Chốt hướng **A**: mỗi **TEAM RUN** một tab/window
> riêng + tận dụng cả `right` và `down` (luân phiên `splitIndex%2`) để pane có
> lưới, không dồn một phía.
>
> **Lưu ý khái niệm**: user chỉ rõ "task hiện tại của pi-crew đang không chuẩn"
> — trong `team run` pi-crew, các worker (explore/execute/verify) là **các
> worker của cùng một run**, KHÔNG phải "task" độc lập. Vì vậy **mỗi run = 1 tab**
> (`tabKey = runId`), không phải mỗi task 1 tab. Tất cả panes của run xếp trong
> tab đó, luân phiên right/down.

## 1. Vấn đề

- `tmux-provider` hiện dùng `split-window -h` (luôn **ngang/right**) trong
  **window hiện tại** — không tạo window/tab mới.
- `herdr-provider` hiện dùng `pane.split direction:"right"` trong **tab hiện tại**
  — không tạo tab mới.
- Hệ quả: **mọi worker trong 1 run đều split right, cùng 1 tab** → N task song
  song xếp dồn về phải, không phân luồng → **loạn** khi chạy nhiều task đồng thời
  (đúng observation của user 2026-08-27).

## 2. Khả năng backend (đã xác minh real 2026-08-27)

| Khả năng | tmux | herdr |
|---|---|---|
| Tạo tab/window mới | `new-window -P -F '#{window_id}'` → `@N` | `tab create` → `wN:tM` (kèm root pane) |
| Split ngang (right) | `split-window -h` (`-t <window>`) | `pane.split direction:"right"` |
| Split dọc (down) | `split-window -v` (`-t <window>`) | `pane.split direction:"down"` |
| Đặt pane trong tab cụ thể | `-t <window>` (window mới tạo) | `target_pane_id=<pane trong tab>` |
| Rename tab | `rename-window -t <window> <name>` | `tab rename --tab <tab> --label <name>` |
| Đóng sạch khi xong | `kill-window` | `tab close` |
| Root pane của tab mới | pane gốc của window mới | `tab.result.root_pane.pane_id` |

Probe thật: herdr `tab create --label extest --workspace w2` → `w2:t4` root `w2:p62`,
`pane.split right` → `w2:p63`, `down` → `w2:p64`, `tab close w2:t4` dọn sạch.
tmux `new-window` → `@1`, `split-window -h` → `%2`, `-v` → `%3`, `rename-window`.

## 3. Thay đổi

### 3.1 `SurfaceSpawnOpts` — thêm `tab` context + `splitIndex`

Provider cần biết **run nào** để đặt tên tab, và pane thứ mấy trong tab để luân
phiên right/down. `SurfaceSpawnOpts` hiện: `{cwd, command?, title?}` → thêm:

```ts
interface SurfaceSpawnOpts {
  cwd: string;
  command?: string;
  title?: string;          // vẫn giữ (pane label / window title)
  taskId?: string;         // để đặt tên tab (fallback = title)
  tabKey?: string;         // runId → TAB THUỘC TEAM RUN này (mỗi RUN 1 tab)
  splitIndex?: number;     // pane thứ mấy trong tab → quyết hướng right/down
}
```

- `tabKey = runId` (mỗi **team run** 1 tab) — KHÔNG phải mỗi task.
- Provider **tạo tab riêng** khi `tabKey` mới (chưa tồn tại cho run), **dùng lại
  tab** khi `tabKey` trùng (mọi worker của run trong cùng tab).
- `splitIndex` là số pane worker run đã spawn trong tab → quyết hướng:
  **`splitIndex % 2 === 0 → down`, `=== 1 → right`** (bắt đầu down, xen kẽ) —
  không dồn một phía.

### 3.2 `tmux-provider` — tạo window/tab per-run

`createSurface`:
1. Nếu `tabKey` (= runId) chưa có window cho key → `new-window -P -F '#{window_id}'`
   (session hiện tại), rename `rename-window <window> <taskId>` (hoặc runId),
   ghi map `tabKey → windowId[]`.
2. Split trong window đó: `split-window -h|-v -P -F '#{pane_id}' -t <window>`
   theo `splitIndex` (down first, then right xen kẽ).
3. Khi `splitIndex >= 8` (đầy tab) → `new-window` tab mới (cùng run), reset splitIndex.

`closeSurface` **CHỈ gọi khi run end**: `kill-window` toàn tab (không đóng pane lẻ
khi worker hoàn thành — giữ tab sống để coi kết quả).

### 3.3 `herdr-provider` — tạo tab per-run

`createSurface`:
1. Nếu `tabKey` chưa có tab → `tab create {workspace_id, label: taskId}` → lấy
   `root_pane.pane_id` làm root của tab, `tab_id`.
2. Split `pane.split` với `target_pane_id` = root pane của tab (hoặc pane cuối),
   `direction` theo `splitIndex` (down first, then right xen kẽ).
3. Khi `splitIndex >= 8` → `tab create` tab mới (cùng run), reset splitIndex.

`closeSurface` **CHỈ khi run end**: `tab close` toàn tab (pane xong không đóng —
giữ tab coi kết quả).

### 3.4 prepare-surface-spawn — tính `tabKey` + `splitIndex`

`prepareSurfaceSpawn` đề cần:
- `tabKey = runId` (mỗi **team run** 1 tab chính; thêm tab khi ≥8 pane).
- `splitIndex` = số pane worker run đã spawn trong tab HIỆN TẠI (đếm theo
  tab/pane count) — host giữ counter per-run; khi `splitIndex >= 8` → provider
  tự tạo tab mới + reset splitIndex.
- **Tab đóng khi run end** (`finalizeRun` / cancel / kill) — provider close tab
  toàn bộ; worker pane hoàn thành KHÔNG đóng tab.

### 3.5 Rename/label

- Tab: `taskId` (hoặc title nếu taskId không có).
- Pane trong tab: `title` (như hiện tại).

### 3.6 Manifest/tracking

- `manifest.surface.panes` giờ track **tab id + pane id** (thay vì chỉ pane id):
  `{paneId: {tabId, kind, ...}}` — để doctor/cleanup biết đóng cả tab.

## 4. Layout luân phiên right/down

```
TEAM RUN #1 (tab "team_...")   worker 0.5 → down, worker 0.6 → right, worker 0.7 → down...
TEAM RUN #2 (tab "team_...")   worker 0.8 → down, ...
```

Mỗi **team run 1 tab riêng** → không loạn giữa run; trong tab, worker panes xếp
theo right/down luân phiên → không dồn hết sang phải. `ratio` (herdr) có thể
tinh chỉnh tùy màn hình.

## 5. Tham số (chốt cùng user 2026-08-27)

| Tham số | Quyết định | Lý do |
|---|---|---|
| Tab = | **1 TEAM RUN** (`tabKey = runId`) | User: "cho team run thì đúng hơn là task — task hiện tại đang không chuẩn" |
| Giới hạn pane/tab | **Max 8 worker panes/tab** | User: "max 8 pane mỗi tab"; vượt → tạo **tab mới** (cùng run) |
| Tạo tab mới khi | `splitIndex ≥ 8` (đầy tab hiện tại) | User: "nếu team run spawn đồng thời lớn hơn 8 → tab mới" |
| Đóng tab | **CHỈ khi team run đóng / cancel / kill** | User: "tab chỉ đóng khi team run bị đóng/cancel/kill" — KHÔNG đóng pane lẻ khi worker xong |
| Nested/chuỗi | **cùng tab team run** | User: "cùng team run" |
| Luân phiên | `splitIndex % 2 === 0 → down`, `1 → right` | User: chọn splitIndex%2 |
| Tên tab | `runId` / `taskId` của worker đầu | Dễ nhận biết run nào đang chạy |

**Hệ quả đóng tab**: worker pane → worker hoàn thành → pane **GIỮ NGUYÊN** (để coi
kết quả), KHÔNG auto-close pane/tab; tab đóng khi **run end** (`finalizeRun` /
`cancel` / `kill`) → provider `closeSurface` toàn tab (tmux `kill-window` / herdr
`tab close`). Doctor orphan cleanup phải biết **tab id** để dọn nếu host chết.

**Cơ chế `tabKey → tabId(s)`**: mỗi run duy trì danh sách tab (1 tab chính +
tab mới khi >8 pane). `splitIndex` đếm pane trong tab HIỆN TẠI; khi đạt 8 →
tab mới, reset splitIndex về 0 cho tab mới.

## 6. Testing

- Unit `tmux-provider`: new-window (per-run tab) + split right/down + rename + **close tab khi run end** (CHỈ kết thúc).
- Unit `herdr-provider`: tab create (per-run) + pane.split right/down + **tab close khi run end**.
- `prepare-surface-spawn`: tabKey=runId + splitIndex truyền đúng; **splitIndex ≥ 8 → tab mới**.
- E2E thật: 2 team run song song → 2 tab riêng; **>8 worker → tab mới**; worker xong KHÔNG đóng tab; run end đóng toàn tab.
- `test:critical` + typecheck + build bundle.

## 7. Phạm vi

- **A1**: layout tab per-run + right/down luân phiên (thay thế hard-code right).
- **A2**: rebalance, canvas cap config, ratio tinh chỉnh.

## 8. Rủi ro

- **Giữ tab sống tới run end** → tab chứa nhiều pane worker đã xong (rỗng) nhất
  thời — chấp nhận (user muốn coi kết quả). Nhớ **alt**: tab không auto-close lúc
  worker xong, nhưng **run end / cancel / kill PHẢI đóng toàn tab** (clear mạnh).
- `tabKey → windowId/tabId[]` map có thể rò nếu run không finalize → doctor
  orphan cleanup cần biết **tab id** để dọn (thêm `tabId` vào manifest panes).
- tmux window id vs herdr tab id khác format — manifest cần `{kind, tabId}`.
- Mỗi matrix test phải cho `splitIndex` khác nhau để cover cả right lẫn down;
  test `splitIndex >= 8` tạo tab mới.