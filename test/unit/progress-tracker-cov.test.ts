import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProgressTracker } from "../../src/runtime/output/progress-tracker.ts";

function makeSession() {
	const listeners: Array<(event: any) => void> = [];
	return {
		subscribe: (listener: (event: any) => void) => {
			listeners.push(listener);
			return () => {
				const idx = listeners.indexOf(listener);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		emit: (event: any) => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("ProgressTracker", () => {
	it("track returns new progress for new agentId", () => {
		const tracker = new ProgressTracker();
		const session = makeSession();
		const progress = tracker.track(session, "agent-1", "run-1");
		assert.equal(progress.toolCalls, 0);
		assert.equal(progress.status, "running");
		assert.equal(progress.currentTool, null);
		tracker.untrack("agent-1");
	});

	it("track returns existing progress for same agentId", () => {
		const tracker = new ProgressTracker();
		const session = makeSession();
		const p1 = tracker.track(session, "agent-2", "run-1");
		const p2 = tracker.track(session, "agent-2", "run-1");
		assert.equal(p1, p2);
		tracker.untrack("agent-2");
	});

	describe("event handling", () => {
		it("handles tool_execution_start", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-3", "run-1");
			session.emit({ type: "tool_execution_start", toolName: "bash" });
			assert.equal(progress.toolCalls, 1);
			assert.equal(progress.currentTool, "bash");
			assert.ok(progress.toolStartTime);
			tracker.untrack("agent-3");
		});

		it("handles tool_execution_end without error", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-4", "run-1");
			session.emit({ type: "tool_execution_start", toolName: "write" });
			session.emit({ type: "tool_execution_end", isError: false });
			assert.equal(progress.currentTool, null);
			assert.equal(progress.errors.length, 0);
			tracker.untrack("agent-4");
		});

		it("handles tool_execution_end with error", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-5", "run-1");
			session.emit({
				type: "tool_execution_end",
				isError: true,
				result: "permission denied",
			});
			assert.equal(progress.errors.length, 1);
			assert.ok(progress.errors[0].includes("permission denied"));
			tracker.untrack("agent-5");
		});

		it("handles turn_start", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-6", "run-1");
			session.emit({ type: "turn_start" });
			assert.equal(progress.turns, 1);
			session.emit({ type: "turn_start" });
			assert.equal(progress.turns, 2);
			tracker.untrack("agent-6");
		});

		it("handles agent_end", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-7", "run-1");
			session.emit({ type: "agent_end" });
			assert.equal(progress.status, "completed");
			tracker.untrack("agent-7");
		});

		it("handles agent_start", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-8", "run-1");
			progress.status = "completed";
			session.emit({ type: "agent_start" });
			assert.equal(progress.status, "running");
			tracker.untrack("agent-8");
		});
	});

	describe("untrack", () => {
		it("removes tracked session", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			tracker.track(session, "agent-9", "run-1");
			tracker.untrack("agent-9");
			assert.equal(tracker.getProgress("agent-9"), undefined);
		});

		it("does not throw for unknown agentId", () => {
			const tracker = new ProgressTracker();
			assert.doesNotThrow(() => tracker.untrack("unknown"));
		});
	});

	describe("getProgress", () => {
		it("returns undefined for untracked agent", () => {
			const tracker = new ProgressTracker();
			assert.equal(tracker.getProgress("unknown"), undefined);
		});

		it("returns progress for tracked agent", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			tracker.track(session, "agent-10", "run-1");
			assert.ok(tracker.getProgress("agent-10"));
			tracker.untrack("agent-10");
		});

		it("no longer receives events after untrack", () => {
			const tracker = new ProgressTracker();
			const session = makeSession();
			const progress = tracker.track(session, "agent-11", "run-1");
			tracker.untrack("agent-11");
			session.emit({ type: "turn_start" });
			assert.equal(progress.turns, 0);
		});
	});
});
