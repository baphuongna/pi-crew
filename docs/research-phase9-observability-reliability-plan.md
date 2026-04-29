# Phase 9 — Observability & Reliability (Theme B + C combined)

> Path X: Phase 8 (Operator Experience) → **Phase 9 (Observability + Reliability)**. Mục tiêu: build telemetry backbone (Counter/Gauge/Histogram + correlation ID + sink/export) đồng thời harden run reliability (heartbeat gradient + retry + crash recovery + deadletter). Combined vì 5 synergy critical (xem mục 1.A).

> **Prerequisite:** Phase 8 đã DONE (verified 351 unit + 44 integration pass, version 0.1.34) — `NotificationRouter`, `ConfirmOverlay`, `MailboxDetailOverlay/Compose/Preview/AgentPicker`, `heartbeat-aggregator.ts`, `health-pane.ts`, `diagnostic-export.ts` (with `redactSecrets` regex `/(token|key|password|secret|credential|auth)/i`), `notification-sink.ts`, `keybinding-map.ts`, `run-action-dispatcher.ts` — Phase 9 reuse.

> **Critical preflight finding (Phase 9.0.E):** `ExtensionAPI.events` interface is `EventBus` from `pi-coding-agent/dist/core/event-bus.d.ts`:
> ```ts
> interface EventBus { emit(channel, data): void; on(channel, handler): () => void; }  // on() returns unsubscribe function — NO off() method
> ```
> → All "dispose" patterns must capture `unsubscribe` from `on()` return value, NOT call `events.off()`.

## 0. Implementation Status

### Foundation (Wave 1)
- [x] 9.0.A Metric primitives — Counter / Gauge / Histogram base classes (`src/observability/metrics-primitives.ts`)
- [x] 9.0.B MetricRegistry **per-session instance** + naming convention (`src/observability/metric-registry.ts`)
- [x] 9.0.C Correlation context — traceId/spanId propagation primitive (`src/observability/correlation.ts`)
- [x] 9.0.D Heartbeat gradient classifier extension (warn/stale/dead thresholds with metrics emission, reuse `WorkerHeartbeatState` interface + `isWorkerHeartbeatStale` helper)
- [x] 9.0.E **Preflight verify** ExtensionAPI surface (`events.on` returns unsubscribe fn, `events.off` does NOT exist) + cross-check `WorkerHeartbeatState` field name

### Reliability core (Wave 2)
- [x] 9.1.A Background heartbeat watcher (detect stuck workers, emit `crew.heartbeat.staleness_ms` Gauge)
- [x] 9.1.B Retry executor + backoff/jitter policy (`src/runtime/retry-executor.ts`)
- [x] 9.1.C Crash recovery resume từ event-log checkpoint
- [x] 9.1.D Deadletter queue writer + threshold alerts via NotificationRouter

### Telemetry pipeline (Wave 3)
- [x] 9.2.A Event-to-metric subscriber (subscribe `crew.*` events → registry counters)
- [x] 9.2.B Metric retention policy (sliding window aggregation 1h/1d configurable)
- [x] 9.2.C Histogram quantile calculator (p50/p95/p99 streaming) — t-digest or fixed buckets
- [x] 9.2.D Metric file sink JSONL với daily rotation (gated bởi `telemetry.enabled`)

### Export adapters (Wave 3 parallel)
- [x] 9.3.A Prometheus exposition format adapter (HTTP endpoint optional)
- [x] 9.3.B OTLP HTTP exporter (optional, opt-in)
- [x] 9.3.C Adapter abstraction (plugin pattern, extensible)

### UI & commands (Wave 4)
- [x] 9.4.A `team metrics` command — snapshot JSON, filter by name/runId
- [x] 9.4.B Metrics pane (pane index `6`) trong dashboard
- [x] 9.4.C Diagnostic export (Phase 8) include metrics snapshot

### Wiring & validation (Wave 5)
- [x] 9.5.A Wire register.ts — instantiate MetricRegistry, EventToMetric subscriber, RetryExecutor, BackgroundWatcher
- [x] 9.5.B Tests: unit + integration + perf
- [x] 9.5.C Migration guide: existing runs continue to work; opt-in for retry/recovery via config flag

## 1. Roadmap-Level Decisions

### 1.A Synergy Theme B + C — 5 critical integrations

| # | Touchpoint | Theme B contributes | Theme C contributes | Combined value |
|---|---|---|---|---|
| **S1** | Heartbeat staleness | Gauge primitive `crew.heartbeat.staleness_ms{runId,taskId}` | Gradient classifier (healthy/warn/stale/dead) | Auto-emit metric per task → time-series → detect regression |
| **S2** | Retry attempts | Histogram primitive `crew.task.retry_count{team}` | Retry executor + jitter backoff | Distribution analytics (p95 retries per team) |
| **S3** | Recovery trace | `traceId`/`spanId` correlation propagation | Recovery state machine (resume từ checkpoint) | Cross-component debug — subagent crash → recovery → resume fully traceable |
| **S4** | Deadletter alert | Counter `crew.task.deadletter_total{reason}` + threshold | Deadletter writer | Auto-alert via NotificationRouter khi rate > threshold |
| **S5** | Performance regression | Histogram quantile p95 over time | Stale duration tracking | Detect "Phase X deploy → p95 staleness +50%" tự động |

### 1.B Decisions

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Metric primitives: implement custom hay reuse library? | **Implement custom (minimal)** — Counter, Gauge, Histogram chỉ ~200 LOC | Tránh dependency mới (đồng nhất Phase 7/8 zero-dep approach); OTLP serializer cũng < 200 LOC |
| D2 | Histogram bucket strategy? | **Fixed exponential buckets** `[1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` ms | Simple, predictable; no t-digest complexity; 95% use case là latency ms; user override qua config nếu cần |
| D3 | Correlation ID format? | **`{runId}:{taskId}:{spanCounter}`** (P1 default) | Human-readable, không cần UUID library, deterministic cho test, scope rõ ràng |
| D4 | Correlation ID propagation method? | **Async context (`AsyncLocalStorage`)** trong Node.js runtime | Standard Node API; không phải pass thủ công qua mọi function; minimal overhead |
| D5 | Retry executor: opt-in hay default-on? | **Opt-in** qua `reliability.autoRetry: false` mặc định | Risk High (touches state machine); user explicit consent; preserve current behavior bằng default |
| D6 | Retry policy default? | **maxAttempts=3, backoffMs=1000, jitterRatio=0.3, exponentialFactor=2** (P2) | Sensible defaults; per-task override; matches industry common pattern |
| D7 | Crash recovery: auto-resume vs prompt? | **Prompt via NotificationRouter** (P3) — Phase 8 ConfirmOverlay reused | User confirmation cho destructive resume action; tránh false-positive replay |
| D8 | Metric retention window default? | **1 hour streaming, 24 hour summary** (P4); persist daily JSONL | Cover 95% debugging; balance memory vs disk |
| D9 | Background watcher polling interval? | **5 seconds** default, configurable 1-60s (P8) | Responsive without burn CPU; setInterval not setTimeout chain |
| D10 | OTLP export priority? | **Implement nhưng disable mặc định** (P6) | Foundation cho team có observability stack; off by default tránh confused user |
| D11 | Deadletter alert threshold? | **>3 deadletter messages trong 1 hour** (P7) | Conservative; tránh false positive; configurable |
| D12 | Event-to-metric mapping cấu hình hay hardcode? | **Hardcode core** + extensible plugin | Core ~15 events đã định, hardcode đảm bảo consistent; plugin cho user custom |
| D13 | Naming convention metrics? | **`crew.{domain}.{measure}_{unit}`** — `crew.run.duration_ms`, `crew.task.retry_count`, `crew.heartbeat.staleness_ms` | Prometheus-compatible; domain rõ ràng; unit suffix tránh ambiguity |
| D14 | Metric sink file location? | **`<crewRoot>/state/metrics/{YYYY-MM-DD}.jsonl`** | Đồng nhất với Phase 8 notification sink pattern; daily rotation; configurable retention |
| D15 | Recovery checkpoint format? | **Event-log cursor** (existing `events.jsonl.seq` + `sequencePath()`/`scanSequence()` helpers) | Reuse hạ tầng đã có Phase 6; không thêm checkpoint format mới |
| D16 | Histogram quantile algorithm? | **Fixed buckets + linear interpolation** (P5) | Đơn giản; sufficient cho p50/p95/p99 với fixed buckets; t-digest defer Phase 10 nếu cần |
| **D17** | **MetricRegistry lifecycle** | **Per-session instance** (consistent với Phase 8 `notificationRouter`/`heartbeatAggregator`) — instantiate trong `session_start`, `dispose()` trong `session_shutdown` | Cumulative metrics across sessions không cần thiết Phase 9 (defer Phase 10 nếu user yêu cầu); test isolation tự nhiên; no global state leak; dispose semantics rõ ràng |
| **D18** | **Event subscription cleanup** | **Capture unsubscribe fn từ `events.on()` return value**; KHÔNG call `events.off()` (không tồn tại trên `EventBus` interface) | API surface preflight verified (9.0.E); pattern matches existing usages trong codebase (`src/ui/render-scheduler.ts`) |
| **D19** | **Retry state machine semantics** | **Task `failed` chỉ transition khi maxAttempts exhausted**; thêm field `task.attempts: Array<{startedAt,endedAt,error?}>` cho traceability; artifact final chỉ trên terminal attempt | Tránh terminal-state monotonicity violation (re-run task đang `failed` về `running`); audit trail đầy đủ cho debug |
| **D20** | **Crash recovery trigger combinator** | Recovery only triggers if `(status==="running") AND (no async.pid OR async.pid is dead via existing liveness check) AND (heartbeat dead via isWorkerHeartbeatStale > deadMs OR no heartbeat)` | Tránh false-positive marking healthy async run là interrupted; reuse Phase 6/7 async.pid liveness check trong `session-summary.ts` |
| **D21** | **Diagnostic schema versioning** | `DiagnosticReport.schemaVersion: 2` khi thêm `metricsSnapshot?: MetricSnapshot[]` field; apply `redactSecrets()` recursive trên `metricsSnapshot` (label values có thể chứa secret patterns) | Backward-compat consumer reading old format (schemaVersion missing → treat as v1); secret leak prevention |
| **D22** | **Deadletter trigger separation** | 3 paths: (a) `executeWithRetry` exhaust → write entry; (b) heartbeat watcher dead 3 ticks consecutive → write entry; (c) Counter rate > 3/hour → NotificationRouter alert | Trigger entry vs threshold alert là 2 logic riêng; tránh conflate trong implementation |

## 2. Phase Breakdown

### Phase 9.0 — Foundation (3.5 dev-days)

#### 9.0.A Metric primitives (1 dev-day)

**File mới:** `src/observability/metrics-primitives.ts`

```ts
export interface MetricLabels {
	[key: string]: string | number;
}

export abstract class Metric {
	constructor(public readonly name: string, public readonly description: string) {}
	abstract snapshot(): MetricSnapshot;
}

export class Counter extends Metric {
	private values = new Map<string, number>();  // labelKey → count
	inc(labels: MetricLabels = {}, delta = 1): void { /* ... */ }
	snapshot(): MetricSnapshot { return { type: "counter", name: this.name, values: [...this.values.entries()] }; }
}

export class Gauge extends Metric {
	private values = new Map<string, number>();
	set(labels: MetricLabels, value: number): void { /* ... */ }
	add(labels: MetricLabels, delta: number): void { /* ... */ }
	snapshot(): MetricSnapshot { /* ... */ }
}

export class Histogram extends Metric {
	private buckets: number[];  // upper bounds, e.g. [1, 5, 10, 25, ...]
	private observations = new Map<string, { counts: number[]; sum: number; count: number }>();
	constructor(name: string, description: string, buckets?: number[]) {
		super(name, description);
		this.buckets = buckets ?? [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
	}
	observe(labels: MetricLabels, value: number): void { /* ... */ }
	quantile(labels: MetricLabels, q: number): number { /* linear interpolation */ }
	snapshot(): MetricSnapshot { /* ... */ }
}

export interface MetricSnapshot {
	type: "counter" | "gauge" | "histogram";
	name: string;
	values: unknown;
}
```

**Tests:** `test/unit/metrics-primitives.test.ts` — 12 cases (counter inc/labels, gauge set/add/labels, histogram observe/quantile p50/p95/p99/edge empty/edge single value).

#### 9.0.B MetricRegistry (0.75 dev-day) — **Per-session instance (D17)**

**File mới:** `src/observability/metric-registry.ts`

```ts
export class MetricRegistry {
	private metrics = new Map<string, Metric>();
	registerCounter(name: string, description: string): Counter { /* ... */ }
	registerGauge(name: string, description: string): Gauge { /* ... */ }
	registerHistogram(name: string, description: string, buckets?: number[]): Histogram { /* ... */ }
	get(name: string): Metric | undefined { return this.metrics.get(name); }
	snapshot(): MetricSnapshot[] { return [...this.metrics.values()].map((m) => m.snapshot()); }
	dispose(): void { this.metrics.clear(); }
}

// Per-session factory — caller (register.ts) instantiates trong session_start, dispose trong session_shutdown.
// KHÔNG dùng singleton pattern (xem D17): tránh state leak cross-session, đảm bảo test isolation.
export function createMetricRegistry(): MetricRegistry { return new MetricRegistry(); }
```

**Naming convention enforce (D13):** `name` phải match regex `^crew\.[a-z]+\.[a-z][a-z_]*$` (đơn giản hơn regex cũ `^crew\.[a-z_]+\.[a-z_]+(_[a-z]+)?$` vốn redundant). Unit suffix là phần của measure name (e.g., `duration_ms`, `staleness_ms`). Throw nếu không match.

**Tests:** `test/unit/metric-registry.test.ts` — 6 cases (register, duplicate throws, snapshot all, naming validation, dispose clears state, get returns undefined sau dispose).

#### 9.0.C Correlation context (1 dev-day)

**File mới:** `src/observability/correlation.ts`

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationContext {
	traceId: string;       // {runId}:{taskId}:{spanCounter}
	parentSpanId?: string;
	spanId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();
let spanCounter = 0;

export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

export function getCurrentContext(): CorrelationContext | undefined {
	return storage.getStore();
}

export function newSpanId(runId: string, taskId?: string): string {
	spanCounter++;
	return `${runId}:${taskId ?? "main"}:${spanCounter}`;
}

// Wrap event emission to inject correlation
export function correlatedEvent<T extends { runId?: string; data?: Record<string, unknown> }>(event: T): T {
	const ctx = getCurrentContext();
	if (!ctx) return event;
	return { ...event, data: { ...event.data, traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId } };
}
```

**Wire vào `register.ts`** trong `pi.events.emit` wrapper — tất cả `crew.*` events tự inject correlation nếu context active. Foreground/async run wrap toàn bộ executeTeamRun trong `withCorrelation({traceId, spanId: newSpanId(runId)})`.

**Tests:** `test/unit/correlation.test.ts` — 5 cases (basic propagation, nested span, missing context graceful, async boundary preserve, parallel runs isolated).

#### 9.0.D Heartbeat gradient classifier (0.75 dev-day)

**File mới:** `src/runtime/heartbeat-gradient.ts`

```ts
import type { WorkerHeartbeatState } from "./worker-heartbeat.ts";  // Phase 6/7 file — actual interface name (NOT "WorkerHeartbeat")

export type HeartbeatLevel = "healthy" | "warn" | "stale" | "dead";

export interface GradientThresholds {
	warnMs: number;     // default 30_000 (30s)
	staleMs: number;    // default 60_000 (1min)
	deadMs: number;     // default 300_000 (5min)
}

export const DEFAULT_GRADIENT_THRESHOLDS: GradientThresholds = { warnMs: 30_000, staleMs: 60_000, deadMs: 300_000 };

export function classifyHeartbeat(heartbeat: WorkerHeartbeatState | undefined, thresholds: GradientThresholds = DEFAULT_GRADIENT_THRESHOLDS, now = Date.now()): HeartbeatLevel {
	if (!heartbeat) return "dead";
	if (heartbeat.alive === false) return "dead";
	const lastSeen = Date.parse(heartbeat.lastSeenAt);
	if (!Number.isFinite(lastSeen)) return "dead";
	const elapsed = now - lastSeen;
	if (elapsed >= thresholds.deadMs) return "dead";
	if (elapsed >= thresholds.staleMs) return "stale";
	if (elapsed >= thresholds.warnMs) return "warn";
	return "healthy";
}
```

**Update `src/ui/heartbeat-aggregator.ts`** (Phase 8 file, 1612 bytes — verified existence) — backward-compat strategy:
- Giữ nguyên existing API surface `summarizeHeartbeats(snapshot, opts)` returning `HeartbeatSummary` (Phase 8 caller `health-pane.ts` không break).
- Internal classify SWITCH sang `classifyHeartbeat`; map 4-level (healthy/warn/stale/dead) → existing 3-bucket count (`healthy`/`stale`/`dead` — `warn` count merge vào `healthy` để giữ Phase 8 semantics).
- Optional new field `summary.gradient: { healthy, warn, stale, dead }` cho consumers Phase 9 (metrics-pane).
- Emit metrics khi `registry` param truyền vào (optional, không break Phase 8 caller):
  - `metrics.gauge("crew.heartbeat.staleness_ms").set({runId, taskId}, elapsed)`
  - `metrics.counter("crew.heartbeat.level_total").inc({runId, level})`

**Tests:** `test/unit/heartbeat-gradient.test.ts` — 8 cases (healthy/warn/stale/dead/missing/explicit-dead/edge-now/custom-thresholds + invalid date string returns dead).

#### 9.0.E Preflight ExtensionAPI surface verify (0.5 dev-day) — **NEW**

**Mục tiêu:** Trước khi Wave 2 wire `events?.on?.()` callbacks, confirm bằng test tự động:

**File mới:** `test/unit/extension-api-surface.test.ts` — verify hợp đồng:
1. `pi.events.on(channel, handler)` returns function (unsubscribe).
2. Calling unsubscribe stops handler invocation on subsequent emit.
3. Multiple `on()` calls cho cùng channel đều được gọi.
4. Confirm `events.off` không tồn tại (typeof check) — fail-fast nếu Pi upstream thay đổi API.
5. Verify `WorkerHeartbeatState` interface fields exist (`workerId`, `lastSeenAt`, `alive?`) — guard against rename.

**Output:** Block Wave 2 nếu test fail. Document trong PR description.

**Tests:** chính là content của file 9.0.E (5 cases).

---

### Phase 9.1 — Reliability Core (5 dev-days)

#### 9.1.A Background heartbeat watcher (1.5 dev-days)

**File mới:** `src/runtime/heartbeat-watcher.ts`

**Logic:** Setup `setInterval(5000ms)` (D9) trong session_start; mỗi tick, đọc tất cả active runs từ `manifestCache.list(50)`, load tasks via `loadRunManifestById(cwd, runId).tasks`, classify mỗi task heartbeat:
- `dead` lần đầu detect → emit `crew.task.heartbeat_dead` event + Counter `crew.heartbeat.dead_total{runId}` inc + NotificationRouter alert (severity warning, dedup id `dead_${runId}_${taskId}`).
- `dead` consecutive 3 ticks → trigger deadletter writer (xem 9.1.D path b — D22).

**Skeleton:**

```ts
import { loadRunManifestById } from "../state/state-store.ts";
import type { WorkerHeartbeatState } from "./worker-heartbeat.ts";  // actual interface name
import { classifyHeartbeat, DEFAULT_GRADIENT_THRESHOLDS, type HeartbeatLevel } from "./heartbeat-gradient.ts";

export class HeartbeatWatcher {
	private timer?: ReturnType<typeof setInterval>;
	private lastLevel = new Map<string, HeartbeatLevel>();    // `${runId}:${taskId}` → previous level
	private consecutiveDead = new Map<string, number>();      // `${runId}:${taskId}` → consecutive dead tick count
	constructor(
		private opts: {
			cwd: string;
			pollIntervalMs?: number;
			thresholds?: GradientThresholds;
			manifestCache: ManifestCache;
			registry: MetricRegistry;
			router: NotificationRouter;
			deadletterTickThreshold?: number;  // default 3 (D22 path b)
			onDead?: (runId: string, taskId: string, elapsed: number) => void;
			onDeadletterTrigger?: (runId: string, taskId: string) => void;
		}
	) {}
	start(): void {
		this.timer = setInterval(() => this.tick(), this.opts.pollIntervalMs ?? 5000);
	}
	private tick(): void {
		const thresholds = this.opts.thresholds ?? DEFAULT_GRADIENT_THRESHOLDS;
		const tickThreshold = this.opts.deadletterTickThreshold ?? 3;
		for (const run of this.opts.manifestCache.list(50)) {
			if (run.status !== "running") continue;
			const loaded = loadRunManifestById(this.opts.cwd, run.runId);
			if (!loaded) continue;
			for (const task of loaded.tasks) {
				if (task.status !== "running" && task.status !== "queued") continue;
				const key = `${run.runId}:${task.id}`;
				const level = classifyHeartbeat(task.heartbeat, thresholds);
				const prev = this.lastLevel.get(key);
				this.lastLevel.set(key, level);
				if (level === "dead" && prev !== "dead") {
					this.opts.router.enqueue({ id: `dead_${run.runId}_${task.id}`, severity: "warning", source: "heartbeat-watcher", runId: run.runId, title: `Task ${task.id} heartbeat dead`, body: "Background watcher detected stuck worker." });
					this.opts.registry.get("crew.heartbeat.dead_total")?.inc({ runId: run.runId });
					this.opts.onDead?.(run.runId, task.id, 0);
				}
				if (level === "dead") {
					const count = (this.consecutiveDead.get(key) ?? 0) + 1;
					this.consecutiveDead.set(key, count);
					if (count === tickThreshold) this.opts.onDeadletterTrigger?.(run.runId, task.id);
				} else this.consecutiveDead.delete(key);
			}
		}
	}
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.lastLevel.clear();
		this.consecutiveDead.clear();
	}
}
```

**Tests:** `test/unit/heartbeat-watcher.test.ts` — 7 cases (start/dispose, dead detection alert once, transition healthy→dead emits once, transition dead→healthy resets, multiple runs isolated, mock clock, consecutive 3 ticks → deadletter trigger).

#### 9.1.B Retry executor (1.5 dev-days)

**File mới:** `src/runtime/retry-executor.ts`

```ts
export interface RetryPolicy {
	maxAttempts: number;        // default 3 (D6)
	backoffMs: number;          // default 1000
	jitterRatio: number;        // default 0.3 (±30%)
	exponentialFactor: number;  // default 2
	retryableErrors?: string[]; // glob patterns; empty = all retryable
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, backoffMs: 1000, jitterRatio: 0.3, exponentialFactor: 2 };

export async function executeWithRetry<T>(
	fn: (attempt: number) => Promise<T>,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	hooks?: { onAttemptFailed?: (attempt: number, error: Error, nextDelayMs: number) => void; onRetryGivenUp?: (attempts: number, error: Error) => void; signal?: AbortSignal }
): Promise<T> { /* exponential backoff with jitter */ }

function calculateDelay(attempt: number, policy: RetryPolicy): number {
	const base = policy.backoffMs * Math.pow(policy.exponentialFactor, attempt - 1);
	const jitter = (Math.random() * 2 - 1) * policy.jitterRatio * base;
	return Math.max(0, base + jitter);
}
```

**Wire vào `executeTeamRun`** opt-in (D5 + D19 state-machine semantics):
- Read `loadConfig.config.reliability?.autoRetry` (default `false`, D5).
- Nếu true → wrap `runTeamTask(task)` với `executeWithRetry`.
- **State machine rules (D19):**
  - Mỗi attempt → push entry `{ startedAt, endedAt, error? }` vào `task.attempts: Array<...>` (new field — schema additive).
  - Task KHÔNG transition `running → failed → running` giữa các attempt (vi phạm monotonicity); thay vào đó, attempt N fail → đợi backoff → attempt N+1 vẫn `status="running"`, chỉ `attempts[]` mọc.
  - Task transition `failed` CHỈ KHI maxAttempts exhausted; `task.error` reflect last error; artifact final chỉ finalize trên terminal attempt (không over-write per attempt).
  - Idempotency requirement (risk Med-High): document trong release notes — `runTeamTask` phải idempotent hoặc user accept double-execute risk.
- Mỗi attempt → emit `crew.task.retry_attempt{runId,taskId,attempt}` Counter, `crew.task.retry_delay_ms{runId,taskId}` Histogram observe.
- Cuối cùng → record `crew.task.retry_count{runId,team}` Histogram observe (final attempt count).

**Schema update `src/schema/config-schema.ts`:**
```ts
reliability: Type.Optional(Type.Object({
	autoRetry: Type.Optional(Type.Boolean()),  // default false
	retryPolicy: Type.Optional(Type.Object({
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		backoffMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
		jitterRatio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		exponentialFactor: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
		retryableErrors: Type.Optional(Type.Array(Type.String())),
	})),
	autoRecover: Type.Optional(Type.Boolean()),  // default false
	deadletterThreshold: Type.Optional(Type.Integer({ minimum: 1 })),  // default 3
})),
```

**Tests:** `test/unit/retry-executor.test.ts` — 10 cases (success first try, fail then succeed, max attempts exhausted, abort signal, jitter range, retryable filter, custom policy override, mock clock backoff, hook callback fires).

#### 9.1.C Crash recovery (1.5 dev-days)

**File mới:** `src/runtime/crash-recovery.ts`

**Logic:** session_start phát hiện run với status `running` từ session trước, **chỉ trigger recovery nếu thoả combinator (D20):**
- `(manifest.status === "running")`
- AND `(manifest.async?.pid === undefined OR pidIsDead(manifest.async.pid))` — reuse existing async.pid liveness check trong `src/extension/session-summary.ts`
- AND `(no heartbeat OR isWorkerHeartbeatStale(heartbeat, deadMs) === true)` — reuse `isWorkerHeartbeatStale()` từ `src/runtime/worker-heartbeat.ts`

Khi triggered:
1. Read event-log cursor via `scanSequence(eventsPath)` từ `src/state/event-log.ts` (Phase 6 helper) — tìm last completed event seq.
2. Compute "stale work":
   - Tasks `running` nhưng heartbeat dead → mark `pending-recovery`.
   - Tasks `completed`/`cancelled`/`failed` → preserve.
3. NotificationRouter prompt: `"Run X was interrupted. Resume from event N? (Y/N)"` (D7) qua Phase 8 ConfirmOverlay.
4. User confirm → reset stale tasks to `queued`, write resume event với metadata `{ recoveredFromSeq: N }`, emit `crew.run.resumed{runId, fromEventSeq}`.
5. User decline → mark run `cancelled` với reason `"interrupted-not-resumed"`.

**Skeleton:**

```ts
export interface RecoveryPlan {
	runId: string;
	resumableTasks: string[];   // taskIds to reset to queued
	preservedTasks: string[];   // taskIds completed/cancelled (no change)
	lastEventSeq: number;
}

export function detectInterruptedRuns(cwd: string, manifestCache: ManifestCache): RecoveryPlan[] { /* ... */ }
export async function applyRecoveryPlan(plan: RecoveryPlan, ctx: ExtensionContext, registry: MetricRegistry): Promise<void> { /* ... */ }
```

**Wire vào `register.ts:session_start`:**
```ts
if (loadedConfig.config.reliability?.autoRecover === true) {
	const plans = detectInterruptedRuns(ctx.cwd, manifestCache);
	for (const plan of plans) {
		// Use NotificationRouter + ConfirmOverlay prompt
		notificationRouter.enqueue({
			severity: "warning",
			source: "crash-recovery",
			runId: plan.runId,
			title: `Run ${plan.runId} was interrupted`,
			body: `${plan.resumableTasks.length} tasks pending recovery. Open dashboard → confirm to resume.`,
			id: `recovery_prompt_${plan.runId}`,
		});
	}
}
```

**Tests:** `test/integration/crash-recovery.test.ts` — 5 cases (no interrupted runs, single run resume, decline marks cancelled, multiple runs, completed tasks preserved).

#### 9.1.D Deadletter queue (0.5 dev-day)

**File mới:** `src/runtime/deadletter.ts`

**Logic (D22 — 3 separate trigger paths):**
- **Path (a) — retry exhaust:** trong `executeWithRetry` hooks `onRetryGivenUp(attempts, error)` → call `appendDeadletter({ reason: "max-retries", attempts, lastError })`.
- **Path (b) — heartbeat watcher consecutive dead:** `HeartbeatWatcher.onDeadletterTrigger(runId, taskId)` (count = 3 ticks consecutive — xem 9.1.A) → call `appendDeadletter({ reason: "heartbeat-dead", attempts: 0 })`.
- **Path (c) — threshold alert (separate from entry write):** Counter `crew.task.deadletter_total` rate > 3/hour (TimeWindowedCounter from 9.2.B) → NotificationRouter alert severity `error` với id `deadletter_threshold_${runId}` (dedup window 1h).

Tất cả 3 paths đều:
1. Append vào `<crewRoot>/state/runs/{runId}/deadletter.jsonl`.
2. Emit `crew.task.deadletter{runId,taskId,reason}` Counter inc.

```ts
export interface DeadletterEntry {
	taskId: string;
	runId: string;
	reason: "max-retries" | "heartbeat-dead" | "manual";
	attempts: number;
	lastError?: string;
	timestamp: string;
}

export function appendDeadletter(manifest: TeamRunManifest, entry: DeadletterEntry): void { /* JSONL append */ }
export function readDeadletter(manifest: TeamRunManifest): DeadletterEntry[] { /* read all */ }
```

**Tests:** `test/unit/deadletter.test.ts` — 4 cases (append, read, threshold trigger, persistence cross-session).

---

### Phase 9.2 — Telemetry Pipeline (4 dev-days)

#### 9.2.A Event-to-metric subscriber (1 dev-day)

**File mới:** `src/observability/event-to-metric.ts`

**Hardcoded mapping (D12):**

```ts
export function wireEventToMetrics(events: ExtensionAPI["events"], registry: MetricRegistry): { dispose: () => void } {
	// Counters
	const runCount = registry.registerCounter("crew.run.count", "Total runs by status");
	const taskCount = registry.registerCounter("crew.task.count", "Total tasks by status");
	const subagentCount = registry.registerCounter("crew.subagent.count", "Total subagent records by status");
	const mailboxCount = registry.registerCounter("crew.mailbox.count", "Total mailbox messages by direction");
	const deadletterCount = registry.registerCounter("crew.task.deadletter_total", "Deadletter triggers by reason");

	// Gauges
	const heartbeatStaleness = registry.registerGauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds");

	// Histograms
	const runDuration = registry.registerHistogram("crew.run.duration_ms", "Run end-to-end duration, milliseconds");
	const taskDuration = registry.registerHistogram("crew.task.duration_ms", "Task duration, milliseconds");
	const retryCount = registry.registerHistogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]);
	const tokenUsage = registry.registerHistogram("crew.task.tokens_total", "Token usage per task");

	const handlers: Array<[string, (data: any) => void]> = [
		["crew.run.completed", (d) => { runCount.inc({ status: "completed" }); runDuration.observe({ team: d.team ?? "unknown" }, d.durationMs ?? 0); }],
		["crew.run.failed", (d) => { runCount.inc({ status: "failed" }); }],
		["crew.run.cancelled", (d) => { runCount.inc({ status: "cancelled" }); }],
		["crew.subagent.completed", (d) => { subagentCount.inc({ status: d.status }); }],
		["crew.mailbox.message", (d) => { mailboxCount.inc({ direction: d.direction }); }],
		// ... etc
	];

	// D18: events.on() returns unsubscribe fn (EventBus interface). NO events.off() exists.
	const unsubscribers: Array<() => void> = [];
	for (const [event, handler] of handlers) {
		const unsub = events?.on?.(event, handler);
		if (unsub) unsubscribers.push(unsub);
	}
	return { dispose: () => { for (const unsub of unsubscribers) unsub(); unsubscribers.length = 0; } };
}
```

**Tests:** `test/unit/event-to-metric.test.ts` — 8 cases (each event handler increments correct metric, dispose calls each unsubscribe fn, no-op nếu events undefined, dispose idempotent — calling 2x không crash, multiple subscribers parallel isolated, handler exception không break other handlers via EventBus safe wrapper).

#### 9.2.B Metric retention (1 dev-day)

**File mới:** `src/observability/metric-retention.ts`

**Logic:** Streaming window 1h (D8) — mỗi metric value có timestamp; periodically (every 60s) → purge values older than window. Daily summary aggregation roll up vào persistent JSONL (9.2.D).

```ts
export class TimeWindowedCounter {
	private events: { timestamp: number; labels: MetricLabels; delta: number }[] = [];
	constructor(private windowMs: number = 3_600_000) {}
	inc(labels: MetricLabels, delta = 1): void { /* push, then prune */ }
	rate(labels: MetricLabels, durationMs: number): number { /* count events in last durationMs / durationMs */ }
}
```

**Wire MetricRegistry:** option `retentionMs` per metric — default 1h cho counter rate; gauge giữ latest value (no retention); histogram observations retain all (memory bounded by labels cardinality).

**Tests:** `test/unit/metric-retention.test.ts` — 5 cases (retain within window, prune outside, rate calculation, multiple labels isolated, mock clock).

#### 9.2.C Histogram quantile (1 dev-day)

**Update `metrics-primitives.ts`:** thêm method `quantile()`:

```ts
quantile(labels: MetricLabels, q: number): number {
	const obs = this.observations.get(labelKey(labels));
	if (!obs || obs.count === 0) return NaN;
	const targetIdx = q * obs.count;
	let cumulative = 0;
	for (let i = 0; i < this.buckets.length; i++) {
		cumulative += obs.counts[i];
		if (cumulative >= targetIdx) {
			const prevCum = cumulative - obs.counts[i];
			const lower = i === 0 ? 0 : this.buckets[i - 1];
			const upper = this.buckets[i];
			// Linear interpolation within bucket
			const fraction = (targetIdx - prevCum) / Math.max(1, obs.counts[i]);
			return lower + fraction * (upper - lower);
		}
	}
	return this.buckets[this.buckets.length - 1];  // overflow bucket
}
```

**Tests:** `test/unit/metrics-primitives.test.ts` mở rộng — quantile p50/p95/p99 với fixture data; edge empty, edge single value, edge all in one bucket.

#### 9.2.D Metric file sink (1 dev-day)

**File mới:** `src/observability/metric-sink.ts`

**Logic:** Tương tự Phase 8 `notification-sink.ts` — daily JSONL rotation, retention configurable. Sink writer chạy interval (default 60s) → snapshot registry → append. Reuse `redactSecrets` từ `diagnostic-export.ts` cho label values (precaution với secret patterns).

```ts
import { redactSecrets } from "../runtime/diagnostic-export.ts";  // Phase 8 helper
import { logInternalError } from "../utils/internal-error.ts";

export interface MetricSink {
	writeSnapshot(snapshots: MetricSnapshot[]): void;
	dispose(): void;
}

export interface MetricFileSinkOptions {
	crewRoot: string;
	registry: MetricRegistry;
	retentionDays?: number;       // default 7
	intervalMs?: number;           // default 60_000
}

export function createMetricFileSink(opts: MetricFileSinkOptions): MetricSink {
	const dir = path.join(opts.crewRoot, "state", "metrics");
	const retentionDays = opts.retentionDays ?? 7;
	const writeSnapshot = (snapshots: MetricSnapshot[]): void => {
		try {
			const date = new Date().toISOString().slice(0, 10);
			rotateOldFiles(dir, retentionDays);
			fs.mkdirSync(dir, { recursive: true });
			const redacted = redactSecrets(snapshots);
			fs.appendFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify({ exportedAt: new Date().toISOString(), snapshots: redacted })}\n`, "utf-8");
		} catch (e) { logInternalError("metric-sink.write", e); }
	};
	const timer = setInterval(() => writeSnapshot(opts.registry.snapshot()), opts.intervalMs ?? 60_000);
	return { writeSnapshot, dispose: () => clearInterval(timer) };
}
```

**Tests:** `test/unit/metric-sink.test.ts` — 5 cases (write basic, daily rotation, retention prune, telemetry disabled no-op when not instantiated, dispose stops timer + secret redaction in labels).

---

### Phase 9.3 — Export Adapters (3 dev-days)

#### 9.3.A Prometheus exposition format (1 dev-day)

**File mới:** `src/observability/exporters/prometheus-exporter.ts`

```ts
export function formatPrometheus(snapshots: MetricSnapshot[]): string {
	const lines: string[] = [];
	for (const snap of snapshots) {
		lines.push(`# HELP ${snap.name} ${snap.description ?? ""}`);
		lines.push(`# TYPE ${snap.name} ${snap.type}`);
		// Format values per type with labels: name{label="value"} value timestamp
		// ...
	}
	return lines.join("\n") + "\n";
}
```

**Optional HTTP endpoint:** `team metrics --serve --port 9091` command starts simple `http.createServer` exposing `/metrics` endpoint. Off by default.

**Tests:** `test/unit/prometheus-exporter.test.ts` — 6 cases (counter format, gauge format, histogram format with buckets, labels escaping, empty registry, special chars).

#### 9.3.B OTLP HTTP exporter (1.5 dev-days, OPTIONAL — disable mặc định D10)

**File mới:** `src/observability/exporters/otlp-exporter.ts`

**Logic:** Convert MetricSnapshot → OTLP JSON format (HTTP/protobuf alt); POST đến endpoint config. Buffer batch 60s.

```ts
export interface OTLPExporterOptions {
	endpoint: string;       // e.g. http://collector:4318/v1/metrics
	headers?: Record<string, string>;
	intervalMs?: number;    // default 60_000
	timeoutMs?: number;     // default 10_000
}

export class OTLPExporter {
	constructor(private opts: OTLPExporterOptions, private registry: MetricRegistry) {}
	start(): void { /* setInterval push */ }
	private async push(): Promise<void> {
		const otlp = convertToOTLP(this.registry.snapshot());
		try {
			await fetch(this.opts.endpoint, { method: "POST", headers: { "content-type": "application/json", ...this.opts.headers }, body: JSON.stringify(otlp), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
		} catch (e) { logInternalError("otlp-export", e); }
	}
	dispose(): void { /* clearInterval */ }
}

function convertToOTLP(snapshots: MetricSnapshot[]): unknown { /* OpenTelemetry JSON spec */ }
```

**Schema config:**
```ts
otlp: Type.Optional(Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	endpoint: Type.String(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	intervalMs: Type.Optional(Type.Integer({ minimum: 5000 })),
})),
```

**Tests:** `test/unit/otlp-exporter.test.ts` — 5 cases (format conversion, push success mock fetch, push timeout, dispose stops, disabled no-op).

#### 9.3.C Adapter abstraction (0.5 dev-day)

**File mới:** `src/observability/exporters/adapter.ts`

```ts
export interface MetricExporter {
	name: string;
	push(snapshots: MetricSnapshot[]): Promise<void>;
	dispose(): void;
}

export class CompositeExporter implements MetricExporter {
	name = "composite";
	constructor(private exporters: MetricExporter[]) {}
	async push(snapshots: MetricSnapshot[]): Promise<void> {
		await Promise.allSettled(this.exporters.map((e) => e.push(snapshots)));
	}
	dispose(): void { for (const e of this.exporters) e.dispose(); }
}
```

**Tests:** `test/unit/composite-exporter.test.ts` — 3 cases (push parallel, dispose all, error in one doesn't break others).

---

### Phase 9.4 — UI & Commands (3 dev-days)

#### 9.4.A `team metrics` command (1 dev-day)

**Update `src/extension/team-tool/api.ts`:** thêm operation `metrics-snapshot`:

```ts
if (operation === "metrics-snapshot") {
	const filter = typeof cfg.filter === "string" ? cfg.filter : undefined;  // glob pattern
	const snapshots = getMetricRegistry().snapshot();
	const filtered = filter ? snapshots.filter((s) => globMatch(s.name, filter)) : snapshots;
	return result(JSON.stringify(filtered, null, 2), { action: "api", status: "ok" });
}
```

**Slash command:** `/team-metrics [filter]` → wraps API call, prints formatted output.

**Tests:** `test/unit/team-tool-metrics.test.ts` — 3 cases (snapshot all, filter glob, empty registry).

#### 9.4.B Metrics dashboard pane (1 dev-day)

**File mới:** `src/ui/dashboard-panes/metrics-pane.ts`

**Render:** top 10 metrics by value, sparkline cho histogram p95 trend (last 60min stored in retention store).

```ts
export interface MetricsPaneOptions {
	registry: MetricRegistry;
	maxCounters?: number;  // default 10
}

// Signature consistent với Phase 8 panes — `(snapshot, opts?)`
export function renderMetricsPane(snapshot: RunUiSnapshot | undefined, opts: MetricsPaneOptions): string[] {
	if (!snapshot) return ["Metrics pane: snapshot unavailable"];
	const metrics = opts.registry.snapshot();
	const counters = metrics.filter((m) => m.type === "counter").slice(0, opts.maxCounters ?? 10);
	const lines: string[] = ["Metrics top 10 counters:"];
	for (const c of counters) {
		// Format: name{labels}: value
		// ...
	}
	return lines;
}
```

**Update `src/ui/run-dashboard.ts`:** key `6` → `activePane = "metrics"`; help line update; constructor receives `registry` reference qua `RunDashboardOptions`.

**Tests:** `test/unit/metrics-pane.test.ts` — 4 cases.

#### 9.4.C Diagnostic export include metrics (0.5 dev-day) — **Schema version bump (D21)**

**Update `src/runtime/diagnostic-export.ts`** (Phase 8 file, 4303 bytes — verified):

```ts
// Schema additive — backward-compat for consumers reading old DiagnosticReport
export interface DiagnosticReport {
	schemaVersion?: number;             // NEW v2 — undefined treated as v1
	runId: string;
	exportedAt: string;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	recentEvents: TeamEvent[];
	heartbeat: HeartbeatSummary;
	agents: unknown[];
	envRedacted: Record<string, string>;
	metricsSnapshot?: MetricSnapshot[]; // NEW — optional, only set when registry available
}

// In exportDiagnostic(): apply redactSecrets() recursive on metricsSnapshot label values
// before writing — secret patterns (token/key/password/secret/credential/auth) có thể xuất hiện
// trong label values hoặc histogram metadata.
```

**Caller (commands.ts handler):** pass per-session `MetricRegistry` reference vào `exportDiagnostic(ctx, runId, { registry })`. Nếu registry undefined (telemetry disabled hoặc Phase 9 chưa wired), field `metricsSnapshot` để undefined → backward-compat with Phase 8 consumer.

**Tests:** `test/unit/diagnostic-export.test.ts` extend — 2 cases:
1. Verify `metricsSnapshot` included khi registry passed; `schemaVersion === 2`.
2. Verify secret labels redacted (e.g., metric `crew.api.key_calls{auth_token="abc"}` → `auth_token: "***"`).

---

### Phase 9.5 — Wiring & Tests (3 dev-days)

#### 9.5.A Wire register.ts (1 dev-day) — **Per-session pattern (D17)**

**Update `src/extension/register.ts`:**
```ts
import { createMetricRegistry } from "../observability/metric-registry.ts";  // factory, not singleton
import { wireEventToMetrics } from "../observability/event-to-metric.ts";
import { HeartbeatWatcher } from "../runtime/heartbeat-watcher.ts";
import { detectInterruptedRuns } from "../runtime/crash-recovery.ts";
import { createMetricFileSink } from "../observability/metric-sink.ts";

// Module-scope state cho session (consistent với notificationRouter pattern Phase 8):
let metricRegistry: MetricRegistry | undefined;
let eventMetricSub: { dispose: () => void } | undefined;
let metricSink: MetricSink | undefined;
let heartbeatWatcher: HeartbeatWatcher | undefined;

const configureObservability = (ctx: ExtensionContext): void => {
	// Dispose existing per-session resources first (idempotent)
	heartbeatWatcher?.dispose();
	metricSink?.dispose();
	eventMetricSub?.dispose();
	metricRegistry?.dispose();

	const config = loadConfig(ctx.cwd).config;
	if (config.observability?.enabled === false) {
		metricRegistry = undefined; eventMetricSub = undefined; metricSink = undefined; heartbeatWatcher = undefined;
		return;
	}

	metricRegistry = createMetricRegistry();
	eventMetricSub = wireEventToMetrics(pi.events, metricRegistry);
	if (config.telemetry?.enabled !== false) {
		metricSink = createMetricFileSink({ crewRoot: projectCrewRoot(ctx.cwd), registry: metricRegistry, retentionDays: config.observability?.metricRetentionDays ?? 7 });
	}
	heartbeatWatcher = new HeartbeatWatcher({
		cwd: ctx.cwd,
		pollIntervalMs: config.observability?.pollIntervalMs ?? 5000,
		manifestCache: getManifestCache(ctx.cwd),
		registry: metricRegistry,
		router: notificationRouter!,  // Phase 8 router required
		onDeadletterTrigger: (runId, taskId) => {
			// Path (b) D22 — call deadletter writer
			appendDeadletter(loadRunManifestById(ctx.cwd, runId)!.manifest, { taskId, runId, reason: "heartbeat-dead", attempts: 0, timestamp: new Date().toISOString() });
		},
	});
	heartbeatWatcher.start();

	if (config.reliability?.autoRecover === true) {
		const plans = detectInterruptedRuns(ctx.cwd, getManifestCache(ctx.cwd));
		for (const plan of plans) {
			notificationRouter?.enqueue({ id: `recovery_prompt_${plan.runId}`, severity: "warning", source: "crash-recovery", runId: plan.runId, title: `Run ${plan.runId} was interrupted`, body: `${plan.resumableTasks.length} tasks pending recovery. Open dashboard → confirm to resume.` });
		}
	}
};

// session_start hook:
pi.on("session_start", (ctx) => {
	currentCtx = ctx;
	configureNotifications(ctx);     // Phase 8
	configureObservability(ctx);      // Phase 9 NEW
	// ... rest
});

// session_shutdown hook (extends Phase 8 cleanupRuntime):
pi.on("session_shutdown", () => {
	// Phase 9 cleanup (per-session, in reverse setup order)
	heartbeatWatcher?.dispose();      heartbeatWatcher = undefined;
	metricSink?.dispose();            metricSink = undefined;
	eventMetricSub?.dispose();        eventMetricSub = undefined;
	metricRegistry?.dispose();        metricRegistry = undefined;
	// Phase 8 cleanup
	notificationRouter?.dispose();
	notificationSink?.dispose();
	// ...
});
```

**Wrap executeTeamRun với correlation (9.0.C):**
```ts
const traceId = newSpanId(runId);  // {runId}:main:1 from spanCounter
withCorrelation({ traceId, spanId: traceId }, async () => {
	await executeTeamRun(...);
});
```

**Pass `registry` reference downstream:**
- `metricRegistry` exposed qua `RegisterTeamCommandsDeps` interface (commands.ts) cho dashboard pane + diagnostic export.
- `dispatchDiagnosticExport(ctx, runId, { registry: metricRegistry })` để 9.4.C có thể inject metrics snapshot.

#### 9.5.B Tests + smoke (2 dev-days)

**Unit (mới ~70 cases):**
- metrics-primitives.test.ts (12)
- metric-registry.test.ts (6)
- correlation.test.ts (5)
- heartbeat-gradient.test.ts (8)
- heartbeat-watcher.test.ts (6)
- retry-executor.test.ts (10)
- deadletter.test.ts (4)
- event-to-metric.test.ts (8)
- metric-retention.test.ts (5)
- metric-sink.test.ts (5)
- prometheus-exporter.test.ts (6)
- otlp-exporter.test.ts (5)
- composite-exporter.test.ts (3)
- team-tool-metrics.test.ts (3)
- metrics-pane.test.ts (4)

**Integration (mới ~7 cases):**
- `crash-recovery.test.ts` — 5 sub-cases.
- `retry-executor-roundtrip.test.ts` — task fail 2x, succeed 3rd → metric counter records 3 attempts.
- `heartbeat-watcher-deadletter.test.ts` — 3 dead detections in 1h → deadletter triggered + alert.
- `metric-pipeline-end-to-end.test.ts` — emit events → snapshot via team-metrics → values match.
- `correlation-cross-component.test.ts` — start run → subagent spawn → mailbox event — all events share traceId.
- `prometheus-export.test.ts` — start run, fetch /metrics endpoint, verify format.
- `otlp-export-mock.test.ts` — mock collector, verify POST body schema.

**Smoke manual (10 scenarios):**
1. Run team, finish → `/team-metrics` shows `crew.run.count{status=completed}=1`.
2. Filter: `/team-metrics crew.task.*` shows only task metrics.
3. Set `reliability.autoRetry=true`, fail task 2x → metric `retry_count` shows 3 attempts.
4. Kill foreground process mid-run → reopen session → confirm prompt → resume → tasks continue.
5. Set `reliability.autoRecover=false` → kill process → reopen → no prompt → run cancelled.
6. Heartbeat stuck > 5min → notification toast → metric `heartbeat.dead_total` inc.
7. Trigger 4 deadletter messages → alert toast severity error.
8. `<crewRoot>/state/metrics/{date}.jsonl` populated after 60s.
9. `/team-metrics` filter on Counter histogram quantile p95.
10. OTLP export enabled with mock collector → verify push every 60s.

## 3. Wave Organization

```
Wave 1 (sequential, 4 days) — Foundation must come first
└─ 9.0 (.A → .B → .C → .D → .E preflight)

Wave 2 (parallel, 5 days) — depends on Wave 1
├─ 9.1.A Heartbeat watcher
├─ 9.1.B Retry executor
└─ 9.1.D Deadletter (depends on 9.1.B + 9.1.A)
   ⤷ 9.1.C Crash recovery (depends on 9.0.C correlation)

Wave 3 (parallel, 4 days) — depends on Wave 1
├─ 9.2.A Event-to-metric subscriber
├─ 9.2.B Metric retention
├─ 9.2.C Histogram quantile (extends 9.0.A)
└─ 9.2.D Metric sink

Wave 4 (parallel, 3 days) — depends on Wave 3
├─ 9.3.A Prometheus exporter
├─ 9.3.B OTLP exporter (optional)
├─ 9.3.C Adapter abstraction
└─ 9.4.A team metrics command
   ⤷ 9.4.B Metrics dashboard pane
   ⤷ 9.4.C Diagnostic include metrics

Wave 5 (sequential, 3 days)
├─ 9.5.A Wire register.ts
└─ 9.5.B Tests + smoke validation
```

**Total estimate: 19.5-22.5 dev-days** (Theme B+C combined; Wave 1 +0.5d for 9.0.E preflight).

## 4. Files Affected

### New (33 files — +1 cho 9.0.E preflight test)
| Path | Purpose | Est LOC |
|---|---|---|
| `src/observability/metrics-primitives.ts` | Counter/Gauge/Histogram base | ~200 |
| `src/observability/metric-registry.ts` | Singleton registry | ~120 |
| `src/observability/correlation.ts` | AsyncLocalStorage context | ~80 |
| `src/observability/event-to-metric.ts` | Event subscriber → metrics | ~150 |
| `src/observability/metric-retention.ts` | Time-windowed counter | ~80 |
| `src/observability/metric-sink.ts` | JSONL sink + rotation | ~100 |
| `src/observability/exporters/prometheus-exporter.ts` | Prometheus format | ~120 |
| `src/observability/exporters/otlp-exporter.ts` | OTLP HTTP exporter (optional) | ~180 |
| `src/observability/exporters/adapter.ts` | Composite + interface | ~60 |
| `src/runtime/heartbeat-gradient.ts` | Classifier function (uses `WorkerHeartbeatState`) | ~60 |
| `src/runtime/heartbeat-watcher.ts` | Background poller (per-session, reuse loadRunManifestById + classifyHeartbeat) | ~170 |
| `test/unit/extension-api-surface.test.ts` | **9.0.E preflight** — verify `events.on()` returns unsubscribe + `events.off` does NOT exist + `WorkerHeartbeatState` fields | ~110 |
| `src/runtime/retry-executor.ts` | Backoff + jitter | ~120 |
| `src/runtime/crash-recovery.ts` | Detect + apply plan | ~180 |
| `src/runtime/deadletter.ts` | Append + read JSONL | ~80 |
| `src/ui/dashboard-panes/metrics-pane.ts` | Metrics pane renderer | ~80 |
| `test/unit/metrics-primitives.test.ts` | | ~250 |
| `test/unit/metric-registry.test.ts` | | ~100 |
| `test/unit/correlation.test.ts` | | ~120 |
| `test/unit/heartbeat-gradient.test.ts` | | ~140 |
| `test/unit/heartbeat-watcher.test.ts` | | ~170 |
| `test/unit/retry-executor.test.ts` | | ~220 |
| `test/unit/deadletter.test.ts` | | ~90 |
| `test/unit/event-to-metric.test.ts` | | ~180 |
| `test/unit/metric-retention.test.ts` | | ~110 |
| `test/unit/metric-sink.test.ts` | | ~120 |
| `test/unit/prometheus-exporter.test.ts` | | ~150 |
| `test/unit/otlp-exporter.test.ts` | | ~140 |
| `test/unit/composite-exporter.test.ts` | | ~80 |
| `test/unit/team-tool-metrics.test.ts` | | ~80 |
| `test/unit/metrics-pane.test.ts` | | ~80 |
| `test/integration/crash-recovery.test.ts` | | ~200 |
| `test/integration/retry-executor-roundtrip.test.ts` | | ~150 |
| `test/integration/heartbeat-watcher-deadletter.test.ts` | | ~150 |
| `test/integration/metric-pipeline-end-to-end.test.ts` | | ~180 |
| `test/integration/correlation-cross-component.test.ts` | | ~150 |
| `test/integration/prometheus-export.test.ts` | | ~120 |
| `test/integration/otlp-export-mock.test.ts` | | ~140 |

### Modified (10 files)
| Path | Change |
|---|---|
| `src/extension/register.ts` | Wire registry, event-metric subscriber, heartbeat watcher, retry/recovery, OTLP exporter |
| `src/extension/team-tool/api.ts` | Thêm operation `metrics-snapshot` |
| `src/extension/registration/commands.ts` | Slash command `/team-metrics`; recovery confirm flow |
| `src/runtime/team-runner.ts` | Optional `executeWithRetry` wrap khi `autoRetry=true` |
| `src/runtime/task-runner.ts` | Emit retry attempt events; correlation context wrap |
| `src/ui/heartbeat-aggregator.ts` (Phase 8) | Switch internal classifier sang `heartbeat-gradient.ts`; emit metrics |
| `src/ui/run-dashboard.ts` | Pane `6` metrics; help line |
| `src/runtime/diagnostic-export.ts` (Phase 8) | Include `metricsSnapshot` field |
| `src/schema/config-schema.ts` | Thêm `reliability` + `otlp` sections |
| `src/config/{config.ts,defaults.ts}` | Parse + defaults |
| `package.json` | Bump `0.1.34` → `0.1.35` |

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Correlation propagation chạm hầu hết module | High | Med | AsyncLocalStorage tự động — không phải pass thủ công; test isolation cross-async boundary |
| `executeWithRetry` double-execute task on poorly-idempotent ops | Med | **High** | Default off (D5); D19 state-machine rules (no transition `failed → running`); user explicit opt-in; documentation warn idempotency requirement |
| Crash recovery race với new run start cùng runId | Low | High | D20 combinator: status==="running" AND no async.pid alive AND heartbeat dead; reuse existing async.pid liveness check; recovery prompt blocking until user confirms |
| Heartbeat watcher poll burns CPU | Low | Low | 5s default conservative; configurable; only iterate active runs (`status === "running"`) |
| MetricRegistry memory leak với high-cardinality labels | Med | Med | Cap label count per metric (warn ở 1000); document anti-pattern |
| OTLP export network failure spam logs | Low | Low | Swallow errors via `logInternalError`; circuit-breaker after 5 consecutive fails |
| Histogram quantile inaccurate với fixed buckets | Med | Low | Document approximation; allow custom buckets per metric |
| Background watcher leak nếu session_shutdown miss | Low | Med | Per-session pattern (D17) — dispose ordering tested in 9.5.B; idempotent dispose |
| `events.jsonl` corruption blocks recovery | Low | High | Recovery validate seq monotonic via `scanSequence`; fallback "cancel run" if event log unreadable |
| Metric sink file lock contention | Low | Low | `appendFileSync` synchronous within process; cross-process not supported (document) |
| Retry policy over-aggressive → task storm | Med | Med | Default maxAttempts=3 conservative; jitter prevent thundering herd |
| Deadletter false positive on transient errors | Med | Med | Threshold default 3 attempts; user override per task; deadletter reversible (manual reset) |
| **`events.off` không tồn tại** trên ExtensionAPI EventBus | Mitigated | Was High | **D18**: 9.0.E preflight test verify; capture unsubscribe fn từ `events.on()` return — pattern matches existing `src/ui/render-scheduler.ts` |
| **Naming mismatch `WorkerHeartbeat` vs actual `WorkerHeartbeatState`** | Mitigated | Was High | 9.0.E preflight test verify field names; explicit import từ `worker-heartbeat.ts` (NOT alias) |
| **MetricRegistry singleton state leak across sessions** | Mitigated | Was Med | **D17**: per-session instance pattern; dispose trong session_shutdown |
| **DiagnosticReport schema breaking** (extra `metricsSnapshot` field) | Mitigated | Was Med | **D21**: `schemaVersion: 2` bump; field optional (undefined for v1 readers); secret redaction recursive |
| **Deadletter trigger ambiguity** (3 paths conflate) | Mitigated | Was Med | **D22**: 3 explicit trigger paths separated trong code (not one mega-handler) |
| **Recovery race với existing async.pid liveness check** | Mitigated | Was High | **D20** combinator reuses existing logic; new path không override existing async.pid check |

## 6. Testing Strategy

**Unit-level (~70 cases):** xem mục 9.5.B chi tiết.

**Integration (~7 scenarios):** xem mục 9.5.B.

**Performance budget:**
- Counter inc < 1μs.
- Histogram observe < 5μs.
- Registry snapshot full < 50ms cho 100 metrics.
- Heartbeat watcher tick < 100ms cho 50 active runs.
- Retry backoff jitter calculation < 1μs.
- Crash recovery detection < 200ms cho 50 runs.

**Property-based (optional):**
- Histogram quantile monotonicity (q1 < q2 ⇒ result(q1) ≤ result(q2)).
- Retry executor convergence (eventually success or give up within maxAttempts).

**Smoke manual (10 scenarios):** xem mục 9.5.B.

## 7. Open Questions (Pre-decide before Wave 1)

| P | Câu hỏi | Default đề xuất | Tác động |
|---|---|---|---|
| **P1** | Correlation ID format? | `{runId}:{taskId}:{spanCounter}` (D3) | Human-readable, deterministic |
| **P2** | Retry policy default config | `maxAttempts=3, backoffMs=1000, jitterRatio=0.3` (D6) | Industry standard |
| **P3** | Crash recovery: auto-resume vs prompt? | **Prompt** via Phase 8 ConfirmOverlay (D7) | Avoid replay risk |
| **P4** | Metric retention window default | 1h streaming, 24h JSONL (D8) | Cover 95% debug needs |
| **P5** | Histogram bucket strategy | Fixed exponential (D2) | Simple, predictable |
| **P6** | OTLP export priority | Implement, default-off (D10) | Enable team có observability stack |
| **P7** | Deadletter threshold default | >3 messages/hour alert (D11) | Conservative, false-positive minimal |
| **P8** | Background watcher polling interval | 5s default, 1-60s configurable (D9) | Balance responsiveness vs CPU |

**All P1-P8 decisions defaulted in D-table (mục 1.B).** User có thể override qua config nhưng default sane.

## 8. Dependencies & Sequencing

```
Phase 7 (DONE) ──► Phase 8 (Operator UX) ──► Phase 9 Wave 1 (Foundation)
                              │                       │
                              │              ┌────────┼────────┐
                              ▼              ▼        ▼        ▼
                   ConfirmOverlay reuse → 9.1 Reliability  9.2 Telemetry  9.3 Exporters
                   NotificationRouter reuse        │              │              │
                   diagnostic-export extend        └──────────────┼──────────────┘
                                                                  ▼
                                                            9.4 UI/Commands
                                                                  │
                                                                  ▼
                                                            9.5 Wiring + Tests
```

**Hard prerequisites Phase 8:**
- ✅ `NotificationRouter` (Phase 8.3.A) — used by 9.1.A/9.1.C/9.1.D for alerts.
- ✅ `ConfirmOverlay` (Phase 8.0) — used by 9.1.C recovery prompt.
- ✅ `diagnostic-export.ts` (Phase 8.2.D) — extended in 9.4.C.

**Parallelization opportunity:** Wave 2 vs Wave 3 có thể chạy song song (chỉ share Wave 1 foundation).

## 9. Effort Summary

| Wave | Items | Dev-days | Parallelizable |
|---|---|---|---|
| 1 | 9.0.A → B → C → D → **E preflight** | 4 | No (sequential foundation; 9.0.E gates Wave 2) |
| 2 | 9.1.A + 9.1.B + 9.1.C + 9.1.D | 5 | Partial (4 streams, .C depends .A/.B) |
| 3 | 9.2.A + 9.2.B + 9.2.C + 9.2.D | 4 | Yes (4 streams, low overlap) |
| 4 | 9.3.A + 9.3.B + 9.3.C + 9.4.A + 9.4.B + 9.4.C | 3 | Partial (5 streams; UI track 9.4.A→B→C critical path 2.5d) |
| 5 | 9.5.A + 9.5.B | 3 | No |
| **Total** | **19 sub-phases** | **19.5-22.5** | — |

**So với Phase 8 (14-18 dev-days):** Phase 9 lớn hơn ~25%, risk cao hơn vì touches state machine.

## 10. Acceptance Checklist (Wave 5 exit criteria)

- [x] Tất cả checkbox 9.0 → 9.5 (bao gồm 9.0.E preflight) tick `[x]`.
- [x] `npm test` pass: **389 unit** + **45 integration**, 0 fail (2026-04-29).
- [x] `npm run typecheck` clean.
- [x] Manual smoke 10 scenarios pass.
- [x] Performance budget thỏa: counter 0.597µs, histogram 0.551µs, snapshot 0.159ms, heartbeat watcher 61.777ms/50 runs, recovery detect 27.036ms/50 runs.
- [x] No regression: Phase 7+8 tests vẫn pass (full suite clean).
- [x] Config breaking? **No.** Schema additive (`reliability`, `otlp`, `observability` sections optional).
- [x] Default behavior unchanged: `autoRetry=false`, `autoRecover=false`, `otlp.enabled=false`, `observability.enabled` default `true` (sink/watcher gated bởi telemetry).
- [ ] Bump package version for next release (current workspace remained on `0.1.35`; release not requested in this Phase 9 implementation turn).
- [x] Migration guide trong README/release notes section.
- [x] **D18 verified**: 0 `events.off?.` references in Phase 9 code; all subscriptions use returned unsubscribe fn.
- [x] **D17 verified**: 0 module-level `globalRegistry`/singleton patterns; all observability state per-session, disposed in session_shutdown.
- [x] **D21 verified**: DiagnosticReport schemaVersion=2 khi metricsSnapshot present; schemaVersion undefined cho Phase 8 reports.
- [x] **No listener leak** test: 3x session_start/shutdown cycles → 0 residual subscriptions on `pi.events`.

## 11. Out of Scope (defer Phase 10+)

- Multi-host metric aggregation (cluster-wide registry).
- Slack/Discord webhook adapter (router supports custom sink, not built-in).
- t-digest histogram algorithm (defer; fixed buckets sufficient).
- Tracing UI (only metrics + correlation propagation in 9; trace viewer Phase 10).
- Auto-tuning retry policy (ML-based) — stay manual config Phase 9.
- Metric drift detection / anomaly alert beyond simple threshold.
- Custom event-to-metric mapping via DSL (hardcoded core only).
- pprof profiling export.
- Cross-language metric sharing (Pi-only Phase 9).

## 12. Path X Roadmap Summary

| Phase | Theme | Effort | Status |
|---|---|---|---|
| 6 | `.crew/` migration + autonomous policy | ~12d | ✅ DONE |
| 7 | UI Optimization (snapshot cache + render scheduler + 4 panes) | ~18d | ✅ DONE |
| **8** | **Operator Experience (Theme A)** | **14-18d** | ✅ **DONE** (verified 351 unit + 44 integration pass, version 0.1.34, all 17 sub-phases shipped) |
| **9** | **Observability + Reliability (Theme B+C)** | **19.5-22.5d** | ✅ **IMPLEMENTED** (verified 389 unit + 45 integration pass in workspace) |
| 10+ | TBD: Performance baseline (Theme D), distributed coordination, multi-host | — | Future |

**Path X total to Phase 9 done: ~63-67 dev-days** (Phase 6+7+8 done = 44d; Phase 9 = 19.5-22.5d remaining).

## 13. Implementation Kickoff Checklist (Pre-Wave 1)

Trước khi bắt đầu Wave 1 Phase 9, verify:

- [x] Phase 8 đã ship (`NotificationRouter`, `ConfirmOverlay`, `MailboxDetailOverlay/Compose/Preview/AgentPicker`, `heartbeat-aggregator.ts`, `health-pane.ts`, `diagnostic-export.ts`, `notification-sink.ts` available — verified existence + tests pass).
- [x] `npm test` baseline pass (351 unit + 44 integration từ Phase 8 — verified 2026-04-29).
- [x] `npm run typecheck` clean (verified Phase 8).
- [x] P1-P8 defaults reviewed (mục 7) — đã default trong D-table.
- [x] Branch mới skipped intentionally — user requested no separate branch.
- [x] Read `src/state/event-log.ts` để hiểu sequence cursor pattern — confirmed `seq` metadata + `sequencePath()` + `scanSequence()` + `sequenceCache` infrastructure present.
- [x] Read `src/runtime/worker-heartbeat.ts` để identify actual interface name — confirmed `WorkerHeartbeatState` (NOT "WorkerHeartbeat") + helper `isWorkerHeartbeatStale`.
- [x] Read `src/runtime/diagnostic-export.ts` — confirmed Phase 8 file structure (`DiagnosticReport` interface + `redactSecrets` regex `/(token|key|password|secret|credential|auth)/i`).
- [x] Verify ExtensionAPI surface — confirmed `EventBus.on()` returns unsubscribe fn (via `node_modules/@mariozechner/pi-coding-agent/dist/core/event-bus.d.ts`); **NO `events.off()` exists** → use returned unsubscribe (D18).
- [x] Read `src/runtime/team-runner.ts:executeTeamRun` để identify correlation wrap point.
- [x] Confirm Node.js >= 20 (AsyncLocalStorage stable since Node 16; package engines require Node >=20).
- [x] Decide nếu OTLP export ship trong Phase 9 hay defer Phase 10 (shipped default-off per D10).
- [x] **Wave 1 entry gate: 9.0.E preflight test pass** — block Wave 2 nếu fail.

**Sẵn sàng triển khai Phase 9 Path X. Phase 8 verified DONE.**

---

**Note on Theme B vs Theme C balance:** Phase 9 này combine 2 themes vì 5 synergy critical (mục 1.A). Nếu trong quá trình Wave 2/3 phát hiện effort blow up, có thể split:
- Phase 9a = B only (Wave 1 + Wave 3 + 9.4.A/B + part 9.5) ~12.5 dev-days (incl. 9.0.E preflight).
- Phase 9b = C only (Wave 1 reuse + Wave 2 + part 9.4.C + part 9.5) ~10 dev-days.

Decision split chỉ đưa ra khi có data thực tế từ Wave 1 progress.

---

## Appendix A — Review Fixes Applied (2026-04-29)

Plan đã được update post-review với các blocking issues đã giải quyết:

| Issue | Fix | Reference |
|---|---|---|
| `WorkerHeartbeat` vs actual `WorkerHeartbeatState` | Replace tất cả references; explicit import | 9.0.D, 9.1.A, D-decisions |
| `events.off?.()` không tồn tại trên EventBus | Use `events.on()` returned unsubscribe fn pattern | 9.2.A, D18, 9.0.E preflight |
| MetricRegistry singleton dispose semantics ambiguous | Per-session instance pattern (consistent Phase 8) | 9.0.B, 9.5.A, D17 |
| 9.0.E preflight ExtensionAPI verify thiếu | Added new sub-phase + test file | 9.0.E (NEW) |
| Retry executor state-machine semantics chưa rõ | Document attempts[] + no `failed → running` transition | 9.1.B, D19 |
| Crash recovery race với async.pid liveness | Combinator clause uses existing logic | 9.1.C, D20 |
| Deadletter trigger 3 paths conflate | Separate explicit paths (a/b/c) | 9.1.D, D22 |
| DiagnosticReport schema breaking | schemaVersion: 2 + redactSecrets recursive | 9.4.C, D21 |
| `renderMetricsPane` signature lệch Phase 8 pattern | Change to `(snapshot, opts: { registry })` | 9.4.B |
| Naming convention regex redundant | Tighten `^crew\.[a-z]+\.[a-z][a-z_]*$` | 9.0.B, D13 |
| 9.1.A `for (const task of /* loaded.tasks */)` placeholder | Resolved với `loadRunManifestById(...).tasks` | 9.1.A skeleton |
| 9.5.A wire pseudocode `..., registry` placeholder | Spec rõ `MetricFileSinkOptions` interface | 9.2.D, 9.5.A |
| Phase 8 status label "NEXT" nhưng đã DONE | Update Path X table → ✅ DONE | Section 12 |
| Acceptance no-listener-leak test thiếu | Added 3x cycle test | Section 10 |
