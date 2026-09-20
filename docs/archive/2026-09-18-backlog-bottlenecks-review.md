# Review backlog: điểm nghẽn, bảo toàn evidence và vị trí state

## 1. Phạm vi và mức độ bằng chứng

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 2026-09-18 |
| Package | `pi-crew@0.11.1` |
| Baseline | HEAD `0b9fa771` **cộng working tree chưa commit** tại thời điểm nghiên cứu |
| Đầu vào | [Story backlog](../stories/backlog.md), đặc biệt hai nhóm deferred ngày 17–18/9 |
| Môi trường probe | Linux, Node `v22.23.1` |
| Thay đổi trong công việc này | Chỉ thêm bản review này; không sửa runtime, di chuyển state hoặc thay cấu hình |
| Trạng thái | Research/review, **không phải quyết định migration hay đặc tả đã được duyệt** |

Yêu cầu gồm: phân tích sâu các điểm nghẽn, lưu kết quả vào file và đánh giá
việc tạo `.crew/` ở project root so với đặt state dưới `.pi/`.

Review xét **mã đang có trong working tree**, không chỉ nội dung commit HEAD.
Các số dòng là mốc của working tree này và có thể thay đổi sau remediation.
Không reset, stage, commit hoặc sửa các thay đổi có sẵn.

### Quy ước bằng chứng

- **PROBE:** đã gọi helper thật với fixture tổng hợp trong thư mục tạm.
  HOME/state được cách ly; không dùng run thật, credential thật hoặc worker Pi.
- **STATIC:** đã truy vết mã và caller, chưa tái hiện tình huống end-to-end.
- **MEASURED:** đo byte, đếm file hoặc tính kích thước argv trong phiên nghiên cứu.
- **HISTORICAL:** đọc số liệu lưu trước đó; không phải benchmark vừa chạy lại.
- **PROPOSED:** thiết kế/tiêu chí kiểm chứng đề xuất, chưa triển khai.

Các fixture tạm đã được xóa. Kết quả và điều kiện tái hiện được ghi ở đây;
chưa có regression test mới được commit cho những phát hiện này.

Không chạy full suite, Windows CI, live battery, worker-ready benchmark hoặc
migration state thật. Không suy diễn “test suite xanh” từ các probe.

## 2. Kết luận điều hành

Đây không phải một danh sách tối ưu tốc độ thuần túy. Có ba nhóm vấn đề:

1. **Tính đúng và vòng đời dữ liệu:** retention không thống nhất, prune không
   phối hợp với resume, evidence có thể mất, cache trả context của goal khác.
2. **Đo lường và test harness:** startup metrics đo các mốc khác nhau; discovery
   của test wrapper có vấn đề kích thước argv trước cả khi shard chạy.
3. **Chi phí execution:** bundle lớn, lặp context qua nhiều worker, synchronous
   maintenance, cache ownership/invalidation chưa đúng phạm vi.

Ưu tiên là giữ dữ liệu và bằng chứng trước, sửa CI/discovery và cache correctness,
rồi mới tối ưu byte, routing và startup. Không chọn warm pool hoặc lock-free
rotation làm bước đầu khi chưa có profile và hợp đồng correctness đầy đủ.

**Về layout:** đặt dưới `.pi/` hợp lý hơn cho UX của một Pi extension, nhưng phải
có namespace riêng. Hướng đề xuất là dùng **`.pi/teams/` cho project mới**, vì
đây đã là layout được hỗ trợ, thay vì thêm layout thứ ba ngay lập tức.
Project đang dùng `.crew/` phải được giữ ổn định cho tới khi có migration rõ ràng.
Đổi thư mục không tự giải quyết retention, locking, I/O hay rò rỉ artifact.

| ID | Chủ đề | Ưu tiên đề xuất | Bằng chứng chính |
|---|---|---|---|
| BR-01 | Retention/cleanup không dùng chung hợp đồng | P0 | PROBE + STATIC |
| BR-02 | Evidence export chưa phải bản sao độc lập | P0/P1 | STATIC |
| BR-03 | CI discovery, argv Windows và sharding | P1 | MEASURED + STATIC |
| BR-04 | Bundle size và worker-ready bị đánh đồng | P1 cho size; đo trước cho startup | MEASURED + STATIC |
| BR-05 | Workflow nhẹ và routing theo độ phức tạp | P2 | STATIC |
| BR-06 | Cache prompt thiếu goal, clear sai phạm vi | P1 | PROBE + STATIC |
| BR-07 | Coalesced read chia sẻ mutable object | P2 | PROBE; chưa thấy caller production gây mutation |
| BR-08 | Cursor offset + limit bỏ qua phần chưa giao | P2, trước khi mở rộng sử dụng | PROBE; nhánh chưa thấy caller production dùng |
| BR-09 | Shadow-task discriminator phụ thuộc tên agent | P1 correctness | STATIC |
| BR-10 | Các khoản test/tooling/documentation còn treo | P2 | STATIC/HISTORICAL |
| BR-11 | Backlog cũ chưa phản ánh implementation | P2 | STATIC |
| BR-12 | `.crew` tạo ngoài ý muốn; parity `.pi/teams` chưa đầy đủ | P1; cleanup parity là điều kiện chặn đổi default | PROBE + STATIC |

Priority không phải CVSS. Lane ghi bên dưới áp dụng cho **implementation tương
lai**, không biến việc viết review thành một thay đổi runtime đã được duyệt.

## 3. BR-01: retention là vấn đề phối hợp vòng đời, không chỉ thiếu age-floor

### 3.1. Các đường cleanup độc lập

Nguồn:

- `src/extension/registration/lifecycle-handlers.ts:214,468,484`
- `src/extension/registration/artifact-cleanup.ts:37`
- `src/extension/run-maintenance.ts:111,189`
- `src/state/stores/artifact-store.ts:63,146`
- `src/config/defaults.ts:95`

```text
session_start
├─ runArtifactCleanup
│  ├─ cleanupOldArtifacts: tuổi thư mục, mặc định 7 ngày
│  └─ pruneExpiredArtifacts: retention/expiresAt của artifact
└─ deferred cleanup
   ├─ pruneFinishedRuns(cwd, 10)
   └─ pruneUserLevelRuns(10)
```

Thêm age-floor vào `pruneFinishedRuns` không bảo vệ được dữ liệu bị xóa bởi
`cleanupOldArtifacts`. `retention: "project"` cũng không mặc nhiên là một pin
miễn trừ khỏi mọi cleanup khác.

### 3.2. Bốn probe đã chạy

| Probe | Thiết lập | Quan sát |
|---|---|---|
| R1 | 11 run completed, tất cả mới khoảng 12 giây; keep=10 | Removed=1, kept=10 |
| R2 | Manifest running; thư mục artifact cha có mtime 8 ngày; file trong `results/` vừa ghi | Manifest còn, file mới bị xóa |
| R3 | Gọi prune trong callback đang giữ `withRunLockSync` trên failed run | `run.lock` tồn tại trước prune; cả state bị xóa khi callback chưa kết thúc |
| R4 | User-level running run có CWD không tồn tại; `async.pid` trỏ process probe đang sống | State bị xóa; artifact directory vẫn còn |

R2 phản ánh khác biệt giữa mtime thư mục cha và dữ liệu bên trong: ghi file ở
`artifacts/<run>/results/` không nhất thiết làm mới mtime của `artifacts/<run>/`.
Không được lấy tuổi thư mục cha làm tuổi toàn bộ evidence.

R3 chứng minh **prune không tham gia lock**, không phải một phép thử cuộc đua
resume/prune thực tế. R4 chứng minh predicate “CWD không tồn tại” không kiểm tra
liveness của PID đó; không phải bằng chứng một worker thật đã bị mất state.

### 3.3. Race cần giải quyết

`pruneFinishedRuns` lấy snapshot ứng viên rồi xóa, không revalidate trạng thái
dưới cùng protocol với resume/retry. Một interleaving có thể xảy ra:

```text
A: chọn run failed làm ứng viên
B: bắt đầu resume, giữ run lock và cập nhật state
A: tiếp tục xóa theo snapshot cũ
B: tiếp tục ghi/chạy với state đã biến mất
```

Không nên chỉ thêm `withRunLock` quanh deletion:

- `src/state/coordination/locks.ts:17` đặt lock **trong thư mục run sẽ bị xóa**.
- `src/extension/team-tool.ts:357–359` re-read trong resume lock nhưng fallback
  sang manifest/tasks cũ nếu bản fresh không tồn tại.
- Cần tránh việc thao tác chờ lock tái tạo hoặc tiếp tục dùng state đã bị retire.

### 3.4. Chi phí maintenance

`setTimeout(0)` chỉ dời thời điểm chạy, không làm `readdirSync`, `readFileSync`,
`rmSync` và Git đồng bộ trở thành non-blocking. Nhiều host/session có thể scan
lặp trên cùng workspace.

`pruneUserLevelRuns` lấy 500 directory đầu trước khi xét manifest. Với một prefix
ít thay đổi, các entry sau có thể bị bỏ qua lâu dài. Cần pagination/cursor,
không chỉ tăng con số 500.

Audit nhỏ dưới 1 MB chưa được chứng minh là nút thắt tốc độ. Vấn đề đáng đo hơn
là scan lặp, no-op writes và I/O đồng bộ. Rotation audit vẫn cần để giới hạn
storage, nhưng không nên quảng cáo như một cải thiện latency lớn chưa đo.

### 3.5. Thiết kế đề xuất

1. Một policy eligibility dùng chung cho run cleanup và artifact cleanup:
   active/blocked không bị xóa; terminal mới được age-floor; evidence được
   pin/lease hoặc archive; timestamp không rõ thì giữ lại.
2. Hợp đồng retirement chung cho prune/resume/retry, với coordination sống ngoài
   vùng bị xóa hoặc tombstone tương đương. Re-read trước khi chấp nhận xóa;
   missing/deleting run phải abort, không dùng snapshot cũ để hồi sinh.
3. Project/user-level dùng cùng bảo vệ dirty worktree, ownership và audit.
4. Audit có trigger, session, policy và lý do; ghi nhận cả partial failure.
5. Maintenance có cadence theo workspace, scan theo batch có yield; phân biệt
   planning với deletion. Không ghi no-op audit bằng cách tạo root chưa tồn tại.
6. Env mới như `PI_CREW_AUTO_PRUNE_KEEP` phải qua `src/config/env-vars.ts`.
   Quy định rõ giá trị 0, invalid value và cơ chế disable; không để 0 vô tình
   thành “xóa hết” nếu người dùng tưởng là tắt.

**Lane:** high-risk, cần story/ADR và xác nhận trước implementation.
**Acceptance:** test age boundary, timestamp hỏng, blocked/active, dirty
worktree, hai process maintenance, resume cạnh prune, crash giữa các bước xóa
và artifact có nội dung mới trong thư mục cha cũ.

## 4. BR-02: export không đồng nghĩa archive evidence

Nguồn: `src/extension/run-export.ts:39`.

Export JSON/Markdown được ghi vào `manifest.artifactsRoot/export/`. JSON chứa
manifest, tasks, events và `artifactPaths`, không tự đóng gói toàn bộ nội dung
file artifact. Bởi vậy:

- Auto-prune có thể xóa cả bản export.
- Copy mỗi JSON ra ngoài chưa giữ được transcript, result và test log.
- Hướng dẫn “export trước restart” chưa đủ để chứng minh evidence còn tồn tại.

**Đề xuất:** evidence bundle độc lập với runtime retention, gồm manifest/tasks,
event history cần thiết, result/test logs được chọn, revision/tree fingerprint,
bundle hash và checksum từng file. Lọc secrets trước khi lưu dài hạn hoặc commit.

Acceptance quan trọng nhất: xóa fixture run gốc rồi vẫn xác minh được verdict
từ evidence bundle. Pin chỉ trì hoãn xóa, không thay thế backup. Gate archive
cần tự động trong battery; SKILL chỉ hướng dẫn cách dùng gate, không phải lớp
bảo vệ duy nhất.

## 5. BR-03: sửa discovery/argv trước khi shard CI

Nguồn:

- `scripts/test-runner.mjs:120–171`
- `package.json:83–89`
- `.github/workflows/ci.yml:12–108`
- Node v22.23.1 cài sẵn: `internal/test_runner/runner` và
  `internal/main/test_runner` (đã đọc source nhúng, không chạy suite).

### 5.1. Census và giới hạn

**MEASURED:** 869 unit test file:

| Nhóm | Số file |
|---|---:|
| runtime | 301 |
| Ngay dưới test/unit | 157 |
| extension | 136 |
| state | 64 |
| ui | 51 |
| utils | 38 |
| config | 26 |
| Các nhóm khác | 96 |

Wrapper yêu cầu concurrency=4 từ npm script nhưng clamp `=N` xuống 2 vô điều
kiện. Comment “local unaffected” không khớp implementation.

Wrapper mở rộng glob thành toàn bộ filename trước `spawnSync`. Phần filename
là 42.157 ký tự, hoặc 43.895 khi quote từng path, chưa tính mọi executable/flag.
Giới hạn Windows command line khoảng 32.767 ký tự: thêm `--test-shard` nhưng
vẫn truyền full list không xử lý được giới hạn trước-spawn này.
**Chưa chạy Windows để tái hiện lỗi.**

### 5.2. Native sharding

Node v22.23.1 hỗ trợ recursive glob, sort danh sách và chọn theo:

```text
index % shard.total === shard.index - 1
```

Danh sách hiện tại cho 218/217/217/217 file. Đây không phải duration balancing.
Không suy rộng capability của patch version đã đọc thành mọi minor Node 22.

Hướng triển khai ưu tiên: chốt Node đã kiểm chứng, truyền glob ngắn trực tiếp,
dùng native shard, giữ concurrency=2. Nếu wrapper tự chọn subset trước spawn
thì không được shard lần nữa ở Node. Chuẩn hóa quoting trên npm/cmd.exe.

### 5.3. Topology và proof

- Ba OS × bốn unit shard; integration vẫn tuần tự trên từng OS.
- Gate/build/bundle/pack có prerequisite rõ; output giữa các job không tự chia sẻ.
- Check tổng hợp với `if: always()` chỉ xanh khi mọi dependency bắt buộc success.
  Kiểm tra required checks/branch protection khi đổi tên job.
- Union file đã thực thi phải bằng census, intersection giữa shard phải rỗng.
- Missing report, zero test ngoài dự kiến, timeout, killed coordinator đều đỏ.
- Thu duration từng file trước khi cân shard theo thời gian.

Sharding không giảm 869 lần startup process/loader/import graph. Nó phân phối
công việc trên runner riêng. Số ~737 giây Linux là **HISTORICAL** từ comment
wrapper; 184 giây là giới hạn lý tưởng khi chia đều bốn phần, không phải kết quả
thực đo hoặc cam kết tốc độ CI. Setup/queue/integration vẫn góp vào critical path.

## 6. BR-04: tách byte, Git artifacts và worker-ready latency

Nguồn:

- `scripts/build-bundle.mjs`
- `scripts/check-bundle-size.mjs`
- `scripts/check-bundle-staleness.mjs:69`
- `bench/b7-startup.bench.ts`
- `bench/results/2026-09-17T11-42-11-761Z.json`
- `dist/build-meta.json`

### 6.1. Số đo byte trong phiên nghiên cứu

| Chỉ số | Byte / tỷ lệ |
|---|---:|
| index.mjs hiện tại | 3.437.867 |
| index.mjs.map | 8.287.610 |
| build-meta.json | 784.872 |
| Budget thực, 3,5 MiB | 3.670.016 |
| Tỷ lệ sử dụng budget | 93,67%, không phải 98,4% |
| Transform minify trong RAM | 1.698.699; giảm 50,59% |
| Transform minify + keepNames | 1.818.036; giảm 47,12% |

Transform bundle hiện có không phải full production build hoặc boot benchmark.
Không suy ra tốc độ từ tỷ lệ giảm byte.

Tổng hợp `bytesInOutput`: code dự án 2.868.586 B, khoảng 83,44% toàn bundle;
TypeBox 283.399 B; AJV và dependency liên quan khoảng 242.252 B.
Không có một dependency duy nhất giải thích phần lớn dung lượng.

TypeBox được vendor có chủ đích để tránh stale hoisted dependency thiếu
`TypeRegistry`. Không externalize chỉ để lấy vài trăm KB.

### 6.2. Lazy loading và measurement gaps

- Local dynamic import có thể thành `Promise.resolve().then(() => init_module())`
  trong một bundle. Hoãn initialization không đồng nghĩa tách code khỏi file.
- External `esbuild`, `acorn`, Pi peers còn có static imports.
- `src/extension/registration/wire-cross-extension.ts:30` có eager trigger
  team-tool khi đăng ký; splitting có thể chỉ dời tải sang startup microtask.
- b1 đo Pi `--version`, không phải worker ready.
- b7 đo spawn Node → import graph → exit; RSS “child” lấy từ process cha.
- `scripts/profile-startup.mjs:73` không await đầy đủ registration async.
- `src/runtime/task-runner/child-executor.ts:856` dựng startup evidence sau khi
  child kết thúc; không thay thế timestamp ready/accept prompt.

### 6.3. Hướng giải quyết

Minify + giữ tên là bước size optimization hợp lý; không property-mangle.
Chạy bundle-load, TypeBox, lazy boundary, worker path và tarball checks khi
implementation. Nếu bỏ map/metafile khỏi Git, phải đổi gate so sánh ba artifact
cùng lúc. Npm whitelist hiện chỉ ship `dist/index.mjs`; untrack file phụ chủ yếu
giảm Git churn, không phải tiết kiệm thêm boot.

Đo các mốc monotonic riêng: spawn, import, registration done, ready/accept prompt,
first model event. Tách process mới, peer graph cached/uncached và concurrency
1/fanout. Chỉ dùng Amdahl khi biết phần thời gian thực sự bị tác động.

Falsifier: giảm byte nhưng ready không đổi thì parse bundle không phải nút thắt
chi phối trong workload đó. Chưa có cơ sở triển khai warm pool trước phép đo.

## 7. BR-05: workflow nhẹ phải tối ưu chi phí hoàn tất, không chỉ lượt đầu

Nguồn:

- `src/schema/team-tool-schema.ts:136`
- `src/extension/team-tool/plan.ts:25`
- `src/extension/team-tool/run-intent.ts:241–285,339`
- `src/extension/team-tool/chain-executor.ts:203`
- `src/workflows/preflight-validator.ts:111–146`
- `workflows/fast-fix.workflow.md`

`singleAgent: true` chỉ compose prompt cho `action=plan`. `run` đã có đường
direct-agent khi chỉ định `agent`, tạo workflow một task. Có thể tận dụng đường
này thay vì tạo runtime mới.

Phân biệt:

| Lựa chọn | Semantics |
|---|---|
| Direct agent | Một worker, vẫn có orchestration/state |
| Workflow execute → verify | Hai worker, giữ verifier độc lập |
| Chain hai bước | Mỗi bước là một team run, không đảm bảo chỉ hai worker |

Fast-fix ba bước trả chi phí boot, context, model/tools, persistence và handoff
ở từng bước. Gộp explorer vào executor giảm một lần setup nhưng chuyển khám phá
sang executor. Bỏ verifier có thể tăng rework. Metric đúng là thời gian/token/cost
để đạt yêu cầu, cộng tỷ lệ phải sửa lại.

Không route bằng độ dài goal: “sửa auth” ngắn nhưng không trivial. Dùng phạm vi
file, tính độc lập công việc, yêu cầu verification, state/concurrency/security
risk và lựa chọn rõ ràng của người dùng.

Giai đoạn đầu chỉ gợi ý, không tự switch. Không suy rộng các tỷ lệ “30×”, “5.7×”
hardcode trong preflight từ một số run cũ thành dự báo chung.

## 8. BR-06: cache context có lỗi key và lifetime

Nguồn:

- `src/runtime/task-runner/prompt-builder.ts:161–222`
- `src/runtime/task-runner/retrieval-orchestrator.ts:250`
- `src/runtime/team-runner.ts:580`

Cross-run key là `(cwd, step.task)` nhưng computation phụ thuộc cả
`manifest.goal` và role trong knowledge fragment.

**PROBE R7:** tạo fixture repo có file auth/billing; gọi helper cho hai run cùng
`step.task="Implement {goal}"` nhưng goal khác nhau, trước khi clear cache:

```json
{"cachedSecondEqualsFirst":true,"cachedSecondDiffersFromFreshSecond":true,"firstMentionsAuth":true,"freshSecondMentionsBilling":true}
```

Run B dùng suggested-files của goal A. Xóa cache rồi tính B lại cho kết quả khác.
Đây là probe helper, không phải live team run. Production clear ở cuối run,
nên rủi ro đặc biệt liên quan các run chồng lấn trong cùng process/cache lifetime,
không phải mọi cặp run tuần tự đều sai.

`clearStablePrefixCache()` còn clear cả hai map toàn cục khi một run kết thúc:
vừa làm mất cache của run khác, vừa triệt tiêu lợi ích cross-run tuần tự được
comment mô tả.

**Đề xuất:** tách workspace inventory, retrieval query, knowledge và per-run
cache. Key chứa đúng inputs; invalidation per-run; shared cache có TTL/size cap;
dedupe in-flight theo cùng key. Không chỉ tăng TTL hoặc thêm map mới.

## 9. BR-07/08/09: correctness trước khi mở rộng persistence và scheduling

### BR-07: shallow-copy mảng không tách mutable object

Nguồn: `src/runtime/crew-agent-records.ts:292`,
`src/state/atomic-write.ts:1009,1161`.

**PROBE R6:** queue agents bằng coalesced write, đọc qua `readCrewAgents`, copy
mảng rồi sửa nested usage, flush:

```json
{"arrayAlreadyCopied":true,"recordAliased":true,"nestedAliased":true,"persistedOutputTokens":99}
```

`filter()` đã tạo outer array mới; item và nested object vẫn chia sẻ pending
write. Nội dung sửa qua read được persist dù không gọi save lần nữa.
Chưa tìm thấy caller production hiện gây mutation, nên không gọi đây là sự cố
data corruption đã xảy ra trên run thật.

Giải pháp phải xác định ownership/immutable snapshot hoặc clone tại đúng boundary.
Deep-clone mỗi render tick một cách mù quáng có thể trả lại chi phí allocation.
Acceptance phải sửa cả scalar và nested fields trên kết quả đọc rồi kiểm tra
pending/durable state không bị ảnh hưởng.

### BR-08: cursor offset phải đại diện cho dữ liệu đã giao

Nguồn: `src/state/event-log/cursor.ts:533–565`,
`src/utils/incremental-reader.ts:122`.

**PROBE R5:** file 5 event, đọc `fromByteOffset=0, limit=2`:

```json
{"firstSeq":[1,2],"secondSeq":[],"nextOffsetAtEnd":true,"totalFileEvents":5}
```

Helper đọc hết delta, cắt items theo limit nhưng trả byte offset sau toàn bộ
delta. Lần tiếp theo mất khả năng nhận 3 event chưa giao qua continuation đó.
Search `src` chưa thấy caller production truyền `fromByteOffset`; event-bus và
broker replay hiện dùng `sinceSeq/limit`. Không kết luận run thật mất event qua
nhánh này.

Trước US-011 phải định nghĩa continuation và backpressure theo bytes/events.
Chunk size 64 KB không tự tạo memory cap nếu helper vẫn allocate toàn bộ delta.
Rotation/archive cần continuation đủ mô tả phần đã giao, không chỉ EOF live file.

### BR-09: shadow discriminator không nên dựa vào tên agent

Nguồn: `src/runtime/broker/delegate/shadow-lifecycle.ts:34`,
`src/runtime/dispatch-batch.ts:338,428`.

`agent === "delegate"` loại cả workflow task hợp lệ dùng agent tên đó.
Nguồn gốc broker/task identity phải phân biệt shadow với task thường.
`gc-` chỉ là lựa chọn tối thiểu nếu có invariant namespace và kiểm thử; explicit
ownership field cần tính compatibility cho state cũ.

Acceptance: workflow agent tên delegate vẫn dispatch; shadow queued/running
không vào DAG; promotion/terminal lifecycle giữ nguyên. Không reserved-name
validation làm hỏng resource người dùng mà không có quyết định compatibility.

## 10. BR-10/11: các khoản còn treo và backlog drift

### Những việc nhỏ nhưng cần proof đúng

- Pin fallow thay vì `npx --yes fallow@latest`; dependency có lockfile tốt hơn
  tải một phiên bản nổi trong CI. Đây là supply-chain/reproducibility, không phải
  lời hứa giảm đáng kể test wall time.
- `parseAndValidateCommand` đang whitespace-split. Ưu tiên schema `program` +
  `args[]`, giữ allowlist và `execFileSync`; không bật shell để chữa quoted args.
- Shallow-copy, terminal fsync trong coalesced path, lastWrittenStatus single-writer,
  sweep-before-cap cần được biến thành invariant/test khi sửa, không chỉ comment.
- “Mutation-verified” phải có lần test đỏ khi áp mutation; đọc pattern không đủ.
  Bản review này không tái chạy mutation smoke của F05.

### Backlog cần cập nhật scope, không tự đánh dấu completed chỉ từ tên module

| Mục | Hiện trạng | Việc còn cần xác định |
|---|---|---|
| US-003 DLQ | Có deadletter store, max-retries và heartbeat wiring | Khoảng trống vận hành/replay/retention nếu có |
| US-012 model cache | Có cache mtime/size, scope agentDir/cwd, cap 32 | Invalidation và freshness contract |
| US-020 dashboard | Có interactive dashboard và test | UX gaps cụ thể thay vì xây lại |
| US-022 Markdown export | Đã export JSON/Markdown | Independent evidence archive là yêu cầu khác |
| US-011 stream log | Có cursor/tail/cache | Caller adoption, correctness, bounded delta |
| US-002 lock cleanup | Có finally/token release và RR-011 | Vòng đời deletion/resume chưa cùng protocol |
| US-010 sleepSync | Bình thường dùng Atomics.wait, không CPU busy-spin | Vẫn chặn event loop; đo contention và audit từng sync/async boundary |
| US-001 lock-free rotation | Có rotation/generation/archive semantics | Chứng minh contention trước khi đổi lock model |

ADR giữ sync retry đã tồn tại; không thay `sleepSync` hàng loạt thành `await`
hoặc dùng lại luận điểm “không busy-spin nên không chặn UI”. Không mở lại RR-010
đến RR-019 chỉ vì backlog khác còn planned; proof của remediation cần được đánh
giá riêng theo working tree hiện tại.

## 11. BR-12: tạo `.crew/` ở project root, đặt trong `.pi/` có ổn hơn không?

### 11.1. Hành vi hiện tại đã xác minh

Nguồn: `src/utils/paths.ts:238`, `src/state/crew-init.ts:194`,
`src/state/gitignore-manager.ts:59`.

| Project hiện có | projectCrewRoot chọn |
|---|---|
| Không có cả hai | `.crew/` |
| Chỉ có `.pi/` | `.pi/teams/` |
| Chỉ có `.crew/` | `.crew/` |
| Có cả `.crew/` và `.pi/` | **`.crew/`** |

Cả bốn case đã chạy fixture và assert. Tạo thêm `.pi/` sau khi `.crew/` đã có
không thay đổi location. Tài liệu kiến trúc mô tả nhánh legacy `.pi/teams` nhưng
chưa thể hiện rõ toàn bộ precedence khi cả hai tồn tại.

`.pi/teams` là namespace riêng dưới `.pi`, không phải ghi `state/`, `artifacts/`
trực tiếp lẫn với `.pi/settings.json`, skills hay extensions khác.

### 11.2. Không chỉ team run mới có thể tạo `.crew`

**PROBE L1:** project fixture mới có `package.json`, không `.crew`, không run.
Gọi đúng helper startup maintenance dùng, `pruneFinishedRuns(cwd, 10)`:

```json
{"before":false,"after":true,"removed":0,"auditCreated":true,"gitignoreCreated":false}
```

`appendPruneAudit` gọi mkdir + append ngay cả khi không có ứng viên. Vì startup
gọi helper này, một session chưa chạy team vẫn có đường tạo `.crew/audit/prune.jsonl`
mà không đi qua initializer/gitignore setup.

Đây là bằng chứng helper và đường caller tĩnh, chưa launch một Pi session mới
để quay lại toàn bộ E2E. Nó giải thích vì sao sửa duy nhất “first team run init”
không đủ để chặn thư mục ngoài ý muốn.

`run-intent.ts:183–184` còn gọi `ensureCrewDirectory` trước khi tạo manifest.
Initializer tạo nhiều directory/placeholders, overwrite README và cập nhật
`.gitignore`. Cần tách **resolve path** khỏi **materialize layout** và chỉ tạo
phần cần dùng ở lần ghi thực sự hoặc explicit init.

### 11.3. Resolver và initializer chưa cùng định nghĩa project root

`paths.ts` nhận `.git`, `.pi`, `.crew` và nhiều marker khác. Bản inline trong
`crew-init.ts:166` chỉ nhận một tập nhỏ hơn. Bản inline có lý do lịch sử
jiti/ESM namespace race; không nên xóa nó bằng một static import tùy tiện.

**PROBE L2:**

```text
parent/.git/
parent/subproject/.pi/
```

Gọi với cwd=`subproject`:

```json
{"resolverSelected":"subproject/.pi/teams","initializerCreatedParentCrew":true,"resolverSelectedStateCreated":false}
```

Runtime resolver và initializer có thể tạo/đọc hai root khác nhau. Cần thống nhất
contract root resolution hoặc giữ hai implementation nhưng có parity tests dùng
cùng fixture matrix, kể cả nested project, worktree và symlink boundary.

### 11.4. Đường cleanup legacy chưa nhận diện `.pi/teams`

Nguồn:

- `src/runtime/model/pi-args.ts:605–666`
- `src/extension/team-tool/health-monitor.ts:119–131`

`cleanupLegacyOrphanTempDirs` chỉ dùng sự tồn tại `.crew` làm một guard.
Health scanner cũng có đường hardcode `.crew/state/runs`.

**PROBE L3:** scan một tmp root tổng hợp, không phải `/tmp` thật. Hai directory
đều tên `pi-crew-*`, mtime 10 ngày, chứa manifest tổng hợp; một ở `.crew`, một
ở `.pi/teams`; không directory nào thuộc `createdTempDirs` của process:

```json
{"scanned":2,"cleaned":1,"failed":0,"crewSurvives":true,"piTeamsSurvives":false}
```

**Phạm vi:** đường legacy temp cleanup với prefix/age này, không phải mọi project
dùng `.pi` đều bị xóa. Nhưng nó chứng minh không được đổi default sang `.pi`
trước khi audit cleanup/scanner parity. Layout `.pi/teams` đã được hỗ trợ nên
đây cũng là gap hiện hữu, không chỉ một rủi ro migration tương lai.

### 11.5. Lợi ích và giới hạn khi đặt dưới `.pi`

| Khía cạnh | Đánh giá |
|---|---|
| Project root gọn hơn | Có: gom Pi tooling vào một hidden root |
| Nhất quán với config Pi | Có: project config đã có `.pi/pi-crew.json` |
| Dễ hiểu ownership | Có nếu giữ namespace `.pi/teams`, không trộn trực tiếp vào `.pi` |
| Tốc độ I/O/boot | Không có lợi ích đáng kể chỉ vì thêm/đổi một path segment |
| Bảo mật | Hidden folder không phải security boundary; vẫn cần ignore, permission, redaction |
| Không ghi vào project | **Không**: `.pi` vẫn ở trong project; external state là yêu cầu khác |
| Worktree/readonly repo | Vẫn phải thiết kế root, ownership và fallback; đổi tên không giải quyết |
| Tự sửa retention | Không: policy cleanup phải được sửa độc lập |
| Compatibility | `.pi/teams` đã có nền hỗ trợ, nhưng chưa parity đầy đủ |

Không ignore cả `.pi/`: trong đó có thể có config/resources cần commit.
`gitignore-manager.ts` cho phép artifacts/graphs trên `.pi/teams` layout, trong
khi `project-init.ts:132` thêm ignore cho artifacts. Hai đường đang thể hiện
policy khác nhau. Phải kiểm chứng bằng `git check-ignore`, không chỉ tìm chuỗi
trong `.gitignore`, trước khi hứa runtime data không bị commit.

### 11.6. Phương án đề nghị

**Khuyến nghị:** project mới dùng `.pi/teams/`, existing layout không tự đổi.
Không thêm `.pi/crew` hoặc `.pi/pi-crew` lúc này chỉ vì tên đẹp hơn: sẽ thành
layout thứ ba cần discovery, migration và support.

Thực hiện theo thứ tự:

1. **No-op không materialize:** auto-maintenance không tạo root/audit nếu chưa có
   crew data. Explicit init hoặc first actual write mới tạo layout cần thiết.
2. **Resolver parity trước:** init, discovery, state, artifact, worktree,
   health, cleanup và ignore dùng cùng contract. Đóng gap legacy temp cleanup.
3. **Định nghĩa layout ổn định:** tồn tại `.pi` không được tự chuyển một repo đang
   dùng `.crew`; cả hai có data phải báo rõ, không âm thầm merge.
4. **Đổi default chỉ cho project mới**, sau ADR/confirmation và test matrix.
   Sửa prompt/workflow/tooling hardcode `.crew` thành resolved path phù hợp.
5. **Migration explicit cho repo cũ:** dry-run → archive/backup → dừng hoặc
   refuse active/blocked/delegated runs → kiểm tra collision → migrate/validate
   → chuyển ownership root một lần. Không auto-migrate ở session_start.

Schema/config chọn layout hoặc migration command chưa tồn tại trong đề xuất
này; không được trình bày chúng như tính năng đang có.

### 11.7. Vì sao không thể chỉ `mv .crew .pi/teams`?

`src/state/stores/state-store.ts:231–245` kiểm tra equality của `stateRoot`,
`tasksPath`, `eventsPath`, `artifactsRoot` với path đã resolve. Manifest cũ chứa
absolute path. `src/state/stores/active-run-registry.ts:19` cũng lưu
`stateRoot/manifestPath`. Worktree có metadata riêng của Git.

Migration phải:

- Không overwrite `.pi/settings.json`, `.pi/pi-crew.json`, resource hay target data.
- Rewrite **các field path đã định nghĩa**, không replace mọi chuỗi trong log/goal.
- Cập nhật registry/cache/locator và validate load được manifest sau chuyển.
- Xử lý Git worktree bằng cơ chế Git phù hợp; không raw-move cả registered worktree.
- Giữ bản cũ/backup cho rollback; phát hiện partial migration sau crash.
- Ngăn writer phiên bản cũ ghi lại vào root cũ khi host khác đã chuyển.
- Không dùng symlink như shortcut thay cho migration; containment/symlink guards
  của state/artifact có thể từ chối hoặc làm semantics không rõ.

Giảm scope an toàn ban đầu: hỗ trợ default mới cho project chưa có dữ liệu,
giữ dual-layout compatibility cho existing project. Migration worktree/active
state là story riêng high-risk, không nhét vào một patch đổi default.

### 11.8. Acceptance cho layout

| Case | Hợp đồng cần chứng minh |
|---|---|
| Project sạch, chỉ startup/read/no-op maintenance | Không tạo crew root chỉ để ghi audit rỗng |
| Project mới, lần run đầu sau đổi default | Chỉ materialize namespace `.pi/teams` đã chọn |
| Chỉ `.crew` tồn tại | Giữ `.crew`, không fork state |
| Chỉ `.pi/teams` tồn tại | Dùng layout đó cho mọi consumer |
| Cả hai chứa data | Chọn theo policy rõ + cảnh báo, không auto-merge |
| Nested `.pi`, monorepo, `.git` file worktree | Init và runtime resolve cùng root |
| Legacy temp cleanup | Nhận diện cả hai layout, không xóa run state như debris |
| Ignore | Runtime/log/transcript không bị commit mặc định; config/resources vẫn dùng được |
| Migration có active/blocked run hoặc dirty worktree | Refuse/dry-run, không mất dữ liệu |
| Target collision/crash giữa migration | Không overwrite; có recovery/rollback |
| Sau migration | status/events/artifacts/resume/load kiểm chứng được trên fixture |
| Windows/macOS, symlink, readonly project | Không giả định path/permission chỉ theo Linux |

**Lane:** no-op write reduction có thể tách scope nhỏ; thay default/layout
resolution và migration là **high-risk** do state format/path, concurrency,
compatibility và worktree. Cần xác nhận trước implementation.

## 12. Lộ trình đề xuất và điều kiện dừng

| Đợt | Phạm vi | Điều kiện hoàn tất |
|---|---|---|
| A | Retention chung, no-op maintenance, independent evidence, cleanup layout parity | Fixture data-protection xanh; archive sống độc lập; chưa đổi root data thật |
| B | Test discovery/argv rồi CI shards | Đủ file/case, fail-closed, parity ba OS, duration reports |
| C | Cache key/lifetime và mutable snapshot boundary | Không cross-goal pollution; không mutation qua read; không global clear sai scope |
| D | Minify và artifact/hash gate | Byte budget + shipped bundle proof; không hứa boot gain chưa đo |
| E | Worker-ready metrics và workflow nhẹ | So chi phí hoàn tất/chất lượng trên workload đại diện |
| F | Default `.pi/teams` cho project mới | ADR, resolver/scanner/ignore parity, không đổi existing project |
| Riêng | Migration existing `.crew` | Dry-run, explicit approval, backup, active-run/worktree guards, rollback |

Không chờ migration để sửa các lỗi retention hiện tại. Có thể làm B/D độc lập
với thiết kế migration; không gom toàn bộ thành một refactor lớn.

Dừng/revert một tối ưu nếu:

- Tăng context reuse nhưng trả context sai goal hoặc làm yếu isolation.
- Giảm byte nhưng phá bundle load/TypeRegistry/stack diagnosis.
- Shard nhanh nhưng mất test, thiếu report hoặc fail-open.
- Đổi layout tạo hai root hoặc cleanup một layout khác như debris.
- Giảm token lượt đầu nhưng tăng rework hoặc giảm chất lượng verification.

## 13. Validation của bản review

- Đã đọc hướng dẫn package, harness/intake, product/architecture và backlog.
- Đã chạy 7 probe của vòng nghiên cứu trước: R1–R7 nêu trong các mục trên.
- Vòng bổ sung layout: 4 case resolver và L1–L3 đã chạy trên helper thật.
- Đã đo byte/minify trong RAM, test-file census và tính argv; không sửa `dist`.
- Đã đọc source nhúng của Node cài sẵn cho sharding; chưa chạy Windows.
- Các số full-suite/live battery trong báo cáo cũ vẫn là HISTORICAL.
- Chưa chạy migration, full suite, benchmark worker-ready hoặc mutation smoke.
- Bản review không đánh dấu remediation nào là đã implement.

### Nguồn nền

- [Backlog](../stories/backlog.md)
- [Architecture](../architecture.md)
- [Feature intake và risk lanes](../FEATURE_INTAKE.md)
- [Test matrix hiện có](../TEST_MATRIX.md)
- [Review remediation battery ngày 17/9](../real-test/reports/real-test-2026-09-17-review-remediation.md)
- [ADR sleepSync](../decisions/2026-09-10-wi-7-3-sleep-sync-keep-most.md)
- [ADR cold boot](../decisions/2026-09-10-wi-2-3-cold-boot-baseline-acceptable.md)
- [Quy ước archive tài liệu có ngày](../README.md)
