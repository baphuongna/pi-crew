import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitCoalescedOutput } from "../../../../src/runtime/task-runner/output-splitter.ts";

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
	});

	describe("G20 fail-closed: partial delimiter-hit", () => {
		it("deadletters when only SOME tasks got delimiters — no broadcast leak", () => {
			const raw = `Worker preamble for the whole group.

<<<TASK_RESULT:first>>>
SECRET-BODY-FOR-FIRST — delimited content for the one task that followed the format.
<<<END_TASK_RESULT>>>

Unattributed trailing prose with no delimiters for the others.`;
			const result = splitCoalescedOutput(raw, ["first", "second"]);
			// G20: partial hit (1 of 2 KNOWN taskIds delimited) → the whole output
			// is unpartitionable. Previously this broadcast the FULL raw — leaking
			// SECRET-BODY-FOR-FIRST to `second` — to every task.
			assert.equal(result.length, 2);
			assert.equal(result[0]!.strategy, "deadletter");
			assert.equal(result[1]!.strategy, "deadletter");
			// No task may receive any partition of the output: empty text,
			// never the delimited body, never the full raw.
			for (const entry of result) {
				assert.equal(entry.text, "");
				assert.ok(!entry.text.includes("SECRET-BODY-FOR-FIRST"));
				assert.notEqual(entry.text, raw);
			}
		});

		it("3-task group with 1 delimited task → deadletter for ALL, zero cross-task content", () => {
			const raw = `Group preamble mentioning all work.

<<<TASK_RESULT:task-one>>>
SECRET-BODY-ONE.
<<<END_TASK_RESULT>>>

Task two and task three results were merged into this trailing prose without delimiters.`;
			const result = splitCoalescedOutput(raw, ["task-one", "task-two", "task-three"]);
			assert.equal(result.length, 3);
			for (const entry of result) {
				assert.equal(entry.strategy, "deadletter", `${entry.taskId} must be deadletter`);
				assert.equal(entry.text, "", `${entry.taskId} must carry NO content`);
			}
			// Belt: no entry carries the delimited body or the full raw.
			assert.ok(!result.some((e) => e.text.includes("SECRET-BODY-ONE")));
			assert.ok(!result.some((e) => e.text === raw));
		});

		it("partial hit wins even when valid section headings exist (fail-closed, no section fallback)", () => {
			const raw = `### Task 1 of 2
First section body.

<<<TASK_RESULT:a>>>
SECRET-DELIMITED-BODY.
<<<END_TASK_RESULT>>>

### Task 2 of 2
Second section body.`;
			const result = splitCoalescedOutput(raw, ["a", "b"]);
			// A partial delimiter hit marks the output unpartitionable — it must
			// NOT silently degrade into section parsing either (that would still
			// partition an output the worker only half-followed).
			assert.equal(result[0]!.strategy, "deadletter");
			assert.equal(result[1]!.strategy, "deadletter");
			assert.equal(result[0]!.text, "");
			assert.equal(result[1]!.text, "");
		});

		it("regression: full delimiter hit still partitions per-task with own bodies only", () => {
			const raw = `<<<TASK_RESULT:a>>>
SECRET-BODY-A.
<<<END_TASK_RESULT>>>

<<<TASK_RESULT:b>>>
SECRET-BODY-B.
<<<END_TASK_RESULT>>>

<<<TASK_RESULT:c>>>
SECRET-BODY-C.
<<<END_TASK_RESULT>>>`;
			const result = splitCoalescedOutput(raw, ["a", "b", "c"]);
			assert.equal(result.length, 3);
			assert.ok(result.every((e) => e.strategy === "delimiter"));
			assert.match(result[0]!.text, /SECRET-BODY-A/);
			assert.match(result[1]!.text, /SECRET-BODY-B/);
			assert.match(result[2]!.text, /SECRET-BODY-C/);
			// No cross-task leak on the happy path either.
			assert.ok(!result[0]!.text.includes("SECRET-BODY-B"));
			assert.ok(!result[1]!.text.includes("SECRET-BODY-C"));
		});

		it("regression: zero-hit output with no sections still broadcasts (unchanged)", () => {
			const raw = "No markers whatsoever, shared context only.";
			const result = splitCoalescedOutput(raw, ["a", "b"]);
			assert.equal(result[0]!.strategy, "broadcast");
			assert.equal(result[1]!.strategy, "broadcast");
			assert.equal(result[0]!.text, raw);
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

		it("partial hit on unknown-ID delimiter → deadletter (G20)", () => {
			const raw = `<<<TASK_RESULT:real-task>>>
content.
<<<END_TASK_RESULT>>>

<<<TASK_RESULT:phantom-task>>>
phantom.
<<<END_TASK_RESULT>>>`;
			// Request two tasks — real-task (has delimiter) and missing-task
			// (no delimiter at all). real-task gets delimiter hit; missing-task
			// does not. delimiterHits.size=1 ≠ taskIds.length=2 → G20 partial
			// hit: fail closed to deadletter for the WHOLE group (previously this
			// broadcast the full raw — including real-task's and the phantom's
			// delimited bodies — to missing-task).
			const result = splitCoalescedOutput(raw, ["real-task", "missing-task"]);
			assert.equal(result.length, 2);
			assert.equal(result[0]!.strategy, "deadletter");
			assert.equal(result[1]!.strategy, "deadletter");
			assert.equal(result[0]!.text, "");
			assert.equal(result[1]!.text, "");
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
