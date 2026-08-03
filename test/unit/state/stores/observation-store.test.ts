import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { type CompressedObservation, type Observation, ObservationStore, stripPrivacyTags } from "../../../../src/state/stores/observation-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
	return {
		tool: "read",
		input: "file content here",
		output: "success",
		filesRead: ["a.ts"],
		filesModified: [],
		timestamp: Date.now(),
		sessionId: "session-1",
		...overrides,
	};
}

function makeCompressed(overrides: Partial<CompressedObservation> = {}): CompressedObservation {
	return {
		summary: "used read tool on a.ts",
		patterns: ["file-reading"],
		decisions: ["read-first"],
		filesAffected: ["a.ts"],
		relevanceScore: 0.8,
		timestamp: Date.now(),
		sessionId: "session-1",
		...overrides,
	};
}

describe("stripPrivacyTags", () => {
	it("strips content between default privacy tags", () => {
		const input = "api key is <secret>my-secret-key</secret> end";
		const result = stripPrivacyTags(input);
		assert.equal(result, "api key is [REDACTED] end");
	});

	it("strips content between <private> tags", () => {
		const input = "user data <private>John Doe SSN 123</private> done";
		const result = stripPrivacyTags(input);
		assert.equal(result, "user data [REDACTED] done");
	});

	it("strips content between <credentials> tags", () => {
		const input = "login <credentials>admin:password</credentials> ok";
		const result = stripPrivacyTags(input);
		assert.equal(result, "login [REDACTED] ok");
	});

	it("returns unchanged string when no privacy tags", () => {
		const input = "nothing to hide here";
		assert.equal(stripPrivacyTags(input), input);
	});

	it("handles custom privacy tags", () => {
		const input = "my <sensitive>data</sensitive> end";
		const result = stripPrivacyTags(input, {
			maxObservations: 100,
			maxCompressed: 50,
			privacyTags: ["<sensitive>"],
		});
		assert.equal(result, "my [REDACTED] end");
	});

	it("handles empty string", () => {
		assert.equal(stripPrivacyTags(""), "");
	});

	it("handles multiple privacy tags in same string", () => {
		const input = "a <secret>s1</secret> b <private>p1</private> c";
		const result = stripPrivacyTags(input);
		assert.equal(result, "a [REDACTED] b [REDACTED] c");
	});
});

describe("ObservationStore", () => {
	it("records observations and retrieves them", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.record(makeObservation({ tool: "read", input: "test" }));
			store.record(makeObservation({ tool: "write", input: "test2" }));

			const recent = store.getRecent(10);
			assert.equal(recent.length, 2);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("strips privacy tags from recorded observations", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.record(
				makeObservation({
					input: "key is <secret>abc123</secret>",
					output: "done",
				}),
			);

			const recent = store.getRecent(1);
			assert.equal(recent[0]!.input, "key is [REDACTED]");
			assert.equal(recent[0]!.output, "done");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("enforces max observations capacity", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath, {
				maxObservations: 3,
			});
			for (let i = 0; i < 5; i++) {
				store.record(makeObservation({ tool: `tool-${i}`, timestamp: i }));
			}

			const recent = store.getRecent(10);
			assert.equal(recent.length, 3);
			// Should keep the last 3
			assert.equal(recent[0]!.tool, "tool-2");
			assert.equal(recent[2]!.tool, "tool-4");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("getRecent returns last N observations", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			for (let i = 0; i < 10; i++) {
				store.record(makeObservation({ tool: `tool-${i}` }));
			}
			const recent = store.getRecent(3);
			assert.equal(recent.length, 3);
			assert.equal(recent[2]!.tool, "tool-9");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("stores and retrieves compressed observations", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.addCompressed(makeCompressed({ summary: "pattern A", relevanceScore: 0.9 }));
			store.addCompressed(makeCompressed({ summary: "pattern B", relevanceScore: 0.5 }));

			const compressed = store.getCompressed(2);
			assert.equal(compressed.length, 2);
			// Sorted by relevance descending
			assert.equal(compressed[0]!.summary, "pattern A");
			assert.equal(compressed[1]!.summary, "pattern B");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("enforces max compressed capacity", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath, { maxCompressed: 2 });
			for (let i = 0; i < 5; i++) {
				store.addCompressed(makeCompressed({ summary: `item-${i}` }));
			}
			const compressed = store.getCompressed(10);
			assert.equal(compressed.length, 2);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("injectCompressed formats output correctly", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.addCompressed(
				makeCompressed({
					summary: "Read files for analysis",
					patterns: ["file-reading"],
					decisions: ["read-first"],
					filesAffected: ["src/main.ts"],
				}),
			);

			const text = store.injectCompressed();
			assert.ok(text.includes("## Observations from Previous Sessions"));
			assert.ok(text.includes("Read files for analysis"));
			assert.ok(text.includes("file-reading"));
			assert.ok(text.includes("src/main.ts"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("injectCompressed returns empty string when no data", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			assert.equal(store.injectCompressed(), "");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("persists and loads from disk", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.record(makeObservation({ tool: "bash", input: "ls" }));
			store.addCompressed(makeCompressed({ summary: "ran ls" }));
			store.save();

			const store2 = new ObservationStore(storePath);
			assert.equal(store2.stats.observations, 1);
			assert.equal(store2.stats.compressed, 1);

			const recent = store2.getRecent(1);
			assert.equal(recent[0]!.tool, "bash");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("stats reports correct counts", () => {
		const tmp = createTrackedTempDir("pi-crew-obs-");
		try {
			const storePath = path.join(tmp, "obs.json");
			const store = new ObservationStore(storePath);
			store.record(makeObservation());
			store.record(makeObservation());
			store.addCompressed(makeCompressed());

			const stats = store.stats;
			assert.equal(stats.observations, 2);
			assert.equal(stats.compressed, 1);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
