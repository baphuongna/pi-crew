import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrewRuntimeConfig } from "../../src/config/config.ts";
import type { CrewAgentRecord } from "../../src/runtime/crew-agent-runtime.ts";
import { GroupJoinManager, resolveGroupJoinMode, shouldGroupJoin } from "../../src/runtime/group-join.ts";

// Note: deliverGroupJoin requires file I/O and is tested in the existing
// test/unit/group-join.test.ts. Here we add additional coverage for pure
// functions and the GroupJoinManager class.

describe("group-join (cov)", () => {
	describe("resolveGroupJoinMode", () => {
		it("returns 'smart' by default", () => {
			assert.equal(resolveGroupJoinMode(undefined), "smart");
		});

		it("returns configured 'off'", () => {
			assert.equal(
				resolveGroupJoinMode({
					groupJoin: "off",
				} as unknown as CrewRuntimeConfig),
				"off",
			);
		});

		it("returns configured 'group'", () => {
			assert.equal(
				resolveGroupJoinMode({
					groupJoin: "group",
				} as unknown as CrewRuntimeConfig),
				"group",
			);
		});
	});

	describe("shouldGroupJoin", () => {
		it("returns false for 'off' mode regardless of batch size", () => {
			assert.equal(shouldGroupJoin("off", [{} as any]), false);
		});

		it("returns true for 'group' mode with any batch", () => {
			assert.equal(shouldGroupJoin("group", [{} as any]), true);
		});

		it("returns false for 'smart' mode with single task", () => {
			assert.equal(shouldGroupJoin("smart", [{} as any]), false);
		});

		it("returns true for 'smart' mode with multiple tasks", () => {
			assert.equal(shouldGroupJoin("smart", [{} as any, {} as any]), true);
		});

		it("returns false for 'group' mode with empty batch", () => {
			assert.equal(shouldGroupJoin("group", []), false);
		});
	});

	describe("GroupJoinManager", () => {
		function makeRecord(taskId: string): CrewAgentRecord {
			return {
				id: taskId,
				runId: "run_1",
				taskId,
				agent: "test-agent",
				role: "executor",
				runtime: "scaffold",
				status: "completed",
				startedAt: new Date().toISOString(),
			} as CrewAgentRecord;
		}

		it("returns 'pass' for unregistered agent", () => {
			const mgr = new GroupJoinManager(() => undefined);
			assert.equal(mgr.onAgentComplete(makeRecord("unknown")), "pass");
			mgr.dispose();
		});

		it("delivers when all agents in group complete", () => {
			let delivered = false;
			let deliveredRecords: CrewAgentRecord[] = [];
			const mgr = new GroupJoinManager((records, partial) => {
				delivered = true;
				deliveredRecords = records;
				assert.equal(partial, false);
			});
			mgr.registerGroup("g1", ["a", "b"]);
			assert.equal(mgr.onAgentComplete(makeRecord("a")), "held");
			assert.equal(mgr.onAgentComplete(makeRecord("b")), "delivered");
			assert.ok(delivered);
			assert.equal(deliveredRecords.length, 2);
			mgr.dispose();
		});

		it("isGrouped returns true for registered agents", () => {
			const mgr = new GroupJoinManager(() => undefined);
			mgr.registerGroup("g2", ["x", "y"]);
			assert.equal(mgr.isGrouped("x"), true);
			assert.equal(mgr.isGrouped("z"), false);
			mgr.dispose();
		});

		it("returns 'pass' for already delivered group", () => {
			const mgr = new GroupJoinManager(() => undefined);
			mgr.registerGroup("g3", ["c"]);
			assert.equal(mgr.onAgentComplete(makeRecord("c")), "delivered");
			assert.equal(mgr.onAgentComplete(makeRecord("c")), "pass");
			mgr.dispose();
		});

		it("timeout delivers partial results", (_, done) => {
			let partialDelivered = false;
			const mgr = new GroupJoinManager((records, partial) => {
				if (partial) {
					partialDelivered = true;
					assert.equal(records.length, 1);
					mgr.dispose();
					done();
				}
			}, 50);
			mgr.registerGroup("g4", ["d", "e"]);
			mgr.onAgentComplete(makeRecord("d"));
			// "e" never completes, timeout should fire
		});
	});
});
