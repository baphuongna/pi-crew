import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenderScheduler } from "../../src/ui/render-scheduler.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeEventBus {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
	emit(event: string, payload: unknown): void {
		for (const h of this.handlers.get(event) ?? []) h(payload);
	}
	listenerCount(event: string): number {
		return this.handlers.get(event)?.size ?? 0;
	}
}

describe("RenderScheduler constructor", () => {
	it("accepts no event bus", () => {
		const scheduler = new RenderScheduler(undefined, () => {});
		scheduler.dispose();
	});

	it("accepts custom event list", () => {
		const bus = new FakeEventBus();
		const scheduler = new RenderScheduler(bus, () => {}, {
			events: ["custom.event"],
		});
		assert.equal(bus.listenerCount("custom.event"), 1);
		scheduler.dispose();
		assert.equal(bus.listenerCount("custom.event"), 0);
	});

	it("uses default debounceMs when not specified", () => {
		const scheduler = new RenderScheduler(undefined, () => {});
		// No assertion on internal value, just verify no crash
		scheduler.dispose();
	});
});

describe("RenderScheduler flush", () => {
	it("calls render function on flush", () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => { renders++; }, { debounceMs: 9999, fallbackMs: 9999 });
		scheduler.flush();
		assert.equal(renders, 1);
		scheduler.dispose();
	});

	it("collapses multiple flush calls into render loop", () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => {
			renders++;
			// Simulate render triggering another flush
			if (renders === 1) scheduler.flush();
		}, { debounceMs: 9999, fallbackMs: 9999 });
		scheduler.flush();
		assert.equal(renders, 2);
		scheduler.dispose();
	});

	it("does not infinite-loop beyond safety valve", () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => {
			renders++;
			scheduler.flush(); // Always re-flush
		}, { debounceMs: 9999, fallbackMs: 9999 });
		scheduler.flush();
		// Should stop at 5 iterations (safety valve)
		assert.equal(renders, 5);
		scheduler.dispose();
	});
});

describe("RenderScheduler schedule", () => {
	it("debounces multiple schedule calls", async () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => { renders++; }, { debounceMs: 20, fallbackMs: 9999 });
		scheduler.schedule();
		scheduler.schedule();
		scheduler.schedule();
		assert.equal(renders, 0, "should not render immediately");
		await sleep(50);
		assert.equal(renders, 1, "should render once after debounce");
		scheduler.dispose();
	});

	it("does not schedule after dispose", async () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => { renders++; }, { debounceMs: 5, fallbackMs: 9999 });
		scheduler.dispose();
		scheduler.schedule();
		await sleep(20);
		assert.equal(renders, 0);
	});
});

describe("RenderScheduler event subscription", () => {
	it("subscribes to events and triggers render", async () => {
		const bus = new FakeEventBus();
		let renders = 0;
		const scheduler = new RenderScheduler(bus, () => { renders++; }, {
			debounceMs: 5,
			fallbackMs: 9999,
			events: ["test.event"],
		});
		bus.emit("test.event", {});
		await sleep(20);
		assert.ok(renders >= 1);
		scheduler.dispose();
	});

	it("unsubscribes from all events on dispose", () => {
		const bus = new FakeEventBus();
		const scheduler = new RenderScheduler(bus, () => {}, {
			events: ["e1", "e2"],
		});
		assert.equal(bus.listenerCount("e1"), 1);
		assert.equal(bus.listenerCount("e2"), 1);
		scheduler.dispose();
		assert.equal(bus.listenerCount("e1"), 0);
		assert.equal(bus.listenerCount("e2"), 0);
	});
});

describe("RenderScheduler invalidate coalesce", () => {
	it("coalesces same runId invalidations", async () => {
		const bus = new FakeEventBus();
		const invalidations: string[] = [];
		const scheduler = new RenderScheduler(bus, () => {}, {
			debounceMs: 5,
			fallbackMs: 9999,
			events: ["e"],
			invalidateCoalesceMs: 30,
			onInvalidate: (payload) => {
				invalidations.push((payload as { runId?: string })?.runId ?? "");
			},
		});
		bus.emit("e", { runId: "r1" });
		bus.emit("e", { runId: "r1" });
		bus.emit("e", { runId: "r1" });
		await sleep(50);
		scheduler.dispose();
		// Should collapse to 1 per runId
		const r1Count = invalidations.filter((r) => r === "r1").length;
		assert.equal(r1Count, 1);
	});

	it("passes non-runId payloads through immediately", () => {
		const bus = new FakeEventBus();
		let count = 0;
		const scheduler = new RenderScheduler(bus, () => {}, {
			debounceMs: 9999,
			fallbackMs: 9999,
			events: ["e"],
			invalidateCoalesceMs: 9999,
			onInvalidate: () => { count++; },
		});
		bus.emit("e", { noRunId: true });
		assert.equal(count, 1);
		scheduler.dispose();
	});
});

describe("RenderScheduler dispose", () => {
	it("clears all timers and prevents future renders", async () => {
		let renders = 0;
		const scheduler = new RenderScheduler(undefined, () => { renders++; }, {
			debounceMs: 5,
			fallbackMs: 20,
		});
		await sleep(50);
		const beforeDispose = renders;
		scheduler.dispose();
		await sleep(50);
		assert.equal(renders, beforeDispose, "no renders after dispose");
	});

	it("is idempotent", () => {
		const scheduler = new RenderScheduler(undefined, () => {});
		scheduler.dispose();
		scheduler.dispose();
		scheduler.dispose();
	});
});
