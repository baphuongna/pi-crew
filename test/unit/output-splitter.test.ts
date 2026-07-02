import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitCoalescedOutput } from "../../src/runtime/task-runner/output-splitter.ts";

describe("splitCoalescedOutput", () => {
	describe("strategy 1: delimiter parse", () => {
		it("parses 2-task delimiter output cleanly", () => {
			const raw = `Some preamble.

<<<TASK_RESULT:task-a>>>
Exploring auth module...
Found 3 files.
<<<END_TASK_RESULT>>>

Some interlude.

<<<TASK_RESULT:task-b>>>
Exploring db module...
Found 5 files.
<<<END_TASK_RESULT>>>

Trailing text.`;

			const result = splitCoalescedOutput(raw, ["task-a", "task-b"]);
			assert.equal(result.length, 2);
			assert.equal(result[0]!.taskId, "task-a");
			assert.equal(result[0]!.strategy, "delimiter");
			assert.match(result[0]!.text, /Exploring auth module/);
			assert.match(result[0]!.text, /Found 3 files/);
			assert.equal(result[1]!.taskId, "task-b");
			assert.equal(result[1]!.strategy, "delimiter");
			assert.match(result[1]!.text, /Exploring db module/);
		});

		it("returns tasks in input order regardless of delimit order", () => {
			const raw = `<<<TASK_RESULT:b>>>B content.<<<END_TASK_RESULT>>>
<<<TASK_RESULT:a>>>A content.<<<END_TASK_RESULT>>>`;
			const result = splitCoalescedOutput(raw, ["a", "b"]);
			assert.equal(result[0]!.taskId, "a");
			assert.equal(result[1]!.taskId, "b");
		});

		it("handles whitespace and newlines inside delimiters", () => {
			const raw = `<<<TASK_RESULT:x>>>


  Multi-line
  content with leading/trailing whitespace.


<<<END_TASK_RESULT>>>`;
			const result = splitCoalescedOutput(raw, ["x"]);
			assert.equal(result.length, 1);
			assert.match(result[0]!.text, /Multi-line/);
			// Should be trimmed
			assert.ok(!result[0]!.text.startsWith("\n"));
			assert.ok(!result[0]!.text.endsWith("\n"));
		});
	});

	describe("strategy 2: section heading parse", () => {
		it("parses `### Task N of M` headers in order", () => {
			const raw = `# Summary

### Task 1 of 2
First task output here.

### Task 2 of 2
Second task output here.`;

			const result = splitCoalescedOutput(raw, ["task-a", "task-b"]);
			assert.equal(result.length, 2);
			assert.equal(result[0]!.strategy, "section");
			assert.equal(result[1]!.strategy, "section");
			assert.match(result[0]!.text, /First task output/);
			assert.match(result[1]!.text, /Second task output/);
		});

		it("parses `### Task {id}` direct-id headers", () => {
			const raw = `# Output

### Task task-alpha
First.

### Task task-beta
Second.`;

			const result = splitCoalescedOutput(raw, ["task-alpha", "task-beta"]);
			assert.equal(result.length, 2);
			assert.equal(result[0]!.strategy, "section");
			assert.match(result[0]!.text, /First\./);
			assert.match(result[1]!.text, /Second\./);
		});
	});

	describe("strategy 3: broadcast fallback", () => {
		it("broadcasts raw output when no delimiters or sections found", () => {
			const raw = "Some unstructured output with no markers at all.";
			const result = splitCoalescedOutput(raw, ["a", "b", "c"]);
			assert.equal(result.length, 3);
			assert.equal(result[0]!.strategy, "broadcast");
			assert.equal(result[1]!.strategy, "broadcast");
			assert.equal(result[2]!.strategy, "broadcast");
			assert.equal(result[0]!.text, raw);
			assert.equal(result[1]!.text, raw);
			assert.equal(result[2]!.text, raw);
		});

		it("broadcasts when only SOME tasks got delimiters (partial match)", () => {
			const raw = `<<<TASK_RESULT:only-one>>>
Only task 1 got a delimiter.
<<<END_TASK_RESULT>>>`;
			const result = splitCoalescedOutput(raw, ["first", "second"]);
			// Strategy 2 needs all-or-nothing; partial delimiter + no section
			// header triggers broadcast.
			assert.equal(result[0]!.strategy, "broadcast");
			assert.equal(result[1]!.strategy, "broadcast");
		});
	});

	describe("edge cases", () => {
		it("returns empty array when taskIds is empty", () => {
			assert.deepEqual(splitCoalescedOutput("anything", []), []);
		});

		it("returns whole output for single-task group via delimiter strategy", () => {
			const raw = "Just one result here.";
			const result = splitCoalescedOutput(raw, ["only"]);
			assert.equal(result.length, 1);
			assert.equal(result[0]!.taskId, "only");
			assert.equal(result[0]!.text, raw);
		});

		it("ignores delimiter for unknown task IDs", () => {
			const raw = `<<<TASK_RESULT:real-task>>>
content.
<<<END_TASK_RESULT>>>

<<<TASK_RESULT:phantom-task>>>
phantom.
<<<END_TASK_RESULT>>>`;
			// Request two tasks — real-task (has delimiter) and missing-task
			// (no delimiter at all). real-task gets delimiter hit; missing-task
			// does not. delimiterHits.size=1 ≠ taskIds.length=2 → falls
			// through to strategy 2 (sections), then strategy 3 (broadcast).
			const result = splitCoalescedOutput(raw, ["real-task", "missing-task"]);
			assert.equal(result.length, 2);
			assert.equal(result[0]!.strategy, "broadcast");
			assert.equal(result[1]!.strategy, "broadcast");
			assert.equal(result[0]!.text, raw);
		});

		it("handles empty raw output with multi-task group (broadcast empty)", () => {
			const result = splitCoalescedOutput("", ["a", "b"]);
			assert.equal(result.length, 2);
			// No delimiters, no sections, no body — falls through to broadcast (empty)
			assert.equal(result[0]!.strategy, "broadcast");
			assert.equal(result[0]!.text, "");
		});
	});
});
