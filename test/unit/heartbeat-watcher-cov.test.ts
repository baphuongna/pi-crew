import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRegistry } from "../../src/observability/metric-registry.ts";
import { HeartbeatWatcher } from "../../src/runtime/heartbeat-watcher.ts";
import type { ManifestCache } from "../../src/runtime/manifest-cache.ts";

/** Minimal mock metric registry for testing. */
function mockRegistry(): MetricRegistry {
	const gauges = new Map<string, { set: (labels: Record<string, string>, value: number) => void }>();
	const counters = new Map<string, { inc: (labels: Record<string, string>) => void }>();

	return {
		gauge: (name: string, _help: string) => {
			if (!gauges.has(name)) gauges.set(name, { set: () => {} });
			return gauges.get(name)!;
		},
		counter: (name: string, _help: string) => {
			if (!counters.has(name)) counters.set(name, { inc: () => {} });
			return counters.get(name)!;
		},
	} as unknown as MetricRegistry;
}

/** Minimal mock manifest cache that returns no runs. */
function mockManifestCache(): ManifestCache {
	return {
		list: () => [],
		get: () => undefined,
		refresh: async () => {},
	} as unknown as ManifestCache;
}

/** Minimal mock router. */
function mockRouter() {
	return {
		enqueue: () => true,
	};
}

describe("HeartbeatWatcher constructor", () => {
	it("creates watcher without error", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.ok(watcher);
	});
});

describe("HeartbeatWatcher.dispose", () => {
	it("can be called without start", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.dispose());
	});

	it("can be called multiple times safely", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		watcher.dispose();
		watcher.dispose();
		assert.ok(true, "no throw on repeated dispose");
	});
});

describe("HeartbeatWatcher.start and dispose", () => {
	it("start does not throw", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.start());
		watcher.dispose();
	});

	it("dispose after start cleans up", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		watcher.start();
		watcher.dispose();
		// Double dispose should be safe
		assert.doesNotThrow(() => watcher.dispose());
	});

	it("start disposes previous timer before scheduling new one", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		// Calling start twice should not throw
		watcher.start();
		assert.doesNotThrow(() => watcher.start());
		watcher.dispose();
	});
});

describe("HeartbeatWatcher.tick", () => {
	it("tick with no running runs does not throw", () => {
		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: mockManifestCache(),
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.tick());
		watcher.dispose();
	});

	it("tick does not throw with empty manifest cache list", () => {
		const cache: ManifestCache = {
			list: () => [],
			get: () => undefined,
			refresh: async () => {},
		} as unknown as ManifestCache;

		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: cache,
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.tick());
		watcher.dispose();
	});

	it("tick does not throw for non-running status runs", () => {
		const cache: ManifestCache = {
			list: () => [
				{
					runId: "completed_run",
					status: "completed",
					stateRoot: "/nonexistent",
				},
			],
			get: () => undefined,
			refresh: async () => {},
		} as unknown as ManifestCache;

		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: cache,
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.tick());
		watcher.dispose();
	});

	it("tick does not throw when stateRoot does not exist", () => {
		const cache: ManifestCache = {
			list: () => [
				{
					runId: "ghost_run",
					status: "running",
					stateRoot: "/nonexistent/path/12345",
				},
			],
			get: () => undefined,
			refresh: async () => {},
		} as unknown as ManifestCache;

		const watcher = new HeartbeatWatcher({
			cwd: "/tmp",
			manifestCache: cache,
			registry: mockRegistry(),
			router: mockRouter(),
		});
		assert.doesNotThrow(() => watcher.tick());
		watcher.dispose();
	});
});
