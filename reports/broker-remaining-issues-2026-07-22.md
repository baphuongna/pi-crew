# Broker Branch — Remaining Issues

**Branch:** `broker-phase0-complete`
**Date:** 2026-07-22
**Status:** Feature wired end-to-end, all CI checks green (typecheck, lint, format, 6272 unit tests pass). Issues below remain unresolved.

---

## BUG

### 1. `handleSteerPush` comment sai — broker steer không có durable fallback

- **File:** `src/runtime/crew-broker.ts:1052-1056`
- **Severity:** BUG
- **Description:** Comment nói *"the broker appends to the run's tasks/\<taskId\>/steering inbox so the child's existing pollSteering() picks it up on the next tick."* Nhưng code gọi `appendMailboxMessageAsync` → ghi vào **mailbox**, không phải steering file. Child's `pollSteering()` đọc steering file (`PI_CREW_STEERING_FILE`), không đọc mailbox.
- **Impact:**
  - Broker-pushed steer CHỈ tới child qua broker push (cần connection sống).
  - Nếu broker connection down khi steer được push → steer nằm trong mailbox, child không bao giờ đọc.
  - File-poll KHÔNG phải fallback (trái ngược comment).
- **Fix options:**
  - (a) Sửa `handleSteerPush` cũng append vào steering file (để file-poll làm fallback).
  - (b) Sửa comment cho đúng + chấp nhận broker-pushed steer không có durable fallback trong Phase 0.

---

## MAJOR

### 2. `crew-broker-deps.ts` là TEMPORARY STUB

- **File:** `src/runtime/crew-broker-deps.ts`
- **Severity:** MAJOR
- **Description:** Self-labeled temporary stub. Canonical `src/utils/socket-path.ts` + `ndjson.ts` chưa bao giờ được tạo. Functionally correct nhưng nên replace bằng canonical implementations cho maintainability dài hạn.
- **Fix:** Tạo `src/utils/socket-path.ts` + `src/utils/ndjson.ts`, move logic từ stub sang, update imports.

### 3. Không có integration test end-to-end

- **Severity:** MAJOR
- **Description:** Không có test nào chứng minh full path: parent spawn child → child nhận broker credentials → broker push steer → child nhận + deliver qua `pi.sendMessage`. Các unit test chỉ test từng component riêng lẻ.
- **Fix:** Viết integration test spawn real child với broker credentials, verify steer delivery end-to-end.

### 4. Env-stripping fix thiếu regression test

- **File:** `src/runtime/child-pi.ts:419`
- **Severity:** MAJOR
- **Description:** Fix `spawnOptions.env = { ...spawnOptions.env, ...builtEnv }` là behavioral change lớn (mọi `PI_CREW_*`/`PI_TEAMS_*` control key giờ tới child). Không có test nào guard against regression — nếu ai revert spread, bug silently trả lại.
- **Fix:** Viết test assert `PI_CREW_STEERING_FILE`/`PI_CREW_KIND`/`PI_CREW_BROKER_TOKEN` survive `buildChildPiSpawnOptions` + spawn-site spread.

---

## MINOR

### 5. Child broker handle không close trên shutdown

- **File:** `src/prompt/prompt-runtime.ts:264`
- **Severity:** MINOR
- **Description:** `startChildBrokerClient(...)` discard handle trả về, không gọi `close()` trên shutdown. `sock.unref()` mitigates event-loop blocking nhưng socket + listeners vẫn tồn tại đến process exit.
- **Fix:** Capture handle, close trên `pi.on("shutdown")` (hoặc tương đương).

### 6. Duplicate types `CrewBrokerSpawnContext` vs `BrokerSpawnCredentials`

- **Files:** `src/extension/registration/lifecycle-handlers.ts:794` vs `src/runtime/broker-issuer.ts:18`
- **Severity:** MINOR
- **Description:** Hai interface structurally identical (`{socketPath: string, token: string}`). TypeScript structural typing chấp nhận nhưng là code smell.
- **Fix:** Dùng một type duy nhất (prefer `BrokerSpawnCredentials` ở `broker-issuer.ts`).

---

## PLAN-LEVEL (không phải code)

### 7. `events.since` Phase 1.5 lệch spec §7 Phase 2 ordering

- **Severity:** PLAN-LEVEL
- **Description:** Impl plan có Phase 1.5 implement `events.since` trước Phase 2's `events.subscribe`, deviate từ spec's intended ordering.
- **Fix:** Update plan hoặc update spec để align.

### 8. §1.3 sync→async notifier mechanism unspecified

- **Severity:** PLAN-LEVEL
- **Description:** Plan §1.3 mô tả sync→async transition cho mailbox notifier nhưng không specify mechanism.
- **Fix:** Specify mechanism trong plan.

---

## Ưu tiên trước merge

1. **#1** — broker steer durable fallback + comment sai
2. **#4** — env fix regression test
3. **#3** — integration test end-to-end (nên có để chốt loop)
