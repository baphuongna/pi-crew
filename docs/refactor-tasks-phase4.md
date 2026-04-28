# Phase 4 Refactor Plan — UI/Theme/Performance từ pi-mono coding-agent

> Xuất xứ: review sâu `source/pi-mono/packages/coding-agent` + `source/pi-mono/packages/tui` (28/04/2026), so sánh với `pi-crew/src/ui/` hiện tại.
> Mục tiêu: tăng hiệu năng render, dọn duplicate code, type-safe theme integration, port các UI component thiếu (diff/loader/visual-truncate/syntax highlight).
> Phase 3 (#26–#37) đã hoàn tất, baseline: tsc 0 errors, 213 unit + 21 integration pass, commit `6f64c31`.

## Quy ước chung
- Không phá vỡ public API (slash commands, tool actions, config schema). Mọi thay đổi nội bộ.
- Sau mỗi task: `npx tsc --noEmit` + `npm run test:unit` (+ `test:integration` nếu liên quan render/layout).
- Không thêm dependency runtime mới trừ khi task ghi rõ (chấp nhận `diff` cho Task #45 nếu chưa có).
- Mỗi task = 1 commit độc lập có thể revert. Đặt tên test bám sát hành vi.
- `theme` parameter đang là `unknown` — không được break `ctx.ui.custom((tui, theme, ...) => Component)` signature do pi-coding-agent dictate.

## Trạng thái cập nhật
- [x] Task #38 — `utils/visual.ts` dedupe truncate/visibleWidth
- [x] Task #39 — Render cache cho widget/sidebar
- [x] Task #40 — File-coalescer apply vào readers UI
- [x] Task #41 — Manifest cache với mtime invalidation
- [x] Task #42 — Type-safe theme adapter
- [x] Task #43 — Status palette helpers
- [x] Task #44 — Refactor widgets sang pi-tui Container/Box/Text
- [x] Task #45 — Port `renderDiff` (word-level intra-line)
- [x] Task #46 — Port `BorderedLoader` + `CountdownTimer`
- [x] Task #47 — Port `truncateToVisualLines` cho transcript
- [x] Task #48 — Syntax highlight cho transcript JSONL
- [x] Task #49 (optional) — Animated mascot easter egg
---

## Tier 1 — Performance (high ROI, low risk)

Mục tiêu: 4 task, dedupe + cache + I/O coalescing. Risk thấp, không đổi API. Ước tính: 1–2 ngày.

### Task #38 — Dedupe truncate/visibleWidth → `src/utils/visual.ts`
**Source**: `@mariozechner/pi-tui` (đã ship `visibleWidth`, `truncateToWidth`); pi-mono `components/visual-truncate.ts`
**Đích**: `pi-crew/src/utils/visual.ts`

**Lý do**: 4 file UI (`run-dashboard.ts`, `crew-widget.ts`, `live-run-sidebar.ts`, `transcript-viewer.ts`) mỗi file có bản copy của:
- `ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g`
- `visibleWidth(value)` / `visibleLength(value)`
- `truncate(value, width)` (logic không hoàn toàn nhất quán giữa các bản)
- `pad(value, width)` / `padVisible`

→ Lặp lại ~80 dòng × 4 file. Dễ xảy ra drift bug.

**API export**:
```typescript
export const ANSI_PATTERN: RegExp;
export function visibleWidth(value: string): number;
export function truncate(value: string, width: number, ellipsis?: string): string;
export function pad(value: string, width: number): string;
export function wrapHard(value: string, width: number): string[];
export function boxLine(text: string, innerWidth: number): string; // "│ {pad/truncate} │"
```

**Tích hợp**:
- Re-export `visibleWidth` + `truncateToWidth` từ `@mariozechner/pi-tui` nếu có (kiểm tra `tui/utils.ts`).
- 4 file UI thay `import { ... }` từ local helper → `from "../utils/visual.ts"`.
- Xoá local helpers đã chuyển.

**Acceptance**:
- File mới + xoá ~80 LOC × 4 file (~320 LOC giảm).
- Unit test `test/unit/visual.test.ts`: 6 case
  - `visibleWidth("\u001b[31mhello\u001b[0m")` = 5
  - `truncate("hello world", 5)` = "hell…"
  - `truncate(value, 0)` = ""
  - `truncate(value, 1)` = "…"
  - `pad("ab", 5)` = "ab   "
  - `wrapHard("abcdefgh", 3)` = ["abc","def","gh"]
- Snapshot test (optional): render `crew-widget` trước/sau giống bit-by-bit.

**Risk**: Thấp. Behavior tương đương, chỉ tách module.

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep visual` + `npm run test:unit -- --grep widget` (smoke).

---

### Task #39 — Render cache cho widget/sidebar (cachedWidth + version)
**Source pattern**: `pi-mono/packages/coding-agent/src/modes/interactive/components/armin.ts` (cachedWidth + cachedVersion + invalidate)
**Đích**: `crew-widget.ts`, `live-run-sidebar.ts`, `run-dashboard.ts`

**Lý do**: Mỗi tick (`widgetDefaultFrameMs`, `dashboardLiveRefreshMs` = 100ms) toàn bộ box được rebuild dù dữ liệu chưa đổi và terminal width chưa đổi. Khi data nhiều agent (>10), render cost không trivial.

**API pattern (per component)**:
```typescript
class CrewWidgetComponent {
  private cachedWidth = 0;
  private cachedVersion = -1;
  private currentVersion = 0;
  private cachedLines: string[] = [];

  invalidate(): void {
    this.cachedWidth = 0; // forces rerender on next render() call
  }

  private dataSignature(): number {
    // Hash from runs.length + agents counts + max updatedAt + statuses
    // Bump currentVersion when signature differs from last computed
  }

  render(width: number): string[] {
    const sig = this.dataSignature();
    if (width === this.cachedWidth && this.cachedVersion === sig) return this.cachedLines;
    // ... build lines ...
    this.cachedWidth = width;
    this.cachedVersion = sig;
    return this.cachedLines;
  }
}
```

**Tích hợp**:
- `CrewWidgetComponent.render()`: dataSignature từ `frame % spinnerLength` + run/agent hash.
  - Lưu ý spinner thay đổi mỗi tick → vẫn rerender header chứa spinner. Tách `staticBody` (cached) khỏi `spinnerLine` (live).
- `LiveRunSidebar.render()`: dataSignature từ manifest.updatedAt + agents.length + tasks.length + active counts.
- `RunDashboard.render()`: dataSignature từ runs.length + selected index + showFullProgress flag.

**Acceptance**:
- Unit test `test/unit/render-cache.test.ts`:
  - `render(80)` 2 lần liên tiếp với data không đổi → tham chiếu mảng giống nhau (re-use cached).
  - `render(80)` sau khi `invalidate()` → mảng mới.
  - `render(120)` sau `render(80)` → mảng mới (width đổi).
  - Manifest mtime đổi → signature đổi → mảng mới.
- Microbenchmark (`scripts/bench-render.ts` mới):
  - Trước: `LiveRunSidebar.render(80) × 1000` ≥ 150ms
  - Sau: `≤ 50ms` (cache hit ratio > 90%)

**Risk**: Trung bình. Nếu dataSignature không bắt được mọi mutation → stale UI. Mitigation: include `Date.now() / 1000 | 0` trong sig cho live components để rerender 1Hz tối thiểu.

**Verification**: `npx tsc --noEmit` + `npm run test:unit` + bench.

---

### Task #40 — File coalescer apply vào readers UI
**Source pattern**: `pi-crew/src/utils/file-coalescer.ts` (đã có từ Phase 2)
**Đích**: `crew-widget.ts`, `live-run-sidebar.ts`, `run-dashboard.ts`, `powerbar-publisher.ts`

**Lý do**: Mỗi tick render gọi:
- `readCrewAgents(manifest)` → `fs.readFileSync(agents.json)` parse JSON
- `readTasks(tasksPath)` → `fs.readFileSync(tasks.json)` parse JSON

Khi 4 widget cùng tick (widget + sidebar + powerbar + dashboard nếu mở) → cùng file đọc 4 lần trong < 10ms.

**Tích hợp**:
- Bọc `readCrewAgents` + `readTasks` qua `coalesceReads(filePath, ttlMs=200)` cache.
- Tránh stale: invalidate khi chính pi-crew write (set marker timestamp).
- Pattern:
  ```typescript
  // crew-agent-records.ts
  import { coalesceReads } from "../utils/file-coalescer.ts";
  const COALESCE_TTL = 200;
  export function readCrewAgents(manifest: TeamRunManifest): CrewAgentRecord[] {
    return coalesceReads(manifest.agentsPath, COALESCE_TTL, () => parseAgentsFile(manifest.agentsPath));
  }
  ```

**Acceptance**:
- Unit test `test/unit/agents-coalesce.test.ts`:
  - Spy `fs.readFileSync` → 5 calls trong 100ms cho cùng path → chỉ đọc 1 lần.
  - Sau TTL → đọc lại.
- Integration test: tick widget 10 lần trong 500ms → đọc agents.json tối đa 3 lần.

**Risk**: Thấp. TTL ngắn (200ms) đảm bảo data fresh.

**Verification**: `npm run test:unit -- --grep coalesce`.

---

### Task #41 — Manifest cache với mtime invalidation
**Source pattern**: `pi-mono/packages/coding-agent/src/core/footer-data-provider.ts` (cached branch + watch + debounce 500ms)
**Đích**: `pi-crew/src/runtime/manifest-cache.ts` (mới)

**Lý do**: `loadRunManifestById` đọc `manifest.json` + parse. `LiveRunSidebar` gọi mỗi tick (10Hz). Tương tự `listRecentRuns` scan cả thư mục `runs/`.

**API export**:
```typescript
export interface ManifestCache {
  get(runId: string): TeamRunManifest | undefined;
  list(limit: number): TeamRunManifest[];
  invalidate(runId?: string): void;
  dispose(): void;
}
export function createManifestCache(cwd: string, options?: { debounceMs?: number; watch?: boolean }): ManifestCache;
```

**Implementation**:
- Cache Map<runId, { manifest, mtimeMs }>.
- `get(runId)`: stat manifest path; nếu mtime khớp cache → return cached.
- `list(limit)`: scan dir, return top N theo mtime; cache toàn bộ list 500ms.
- Watcher (optional): `watchWithErrorHandler(runsDir)` + debounce 500ms → invalidate.

**Tích hợp**:
- `register.ts` tạo 1 instance ManifestCache khi `session_start`, dispose ở `session_shutdown`.
- `LiveRunSidebar`, `RunDashboard`, `crew-widget`, `powerbar-publisher` nhận cache (qua context closure).

**Acceptance**:
- Unit test:
  - 5 calls `get(runId)` trong 100ms với mtime không đổi → 1 lần stat + 1 lần read.
  - Sau write manifest (mtime đổi) → cache invalidate, đọc lại.
  - `list(10)` cache 500ms.
  - `dispose()` close watchers.
- Integration test: simulate 1Hz manifest update + 10Hz render → render dùng cached value, không đọc lại trừ khi manifest thực sự đổi.

**Risk**: Trung bình. Watch on Windows có quirks (đã giảm bằng Phase 3 fs-watch wrapper).

**Verification**: `npm run test:unit -- --grep manifest-cache` + `npm run test:integration`.

---

## Tier 2 — Theme Integration (clean API, type-safe)

Mục tiêu: 3 task, type-safe theme + reuse pi-tui layout primitives. Risk trung bình. Ước tính: 1–2 ngày.

### Task #42 — Type-safe theme adapter `src/ui/theme-adapter.ts`
**Source pattern**: `pi-mono/packages/coding-agent/src/modes/interactive/theme/theme.ts` (Theme class với fg/bg/bold/italic)
**Đích**: `pi-crew/src/ui/theme-adapter.ts`

**Lý do**: Hiện tại 5 file UI cast `theme as unknown as { fg?: ... }`. IDE không suggest color names, dễ typo (`accenT` không lỗi compile).

**API export**:
```typescript
export type CrewThemeColor =
  | "accent" | "border" | "borderAccent" | "borderMuted"
  | "success" | "error" | "warning"
  | "muted" | "dim" | "text"
  | "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext"
  | "syntaxKeyword" | "syntaxString" | "syntaxNumber" | "syntaxComment" | "syntaxFunction" | "syntaxVariable" | "syntaxType";

export type CrewThemeBg = "selectedBg" | "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface CrewTheme {
  fg(color: CrewThemeColor, text: string): string;
  bg?(color: CrewThemeBg, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
  underline?(text: string): string;
  inverse?(text: string): string;
}

export function asCrewTheme(raw: unknown): CrewTheme;
```

**Implementation**:
- `asCrewTheme`: validate raw có method `fg`/`bold`. Nếu thiếu → fallback no-op `(c, t) => t`.
- Sub-set của pi-coding-agent Theme class — không trùng namespace `CrewThemeColor` nhưng align values.

**Tích hợp**:
- `crew-widget.ts`, `live-run-sidebar.ts`, `run-dashboard.ts`, `transcript-viewer.ts`:
  - Replace `theme.fg?.bind(theme) ?? ((_color, text) => text)` bằng `const t = asCrewTheme(rawTheme); t.fg("accent", x)`.
  - Param signature: `(theme: unknown)` đổi thành `(theme: CrewTheme | unknown)`.

**Acceptance**:
- Unit test `test/unit/theme-adapter.test.ts`:
  - `asCrewTheme(undefined)` → no-op fallback.
  - `asCrewTheme({})` → no-op.
  - `asCrewTheme({ fg: ..., bold: ... })` → uses provided methods.
  - Type test (compile-only): `t.fg("nonExistent", "x")` produces TS error.
- Lint pass; tsc 0 errors sau khi thay 5 file.

**Risk**: Thấp. Fallback an toàn cho host không cung cấp đủ method.

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep theme-adapter`.

---

### Task #43 — Status palette helpers `src/ui/status-colors.ts`
**Source pattern**: `pi-mono` highlight pattern + pi-crew current ad-hoc switch-case
**Đích**: `pi-crew/src/ui/status-colors.ts`

**Lý do**: 5 file (`run-dashboard:65-72`, `crew-widget:89-95`, `live-run-sidebar:35`, `transcript-viewer`, `powerbar-publisher`) mỗi nơi có `switch(status){...}` mapping → màu/icon. Hiện không nhất quán (vd `crew-widget` ưu tiên `runningGlyph`, `run-dashboard` không).

**API export**:
```typescript
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "stale" | "stopped" | (string & {});

export function colorForStatus(status: RunStatus): CrewThemeColor;
export function iconForStatus(status: RunStatus, options?: { runningGlyph?: string }): string;
export function colorForActivity(activityState: string | undefined): CrewThemeColor;
export function applyStatusColor(theme: CrewTheme, status: RunStatus, text: string): string;
```

**Implementation**:
- `colorForStatus`: `completed→success`, `failed|stale|error→error`, `cancelled|blocked|stopped→warning`, `running→accent`, `queued→muted`, default→dim.
- `iconForStatus`: `completed→✓`, `failed/stale→✗`, `cancelled/stopped→■`, `running→runningGlyph || ▶`, `queued→◦`, `blocked→⏸`, default→·.

**Tích hợp**:
- 5 file UI thay switch-case bằng 1 dòng `colorForStatus(status)`.
- `crew-widget.colorWidgetLine` regex map icon → dùng `iconForStatus` direct.

**Acceptance**:
- Unit test `test/unit/status-colors.test.ts`: 8 case theo từng status + edge case unknown status.
- Snapshot widget/dashboard render không thay đổi (test regression).

**Risk**: Thấp. Pure mapping function.

**Verification**: `npm run test:unit -- --grep status-colors`.

---

### Task #44 — Refactor widgets dùng pi-tui Container/Box/Text
**Source pattern**: `pi-mono/packages/tui/src/components/box.ts`, `text.ts`, plus `pi-mono/components/footer.ts` để tham chiếu cách compose.
**Đích**: `live-run-sidebar.ts`, `run-dashboard.ts` (giảm độ phức tạp)

**Lý do**: 2 file đang vẽ box bằng string concatenation `╭─╮│├┤╰╯` thủ công, mỗi line gọi `pad(truncate(...))`. Dễ vỡ khi terminal resize. pi-tui đã có `Container` + `Box` (rounded border tự động) + `DynamicBorder` từ pi-coding-agent.

**Tích hợp**:
- `LiveRunSidebar` → extend `Container`:
  ```typescript
  class LiveRunSidebar extends Container {
    constructor(input) {
      super();
      this.addChild(new DynamicBorder(c => theme.fg("border", c)));
      this.addChild(new Text(theme.bold("pi-crew live sidebar"), 1, 0));
      // ...
    }
    render(width: number): string[] { /* parent handles layout */ }
  }
  ```
- `RunDashboard` tương tự — sections dùng `Spacer(1)` + `Text`.
- Lưu ý: `ctx.ui.custom((tui, theme, keys, done) => Component)` — trả về `Container` instance vẫn OK vì `Container` implements `Component`.

**Acceptance**:
- LOC giảm ≥ 30% cho 2 file.
- Visual snapshot test: render 80 + 120 width, content đồng nhất với baseline (allow whitespace diff).
- handleInput logic giữ nguyên semantics (q/esc/j/k/p/r/s/u/a/i/d/e/o/v).

**Risk**: Trung bình. Nếu Container layout không match cách hiện tại render padding thì box edge dịch chuyển. Mitigation: viết test snapshot trước khi refactor.

**Verification**: `npx tsc --noEmit` + `npm run test:unit` + manual `team-dashboard` smoke.

---

## Tier 3 — UI Components mới

Mục tiêu: 4 task, port các utility UI thiếu. Risk trung-cao. Ước tính: 2–3 ngày.

### Task #45 — Port `renderDiff` (word-level intra-line)
**Source**: `pi-mono/packages/coding-agent/src/modes/interactive/components/diff.ts`
**Đích**: `pi-crew/src/ui/render-diff.ts`

**Lý do**: pi-crew có agents `code-modify`, `reviewer`, `verifier` thường tạo diff artifacts. Hiện tại transcript viewer + result viewer chỉ in raw text. `renderDiff` cho phép:
- Removed line: red với inverse trên token thay đổi.
- Added line: green với inverse trên token thay đổi.
- Context: dim/gray.

**Dependency check**: package `diff` (npm). Verify `pi-crew/package.json` chưa có → nếu thêm: `npm i diff @types/diff`.

**API export**:
```typescript
export interface RenderDiffOptions { filePath?: string }
export function renderDiff(diffText: string, theme: CrewTheme, options?: RenderDiffOptions): string;
```

**Implementation**: Copy `pi-mono/diff.ts` + thay `theme.inverse` import từ adapter; replace `theme.fg("toolDiff*", ...)` (đã thêm vào `CrewThemeColor` Task #42).

**Tích hợp**:
- `transcript-viewer.ts`: detect `[Tool: edit]` blocks chứa unified diff format → call `renderDiff`.
- Slash command `/team-diff <runId> <taskId>` (optional Task #45.b): render artifact diff trực tiếp.

**Acceptance**:
- Unit test `test/unit/render-diff.test.ts`:
  - Single line modification → intra-line word diff with inverse.
  - Multi line block → no intra-line, just full-line color.
  - Context line preserved.
  - Empty diff → empty string.
- Manual: render fixture `before.ts` vs `after.ts` diff trong overlay.

**Risk**: Trung bình. Add deps `diff` (~30KB). Acceptable.

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep render-diff`.

---

### Task #46 — Port `BorderedLoader` + `CountdownTimer`
**Source**: `pi-mono/packages/coding-agent/src/modes/interactive/components/bordered-loader.ts` + `countdown-timer.ts`
**Đích**: `pi-crew/src/ui/loaders.ts`

**Lý do**: 
- `team run` async start có thể mất 2–5s spawn child. Hiện không feedback UI.
- `team cancel runId=...` force-kill nhưng không hiển thị countdown trước SIGKILL.
- `team-doctor` chạy 1–3s I/O không có loader.

**API export**:
```typescript
export interface CrewBorderedLoaderOptions {
  cancellable?: boolean;
  message: string;
}
export class CrewBorderedLoader extends Container {
  constructor(tui: TUI, theme: CrewTheme, options: CrewBorderedLoaderOptions);
  get signal(): AbortSignal;
  set onAbort(fn: (() => void) | undefined);
  dispose(): void;
}

export interface CountdownTimerOptions {
  timeoutMs: number;
  onTick: (seconds: number) => void;
  onExpire: () => void;
  tui?: TUI;
}
export class CountdownTimer {
  constructor(options: CountdownTimerOptions);
  dispose(): void;
}
```

**Implementation**: Copy code from pi-mono, thay theme reference qua adapter. Lưu ý `CancellableLoader`/`Loader` được pi-tui export — verify trước khi import.

**Tích hợp** (per use case, có thể commit riêng):
- `team-tool/run.ts`: trước khi spawn, hiển thị `CrewBorderedLoader` với message "spawning crew agents...". Khi run started, dispose loader + open sidebar.
- `team-tool/cancel.ts`: tạo `CountdownTimer({ timeoutMs: 5000, onTick: s => loader.setMessage(`cancelling in ${s}s, press y to skip`) })`.

**Acceptance**:
- Unit test `test/unit/loaders.test.ts`:
  - `CrewBorderedLoader.signal.aborted` = false ban đầu, true sau khi user trigger Esc.
  - `dispose()` clear interval + remove listeners.
  - `CountdownTimer` tick → onTick gọi với seconds giảm dần.
  - `CountdownTimer` expire sau timeoutMs → onExpire gọi 1 lần.
- Manual smoke trong `team-run` overlay.

**Risk**: Trung bình. Phụ thuộc pi-tui exports `CancellableLoader`/`Loader` (tham khảo tui/index.ts).

**Verification**: `npm run test:unit -- --grep loaders`.

---

### Task #47 — Port `truncateToVisualLines` cho transcript
**Source**: `pi-mono/packages/coding-agent/src/modes/interactive/components/visual-truncate.ts`
**Đích**: `pi-crew/src/utils/visual.ts` (mở rộng từ Task #38)

**Lý do**: `transcript-viewer.ts` hiện dùng `wrap()` thủ công không tính ANSI codes → wrap sai khi line có color → tràn box hoặc hiển thị loang lổ. `truncateToVisualLines` của pi-mono dùng `Text.render(width)` từ pi-tui để tính chính xác visual lines.

**API export** (bổ sung vào visual.ts):
```typescript
export interface VisualTruncateResult { visualLines: string[]; skippedCount: number }
export function truncateToVisualLines(text: string, maxVisualLines: number, width: number, paddingX?: number): VisualTruncateResult;
```

**Tích hợp**:
- `DurableTextViewer.render` + `DurableTranscriptViewer.render`: thay `body.flatMap(wrap)` bằng `truncateToVisualLines`.
- Hiển thị `... (X lines truncated above)` khi `skippedCount > 0`.

**Acceptance**:
- Unit test:
  - Line không vượt width → trả nguyên + skippedCount=0.
  - Line vượt → wrap đúng số dòng + giữ ANSI codes nguyên vẹn.
  - `maxVisualLines = 5` với 10 dòng → trả 5 dòng cuối + skippedCount = 5.
- Visual smoke: open transcript có code block ANSI dài → no overflow.

**Risk**: Thấp. Pure utility.

**Verification**: `npm run test:unit -- --grep visual-truncate`.

---

### Task #48 — Syntax highlight cho transcript JSONL events
**Source**: `pi-mono/packages/coding-agent/src/modes/interactive/theme/theme.ts` (`highlightCode`, `getLanguageFromPath`)
**Đích**: `pi-crew/src/ui/syntax-highlight.ts` (mới)

**Lý do**: `transcript-viewer.ts` in JSON tool args + assistant code blocks plain text. Highlight tăng readability:
- JSON keys → blue, strings → orange, numbers → green
- Code in messages: detect language → highlight.

**Dependency check**: `cli-highlight` đã có trong pi-mono. Verify pi-crew `package.json` — nếu chưa: `npm i cli-highlight`.

**API export**:
```typescript
export function highlightCode(code: string, lang: string | undefined, theme: CrewTheme): string[];
export function highlightJson(json: string, theme: CrewTheme): string;
export function detectLanguageFromPath(filePath: string): string | undefined;
```

**Implementation**: 
- Copy `highlightCode` + `getLanguageFromPath` từ pi-mono.
- Thay `theme` reference qua adapter (Task #42).
- `highlightJson` shorthand cho `lang="json"`.

**Tích hợp**:
- `formatTranscriptEvent`: khi event là `[Tool: edit]` với JSON args → `highlightJson(stringify(args), theme)`.
- `[Assistant]` content có ```code``` block → extract lang + highlight.

**Acceptance**:
- Unit test:
  - `highlightJson('{"a":1,"b":"x"}')` → lines có ANSI color codes.
  - `highlightCode("function f(){}", "typescript")` → keyword màu.
  - Invalid lang → fallback plain.
- Manual: `team-transcript` xem JSON tool args có màu.

**Risk**: Trung bình. `cli-highlight` ~100KB dep.

**Verification**: `npx tsc --noEmit` + `npm run test:unit -- --grep syntax-highlight`.

---

## Tier 4 — Polish (optional)

### Task #49 (optional) — Animated mascot easter egg `/team-mascot`
**Source**: `pi-mono/packages/coding-agent/src/modes/interactive/components/armin.ts`
**Đích**: `pi-crew/src/ui/mascot.ts` + slash command `/team-mascot`

**Lý do**: Branding/morale. Pi có Armin, pi-crew có thể có mascot riêng (vd: 1 nhóm 3 robots).

**Implementation**:
- XBM bitmap riêng (nhỏ ~30×30) hoặc reuse art logic từ armin.
- 7 effects: typewriter, scanline, rain, fade, crt, glitch, dissolve.

**Acceptance**:
- Slash command `/team-mascot` mở overlay 5s rồi auto-close.
- Không impact startup time (lazy load asset khi gọi).

**Risk**: Thấp. Optional/cosmetic.

**Verification**: Manual smoke.

---

## Tracking template (sao chép vào commit message)

```
Phase 4 #NN — <short title>

Source: source/pi-mono/packages/coding-agent/src/<file>.ts (or pi-tui/...)
Target: pi-crew/src/<dir>/<file>.ts
Risk: low | medium | high
Tests added: test/unit/<file>.test.ts
Verification: tsc --noEmit OK; test:unit OK; test:integration <OK|N/A>; bench <numbers>

Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>
```

---

## Thứ tự gợi ý thực hiện

1. **Tuần 1 — Tier 1 (Performance)**: #38 → #40 → #39 → #41
   - #38 dedupe trước (pre-req cho mọi refactor sau).
   - #40 file-coalescer (low risk, immediate I/O save).
   - #39 render cache (cần #38 để có visual.ts).
   - #41 manifest cache (cần #31 fs-watch từ Phase 3).
   - Bench trước/sau để chứng minh ≥ 4× improvement render hot path.

2. **Tuần 2 — Tier 2 (Theme)**: #42 → #43 → #44
   - #42 type-safe adapter (pre-req cho mọi UI refactor).
   - #43 status palette (low risk, mapping pure).
   - #44 layout primitives (cần snapshot test trước refactor).

3. **Tuần 3 — Tier 3 (UI components)**: #45 → #46 → #47 → #48
   - Có thể song song nếu nhiều dev. Ngược lại theo thứ tự diff → loader → visual-truncate → syntax-highlight.
   - #45 + #48 cần thêm runtime dep (`diff`, `cli-highlight`) — review trước khi merge.

4. **Tier 4 (#49)**: nếu còn thời gian. Branding/morale, không ảnh hưởng functionality.

Toàn bộ Phase 4 ước tính 4–7 ngày focus work, thêm 2 runtime deps (`diff`, `cli-highlight`) khi triển khai #45 + #48 (verify chưa có trong package.json trước khi cài).

---

## Metrics mục tiêu (verification cuối Phase 4)

- **Render cost**: `LiveRunSidebar.render(80) × 1000` từ ~150ms → ≤ 50ms.
- **Disk I/O**: Tick 10Hz × 10s, đọc `agents.json` từ ~100 lần → ≤ 25 lần.
- **LOC**: 5 file UI giảm ≥ 25% (~400 dòng).
- **Test count**: 213 unit → ~245 unit (thêm ~32 test cho 12 task).
- **Type safety**: 0 `as unknown as { fg?: ... }` cast trong `src/ui/`.
- **Deps mới**: tối đa +2 (`diff`, `cli-highlight`), tổng size +130KB.
