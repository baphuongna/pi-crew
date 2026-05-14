/**
 * Bench: RenderScheduler.flush() throughput with mock render and event bus.
 *
 * Measures the cost of one flush cycle when `pendingRender` collapsing kicks in.
 * Schedules N events and counts the time to settle.
 */
import { performance } from "node:perf_hooks";
import { RenderScheduler } from "../../src/ui/render-scheduler.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 200);
const EVENTS_PER_ITER = 200;

function createEvents() {
	const handlers = new Map<string, Set<(p: unknown) => void>>();
	return {
		on(event: string, handler: (p: unknown) => void) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit(event: string, payload: unknown) {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
	};
}

const samples: number[] = [];
for (let i = 0; i < ITERS; i++) {
	const events = createEvents();
	let renders = 0;
	const scheduler = new RenderScheduler(events, () => { renders += 1; }, { debounceMs: 1, fallbackMs: 1000 });

	const t0 = performance.now();
	for (let j = 0; j < EVENTS_PER_ITER; j++) {
		events.emit("crew.subagent.completed", { id: `s${j}`, runId: `run-${i}`, status: "completed" });
	}
	scheduler.flush();
	const elapsed = performance.now() - t0;
	scheduler.dispose?.();
	samples.push(elapsed);
	if (renders === 0) throw new Error("scheduler did not render");
}

samples.sort((a, b) => a - b);
const out = {
	name: "render-flush",
	unit: "ms",
	iters: ITERS,
	eventsPerIter: EVENTS_PER_ITER,
	min: round(samples[0]),
	p50: round(percentile(samples, 0.5)),
	p95: round(percentile(samples, 0.95)),
	p99: round(percentile(samples, 0.99)),
	max: round(samples[samples.length - 1]),
};
process.stdout.write(JSON.stringify(out) + "\n");

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number { return Math.round(n * 100) / 100; }
