# Loadout Full + Nested Spawning + Worker Messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker pi-crew là pi session đầy đủ như main session (không cắt xén), delegate mở cho mọi role (child tạo được child), và worker có `message` tool (notify + DM + group) theo spec v0.7 §6, D5/D8/D9, §15.

**Architecture:** Đổi spawn args mặc định trong `buildPiWorkerArgs` (bỏ 3 lock, restriction thành opt-in theo frontmatter `tools:`), mở gate đăng ký `delegate` tool cho mọi role giữ depth cap, thêm `message` tool worker-side chạy trên broker `msg.send` có sẵn. Không đụng surface/multiplexer — plan đó tách riêng.

**Tech Stack:** TypeScript (strip-types, no build cho test), node:test, pi extension API (`pi.registerTool`, `pi.on`).

**Spec:** `docs/superpowers/specs/2026-08-26-mux-surface-design.md` (v0.7) — §6, §2 D5/D8/D9, §15.

## Global Constraints

- Pi từ chối argv flag lạ — KHÔNG thêm flag CLI mới cho worker; mọi signal dùng ENV (`pi-args.ts:260` comment).
- Node test runner: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 <file>`.
- Sau mỗi task: `npm run typecheck` phải sạch.
- Commit message kiểu conventional (`feat:`, `fix:`, `test:`, `docs:`), kèm `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Worker event types phải khớp `/^worker\.[a-z0-9_.-]{1,63}$/` (schema gate của worker-events-channel).
- `usage-tracker` roll-up delegate grandchild phải không đổi hành vi (chỉ nới gate, không đụng accounting).

---

### Task 1: Loadout full mặc định trong buildPiWorkerArgs

**Files:**
- Modify: `src/runtime/model/pi-args.ts:259-397` (buildPiWorkerArgs)
- Test: `test/unit/runtime/model/pi-args-loadout.test.ts` (create)

**Interfaces:**
- Consumes: `AgentConfig` (đã có fields `tools?: string`, `extensions?: string[]`, `inheritSkills?: boolean`, `source`).
- Produces: `buildPiWorkerArgs` trả args **không có** `--no-extensions`/`--no-skills`/`--tools`/`--exclude-tools` khi agent không khai `tools:`; khi agent CÓ khai `tools:` → `--tools <khai-báo>,ask` (+`,delegate` nếu env depth cho phép). `--extension PROMPT_RUNTIME_EXTENSION_PATH` vẫn luôn có. `agentExtensions` config vẫn honored (thêm vào sau prompt-runtime).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/runtime/model/pi-args-loadout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPiWorkerArgs } from "../../../src/runtime/model/pi-args.ts";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: { type: "inline" },
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

test("default loadout is FULL session: no --no-extensions/--no-skills/--tools", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: do it", agent: agent() });
	assert.ok(!args.includes("--no-extensions"), "must not disable extension discovery");
	assert.ok(!args.includes("--no-skills"), "must not disable skills discovery");
	assert.ok(!args.includes("--tools"), "must not restrict tools when agent declares none");
	assert.ok(!args.includes("--exclude-tools"), "must not exclude tools by default");
	assert.ok(args.some((a, i) => a === "--extension" && args[i + 1]?.includes("prompt-runtime")), "prompt-runtime must stay");
});

test("explicit frontmatter tools → lock + auto-add control tools", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent({ tools: "read,grep" }) });
	const idx = args.indexOf("--tools");
	assert.ok(idx >= 0, "--tools must be present when declared");
	const list = args[idx + 1]!.split(",");
	assert.ok(list.includes("read") && list.includes("grep"), "declared tools present");
	assert.ok(list.includes("ask"), "ask control tool auto-added");
	assert.ok(list.includes("delegate"), "delegate control tool auto-added");
});

test("inheritSkills:false vẫn tắt skills khi agent khai explicit", () => {
	const { args } = buildPiWorkerArgs({ task: "Task: x", agent: agent({ inheritSkills: false }) });
	assert.ok(args.includes("--no-skills"), "explicit inheritSkills:false still disables skills");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=60000 test/unit/runtime/model/pi-args-loadout.test.ts`
Expected: FAIL — args hiện chứa `--no-extensions`, `--tools`.

- [ ] **Step 3: Implement trong buildPiWorkerArgs**

Sửa `src/runtime/model/pi-args.ts` (giữ nguyên phần model/thinking/session):

```typescript
// Sau phần model/thinking hiện có, THAY block tool-policy + extension:

// D5 (spec v0.7 §6): default loadout = FULL session (như main session).
// --no-extensions/--no-skills/--tools CHỈ xuất hiện khi agent .md khai explicit.
const CONTROL_TOOLS = ["ask", "delegate"] as const;
if (input.agent.disableTools === true) {
	args.push("--no-tools"); // capability-locked agents giữ hành vi (goal-judge)
} else {
	const declared = input.agent.tools?.split(",").map((t) => t.trim()).filter(Boolean) ?? [];
	if (declared.length > 0) {
		const allow = new Set<string>([...declared, ...CONTROL_TOOLS]);
		args.push("--tools", [...allow].join(","));
	}
	// declared rỗng → KHÔNG truyền --tools (full default toolset — pattern
	// buildSubagentToolAllowlist của pi-interactive-subagents index.ts:809-811).
}
// prompt-runtime extension luôn nạp (hạ tầng phối hợp — không phải cắt xén).
args.push("--extension", PROMPT_RUNTIME_EXTENSION_PATH);
for (const ext of input.agent.extensions ?? []) args.push("--extension", ext);
// KHÔNG còn --no-extensions (extension discovery hoạt động như main session).
if (input.agent.inheritSkills === false) args.push("--no-skills");
for (const skillPath of input.skillPaths ?? []) args.push("--skill", skillPath);
```

Xóa đoạn cũ: `resolveToolPolicy` call + `--no-extensions` push + block `allowed = []` ADR-5 allowlist (giữ denylist excludeExtensions nếu muốn — đơn giản nhất: xóa, vì discovery giờ mở theo D5). Giữ `disableTools` branch.

- [ ] **Step 4: Run test mới + toàn bộ test pi-args hiện có**

Run: `node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000 test/unit/runtime/model/pi-args-loadout.test.ts` → PASS.
Run: `grep -rln "buildPiWorkerArgs" test/unit | xargs node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000` → các test cũ assert `--no-extensions` mặc định sẽ FAIL — cập nhật expectation của chúng theo hành vi mới (đây là breaking-change có chủ đích, spec §6). Sửa từng assertion sai về mặt ngữ nghĩa (mặc định giờ là full), KHÔNG xóa test — đảo expectation.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/runtime/model/pi-args.ts test/unit/runtime/model/pi-args-loadout.test.ts
git commit -m "feat(loadout): worker = full pi session by default (D5) — restriction opt-in via frontmatter tools:

- drop --no-extensions/--no-skills/role --tools from default spawn
- explicit frontmatter tools → lock + auto-add ask/delegate control tools
- prompt-runtime extension always appended
- Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: maxDepth default 2 → 4 (D8)

**Files:**
- Modify: `src/runtime/model/pi-args.ts:20` (`DEFAULT_MAX_CREW_DEPTH`)
- Test: extend `test/unit/runtime/model/pi-args-loadout.test.ts`

**Interfaces:** Consumes `resolveCrewMaxDepth` (giữ nguyên logic, chỉ đổi hằng).

- [ ] **Step 1: Failing test** — thêm vào file test Task 1:

```typescript
import { resolveCrewMaxDepth } from "../../../src/runtime/model/pi-args.ts";

test("default max depth is 4 (child creates child creates child)", () => {
	assert.equal(resolveCrewMaxDepth(undefined, {}), 4);
});
```

- [ ] **Step 2: Run** → FAIL (hiện = 2).
- [ ] **Step 3:** `const DEFAULT_MAX_CREW_DEPTH = 4;` (kèm comment: D8 spec v0.7 — nested mở; cap giữ để chống runaway).
- [ ] **Step 4: Run** → PASS. Chạy `grep -rln "maxDepth\|MAX_CREW_DEPTH" test/unit | xargs node --experimental-strip-types --test --test-concurrency=1 --test-timeout=120000` — sửa expectation nào Assume 2.
- [ ] **Step 5:** `npm run typecheck && git add -u && git commit -m "feat(nesting): default maxDepth 2→4 (D8)"`

---

### Task 3: Delegate mở cho mọi role (D8)

**Files:**
- Modify: `src/prompt/prompt-runtime.ts:960-964` (`shouldRegisterDelegateTool` gate) — tìm định nghĩa `shouldRegisterDelegateTool` gần đó
- Modify: `src/runtime/child-pi/child-pi-spawn.ts:296-299` (điều kiện set `PI_CREW_DELEGATE_ENABLED`)
- Modify: `src/runtime/delegate-spawn.ts` + `src/runtime/scheduling/spawn-policy.ts` (bỏ role gate + `nesting.enabled` gate; GIỮ depth + nested-slot budget)
- Test: `test/unit/prompt/delegate-tool-roles.test.ts` (create)

**Interfaces:**
- Produces: `delegate` tool đăng ký khi `PI_CREW_DELEGATE_ENABLED === "1"` — giờ set cho **mọi** worker bất kể role; depth check (broker-side `checkCrewDepth`) vẫn chặn tại maxDepth.

- [ ] **Step 1: Failing test**

```typescript
// test/unit/prompt/delegate-tool-roles.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRegisterDelegateTool } from "../../../src/prompt/prompt-runtime.ts";

test("delegate registers for ANY role when env gate on (D8)", () => {
	assert.equal(shouldRegisterDelegateTool({ PI_CREW_DELEGATE_ENABLED: "1", PI_CREW_ROLE: "analyst" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldRegisterDelegateTool({ PI_CREW_DELEGATE_ENABLED: "1", PI_CREW_ROLE: "verifier" } as NodeJS.ProcessEnv), true);
	assert.equal(shouldRegisterDelegateTool({} as NodeJS.ProcessEnv), false);
});
```

- [ ] **Step 2: Run** → FAIL (analyst/verifier hiện bị loại).
- [ ] **Step 3:** Trong `prompt-runtime.ts`, `shouldRegisterDelegateTool` bỏ mọi check role/depth-side — chỉ còn `env.PI_CREW_DELEGATE_ENABLED === "1"`. Trong `child-pi-spawn.ts`, đổi block `if (roleAllowsDelegate) built.env.PI_CREW_DELEGATE_ENABLED = "1"` → set **unconditional** (bên cạnh ASK_ENABLED dòng 290). Trong `spawn-policy.ts`: bỏ matrix role + bỏ đọc `nesting.enabled`; admission chỉ còn `checkCrewDepth(...).blocked` + nested-slot budget acquire.
- [ ] **Step 4: Run test mới + `test/unit/runtime/broker/delegate-broker.test.ts`** (sửa fixtures nào dùng role-reject).
- [ ] **Step 5: Rủi ro biết trước (từ commit 1d4ea24b)** — commit đó tự ghi: "the delegate poll was not seen completing in the captured tail (broker-admission latency / worker exit timing) — binding is proven, broker-roundtrip is a separate runtime issue". Trước khi đóng task, chạy 1 E2E nhỏ (run thật với executor delegate 1 grandchild) và xác nhận kết quả grandchild về được task cha — nếu roundtrip vẫn đứt, đây là bug tồn tại ĐỘC LẬP với task này: ghi thành issue mới, không sửa trong task (scope discipline).
- [ ] **Step 6:** typecheck + commit `feat(nesting): delegate tool for every role; keep depth cap + slot budget (D8)`.

---

### Task 4: `message` tool worker-side (D9 / §15.2)

**Files:**
- Create: `src/prompt/message-tool.ts`
- Modify: `src/prompt/prompt-runtime.ts` (register + inbox poll gộp)
- Modify: `src/runtime/child-pi/child-pi-spawn.ts` (set `PI_CREW_MSG_ENABLED=1` cạnh ASK dòng 290)
- Test: `test/unit/prompt/message-tool.test.ts` (create)

**Interfaces:**
- Consumes: `CrewBrokerClient` generic `client.request("msg.send", { to, kind, subject, body, priority })`; mailbox fallback qua `appendMailboxMessage` (src/state/coordination/mailbox.ts — xem exact export name bằng `grep -n "export function append" src/state/coordination/mailbox.ts`).
- Produces:

```typescript
export interface MessageToolDeps { makeBrokerClient?: (o: { runId: string; taskId: string; socketPath: string; token: string }) => { request: (m: string, p: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; errorCode?: string }> }; }
export function createMessageTool(deps: MessageToolDeps = {}): { name: "message"; description: string; inputSchema: object; execute: (params: { to: "parent" | string | "group"; kind: "notify" | "message"; subject?: string; body: string; priority?: "urgent" | "normal" | "low" }) => Promise<{ status: string; text: string }> }
```

- [ ] **Step 0: Mở role gate cho msg.send (worker được phép gửi message)**

Broker hiện chỉ cho `role:'orchestrator'` gọi `msg.send` (`crew-broker.ts:244,676` — chống worker forge). Sửa `handleMsgSend`: worker role ĐƯỢC phép với 3 ràng buộc — (1) `from` luôn ghi đè bằng `conn.taskId` (bỏ mọi giá trị client gửi), (2) `to` chỉ nhận `"parent"` | taskId hợp lệ trong manifest | `"group"` (không được gửi dạng orchestrator-privileged), (3) kind `notify|message` only. Orchestrator role giữ quyền như cũ. Test trong `test/unit/runtime/broker/`: worker hello + msg.send to parent → ok; to không hợp lệ → `forbidden`; `from` trong params bị bỏ qua (kết quả ghi from=taskId).

- [ ] **Step 1: Failing test** (mock client bắt method + params; rate-limit: 11 calls trong <60s với `now()` injectable → cái 11 trả warning chứa `rate-limited`):

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageTool } from "../../../src/prompt/message-tool.ts";

function harness() {
	const sent: { method: string; params: any }[] = [];
	const tool = createMessageTool({
		makeBrokerClient: () => ({ request: async (method, params) => { sent.push({ method, params }); return { ok: true, value: {} }; } }) as any,
	});
	return { tool, sent };
}

test("message notify parent goes through broker msg.send", async () => {
	const { tool, sent } = harness();
	const r = await tool.execute({ to: "parent", kind: "notify", body: "milestone: parser done" });
	assert.equal(r.status, "sent");
	assert.equal(sent[0]!.method, "msg.send");
	assert.equal(sent[0]!.params.kind, "notify");
});

test("message DM targets a sibling taskId", async () => {
	const { tool, sent } = harness();
	await tool.execute({ to: "03_execute", kind: "message", subject: "api shape", body: "use parseArgs(cmd) not argv" });
	assert.equal(sent[0]!.params.to, "03_execute");
});

test("rate limit: 11th message within window warns instead of sending", async () => {
	const { tool, sent } = harness();
	for (let i = 0; i < 11; i++) await tool.execute({ to: "parent", kind: "notify", body: `n${i}` });
	assert.equal(sent.length, 10, "first 10 sent");
	// lần 11 bị chặn — tool vẫn trả kết quả (không throw) với cảnh báo
});
```

- [ ] **Step 2: Run** → FAIL (module chưa tồn tại).
- [ ] **Step 3: Implement `src/prompt/message-tool.ts`** — dormant-until-env `PI_CREW_MSG_ENABLED === "1"` (parse env khi execute); sliding-window 10/60s nội bộ (Set timestamps, injectable qua deps `now`); gửi qua `client.request("msg.send", { to: params.to, kind, subject, body, priority })`; broker fail (`!ok`) → trả `{ status: "unavailable", text: "[message] broker unavailable — include the note in your final result instead." }`. KHÔNG tự park task (khác ask). Tool description (cho LLM): "Send a non-blocking message: notify the orchestrator of progress/risks (`to:'parent'`), DM another worker by task id, or broadcast the group. Unlike `ask`, this never waits."
- [ ] **Step 4: Run** → PASS. Register trong `prompt-runtime.ts` cạnh ask (`if (env.PI_CREW_MSG_ENABLED === "1") pi.registerTool(createMessageTool())`) — thêm env set ở child-pi-spawn.
- [ ] **Step 5:** typecheck + commit `feat(messaging): worker message tool — notify/DM/group over broker msg.send (D9)`.

---

### Task 5: Inbox worker-side pickup + wake pattern host-side (§15.2)

**Files:**
- Modify: `src/prompt/prompt-runtime.ts` (vòng poll của ask — mở rộng đọc inbox mailbox mỗi chu kỳ; message mới → trả về như fenced context ở turn kế tiếp bằng `pi.sendMessage({ customType: "crew-inbox", ... }, { deliverAs: "steer" })`)
- Modify: `src/runtime/broker/crew-broker.ts` `handleMsgSend` (đảm bảo gắn `from: conn.taskId` — ghi đè mọi giá trị client gửi; `to: "parent"` rewrite thành run orchestrator target)
- Test: `test/unit/prompt/inbox-pickup.test.ts` (create)

**Interfaces:** Consumes `readAllMailboxMessages(stateRoot, runId)` (grep exact name: `grep -n "export function read" src/state/coordination/mailbox.ts`).

- [ ] **Step 1: Failing test** — poll function `pollWorkerInbox({ stateRoot, runId, taskId, sinceTs })` trả danh sách message mới `kind === "message"` addressed to taskId/group, dedup theo `id`; test viết fixture mailbox dir + 2 messages (1 cho mình, 1 cho task khác) → chỉ nhận 1.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement pollWorkerInbox (export từ prompt-runtime hoặc module nhỏ `src/prompt/inbox-poll.ts`); gọi trong cùng interval poll của ask; message mới → `pi.sendMessage` steer với body fenced `<inbox-message from="{taskId}">…</inbox-message>`.**
- [ ] **Step 4:** Run → PASS; typecheck.
- [ ] **Step 5:** commit `feat(messaging): worker inbox pickup + broker from-override (anti-spoof) + wake steer`.

---

### Task 6: Config + team-settings (2 keys + maxDepth)

**Files:**
- Modify: `src/config/types.ts` (CrewRuntimeConfig thêm `surface?: { mode?: "auto"|"tmux"|"herdr"|"off"; visibleAgents?: string[] }`)
- Modify: `src/config/config-validation.ts` (`parseSurfacePolicy` — pattern `parseIsolationPolicy` tại :273)
- Modify: `src/extension/team-tool/handle-settings.ts` (KNOWN_KEYS :134, EFFECTIVE_DEFAULTS :13)
- Test: `test/unit/config/surface-config.test.ts` (create)

- [ ] **Step 1: Failing test** — parse `{ runtime: { surface: { mode: "tmux", visibleAgents: ["executor"] } } }` → qua loadConfig ra đúng; `mode: "bogus"` → bị bỏ + không crash; EFFECTIVE_DEFAULTS chứa `runtime.surface.mode: "auto"`; KNOWN_KEYS chứa đủ 2 key `runtime.surface.mode`, `runtime.surface.visibleAgents`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** cả 3 file (surface optional object; KNOWN_KEYS thêm 2 chuỗi; EFFECTIVE_DEFAULTS thêm 2 dòng).
- [ ] **Step 4: Run** → PASS + `node --experimental-strip-types --test test/unit/config/env-vars.test.ts` không vỡ.
- [ ] **Step 5:** typecheck + commit `feat(config): runtime.surface (mode, visibleAgents) + team-settings keys`.

---

### Task 7: Docs + wrap-up

**Files:** Modify `docs/TEST_MATRIX.md` (hàng mới: loadout-default-full, delegate-all-roles, message-tool, inbox-pickup); Modify `CLAUDE.md` pi-crew (Runtime Modes table note về D5/D8 — 1 dòng mỗi cái).

- [ ] **Step 1:** Cập nhật 2 file docs (ngắn gọn, theo style hiện có).
- [ ] **Step 2:** `npm test` toàn bộ — mọi fail phải là expectation cũ đã đánh dấu sửa ở Task 1; không fail mới.
- [ ] **Step 3:** commit `docs: loadout/nesting/messaging test matrix + notes`.
