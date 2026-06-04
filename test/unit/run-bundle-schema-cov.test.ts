import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRunBundle, assertRunBundle } from "../../src/extension/run-bundle-schema.ts";

function validBundle(): Record<string, unknown> {
	return {
		schemaVersion: 1,
		exportedAt: "2026-01-01T00:00:00Z",
		manifest: {
			schemaVersion: 1,
			runId: "r1",
			team: "test",
			goal: "test goal",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			status: "completed",
			workspaceMode: "single",
			cwd: "/tmp",
			stateRoot: "/tmp/s",
			artifactsRoot: "/tmp/a",
			tasksPath: "/tmp/tasks.json",
			eventsPath: "/tmp/events.jsonl",
			artifacts: [],
		},
		tasks: [{
			id: "t1", runId: "r1", role: "agent", agent: "a1",
			title: "task", status: "completed", dependsOn: [], cwd: "/tmp",
		}],
		events: [{
			time: "2026-01-01T00:00:00Z", type: "run.created", runId: "r1",
		}],
		artifactPaths: [],
	};
}

describe("validateRunBundle", () => {
	it("accepts a valid bundle", () => {
		const result = validateRunBundle(validBundle());
		assert.equal(result.ok, true);
		assert.deepEqual(result.errors, []);
	});

	it("rejects non-object input", () => {
		const result = validateRunBundle("not an object");
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("must be an object")));
	});

	it("rejects null input", () => {
		const result = validateRunBundle(null);
		assert.equal(result.ok, false);
	});

	it("rejects wrong schemaVersion", () => {
		const bundle = validBundle();
		bundle.schemaVersion = 2;
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
	});

	it("rejects missing exportedAt", () => {
		const bundle = validBundle();
		delete bundle.exportedAt;
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("exportedAt")));
	});

	it("rejects invalid manifest status", () => {
		const bundle = validBundle();
		(bundle.manifest as Record<string, unknown>).status = "bogus";
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("status")));
	});

	it("rejects non-array tasks", () => {
		const bundle = validBundle();
		bundle.tasks = "nope";
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("tasks must be an array")));
	});

	it("rejects task with missing required fields", () => {
		const bundle = validBundle();
		bundle.tasks = [{ id: "t1" }];
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("tasks[0].runId")));
	});

	it("rejects invalid artifactPaths", () => {
		const bundle = validBundle();
		bundle.artifactPaths = [123];
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("artifactPaths")));
	});

	it("rejects event missing required fields", () => {
		const bundle = validBundle();
		bundle.events = [{ type: "run.created" }];
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("events[0]")));
	});

	it("rejects artifact with invalid fields", () => {
		const bundle = validBundle();
		(bundle.manifest as Record<string, unknown>).artifacts = [{ kind: 123 }];
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("artifacts")));
	});

	it("rejects manifest with wrong workspaceMode", () => {
		const bundle = validBundle();
		(bundle.manifest as Record<string, unknown>).workspaceMode = "parallel";
		const result = validateRunBundle(bundle);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes("workspaceMode")));
	});
});

describe("assertRunBundle", () => {
	it("does not throw for valid bundle", () => {
		assert.doesNotThrow(() => assertRunBundle(validBundle()));
	});

	it("throws for invalid bundle", () => {
		assert.throws(
			() => assertRunBundle({ schemaVersion: 99 }),
			(err) => err instanceof Error && err.message.includes("not a valid"),
		);
	});

	it("throws for null input", () => {
		assert.throws(() => assertRunBundle(null));
	});
});
