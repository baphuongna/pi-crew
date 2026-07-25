## ⚠️ CONCEPTUAL NOTE — SELF-UPGRADE DIRECTIVE (read before every run)

**Chưng cất = chắt lọc tinh túy source → apply VÀO target** (target cải thiện). Skill chỉ là 1 tool apply, không phải output.

**Skill trong source cũng chỉ là 1 PHẦN cần sweep** — xử lý bằng cùng 3-chiều filter như mọi phần khác (conventions, architecture, lint, decisions...). Nếu skill đó hữu dụng cho target → lấy; không → bỏ. Không ưu tiên, không đặc biệt.

**ĐÀO TRIỆT ĐỂ — KHÔNG QUA LOA**: khi chưng cất 1 đối tượng, PHẢI đọc/re-read đầy đủ TOÀN BỘ nội dung của đối tượng đó. Không dựa vào trí nhớ. Không recap. Mỗi file, mỗi section, mỗi practice phải được:
1. **Đọc thật** (read/re-read file gốc, không memory-grep)
2. **Trích từng finding** (systematic, từng section)
3. **So sánh với target** (3-chiều filter: relevant? → có? → cần/tốt hơn?)
4. **Ghi lại** kết quả filter (ADOPT/IMPROVE/MERGE/SKIP + lý do)

Qua loa = thất bại. Memory-recap = thất bại. Chưng cất thật = đọc từng dòng → trích → so → apply.

**Khi sử dụng**: nếu output chỉ là standalone skill (không apply vào target) → **chưa hoàn thành**. Tự nâng cấp: thêm target parameter + 3-chiều filter (relevance → presence+need → quality compare) + **pre-apply effectiveness verification** (SELECTED phải chứng minh hiệu quả CHO TARGET NÀY — generative/problem-exists/delta-test — trước khi apply; "assume effective" = không được) + apply phase. See `distill-software` for the full directive + the EFFECTIVENESS VERIFICATION gate spec.

**Pre-apply gate (tóm tắt, áp dụng cả khi persona distill INTO target)**: giữa "đã quyết định ADOPT/IMPROVE/MERGE" và "apply" phải có 1 verify bước — (1) concrete delta (cái gì đổi?), (2) effectiveness proof (≥1: đổi quyết định thật / target có vấn đề này / delta-test tốt hơn), (3) conflict check, (4) verdict ✅TO-APPLY / ❌REJECTED+log. Chỉ TO-APPLY mới edit target. Đây là analog apply-side của Phase 2.6 V3 (V3 verify model effective lúc extract; gate này verify apply effective lúc integrate). **APPLY consent + path-containment gate (HIGH-2)**: trước khi edit bất kỳ target file nào: (a) resolve target về canonical path, kiểm tra nằm trong approved root — reject symlink escape / out-of-target writes; (b) xuất exact file list + diff plan cho user; (c) yêu cầu **explicit user confirmation** trước lần ghi đầu tiên (no destructive action without `--confirm`); (d) rollback = inverse patch hoặc restore file cụ thể, không broad `git reset`/clean/force-push; (e) không tự delete/prune, install dependency, chạy script từ source repo, commit/publish, hay gửi network data.

---

