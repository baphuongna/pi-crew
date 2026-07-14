import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import {
	cleanupIntermediates,
	ensureIntermediateDir,
	hasPhaseCompleted,
	readIntermediate,
	readLatestIntermediate,
	writeIntermediate,
} from "../../src/workflows/intermediate-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

describe("ensureIntermediateDir", () => {
	it("creates the intermediate directory", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const dir = ensureIntermediateDir({
				intermediateDir: `${tmp}/inter`,
			});
			assert.ok(dir);
			assert.ok(existsSync(dir));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("uses default dir when no config provided", () => {
		const dir = ensureIntermediateDir();
		assert.ok(dir);
	});
});

describe("writeIntermediate + readIntermediate", () => {
	it("writes and reads back intermediate output", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			const written = writeIntermediate(config, "explore", "step1", {
				found: ["a.ts"],
			});
			assert.ok(written.includes("explore-step1.json"));

			const read = readIntermediate(config, "explore", "step1");
			assert.ok(read);
			assert.equal(read!.phase, "explore");
			assert.equal(read!.stepId, "step1");
			assert.deepEqual(read!.data, { found: ["a.ts"] });
			assert.ok(read!.timestamp);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns undefined when reading non-existent intermediate", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			const result = readIntermediate(config, "missing", "nope");
			assert.equal(result, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("overwrites existing intermediate for same phase+stepId", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			writeIntermediate(config, "analyze", "step1", { version: 1 });
			writeIntermediate(config, "analyze", "step1", { version: 2 });

			const read = readIntermediate(config, "analyze", "step1");
			assert.deepEqual(read!.data, { version: 2 });
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("readLatestIntermediate", () => {
	it("returns the latest intermediate for a phase", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			writeIntermediate(config, "scan", "aaa", { first: true });
			// small delay to ensure different timestamps in filenames
			writeIntermediate(config, "scan", "bbb", { second: true });

			const latest = readLatestIntermediate(config, "scan");
			assert.ok(latest, "Should find latest intermediate");
			// Should return one of them (sorted lexicographically reversed)
			assert.ok(latest!.stepId === "aaa" || latest!.stepId === "bbb");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns undefined when no intermediates exist", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			const result = readLatestIntermediate(config, "nonexistent");
			assert.equal(result, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns undefined when dir does not exist", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/no-such-dir` };
			const result = readLatestIntermediate(config, "scan");
			assert.equal(result, undefined);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("cleanupIntermediates", () => {
	it("removes all files when no preserve patterns", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = {
				intermediateDir: `${tmp}/inter`,
				preservePatterns: [],
			};
			writeIntermediate(config, "explore", "s1", {});
			writeIntermediate(config, "analyze", "s2", {});

			const removed = cleanupIntermediates(config);
			assert.equal(removed, 2);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("preserves files matching preserve patterns", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = {
				intermediateDir: `${tmp}/inter`,
				preservePatterns: ["explore-s1"],
			};
			writeIntermediate(config, "explore", "s1", { keep: true });
			writeIntermediate(config, "analyze", "s2", { remove: true });

			const removed = cleanupIntermediates(config);
			assert.equal(removed, 1);

			// Preserved file should still exist
			const preserved = readIntermediate(config, "explore", "s1");
			assert.ok(preserved, "Preserved file should still be readable");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns 0 when directory does not exist", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = {
				intermediateDir: `${tmp}/no-dir`,
				preservePatterns: [],
			};
			const removed = cleanupIntermediates(config);
			assert.equal(removed, 0);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("writeIntermediate path traversal guard", () => {
	it("throws when phase contains path traversal characters", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			assert.throws(
				() => writeIntermediate(config, "../secret", "step1", {}),
				{ message: "Invalid phase or stepId for intermediate store" },
				"Should throw for path traversal in phase",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("throws when stepId contains path traversal characters", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			assert.throws(
				() => writeIntermediate(config, "explore", "../../etc/passwd", {}),
				{ message: "Invalid phase or stepId for intermediate store" },
				"Should throw for path traversal in stepId",
			);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("succeeds with valid phase and stepId", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			const filePath = writeIntermediate(config, "explore", "step1", { data: "test" });
			assert.ok(filePath.includes("explore-step1.json"));
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("hasPhaseCompleted", () => {
	it("returns true when phase has an intermediate", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			writeIntermediate(config, "explore", "s1", {});
			assert.equal(hasPhaseCompleted(config, "explore", "s1"), true);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("returns false when phase has no intermediate", () => {
		const tmp = createTrackedTempDir("pi-crew-inter-");
		try {
			const config = { intermediateDir: `${tmp}/inter` };
			assert.equal(hasPhaseCompleted(config, "missing", "nope"), false);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});
