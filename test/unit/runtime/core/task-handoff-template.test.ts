import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HANDOFF_TEMPLATE, renderTaskPacket } from "../../../../src/runtime/task-packet.ts";
import type { TaskPacket } from "../../../../src/state/types.ts";

describe("HANDOFF_TEMPLATE", () => {
	it("contains Summary section", () => {
		assert.match(HANDOFF_TEMPLATE, /### Summary/);
	});

	it("contains Files Changed section", () => {
		assert.match(HANDOFF_TEMPLATE, /### Files Changed/);
	});

	it("contains Tests / Verification section", () => {
		assert.match(HANDOFF_TEMPLATE, /### Tests \/ Verification/);
	});

	it("contains Follow-ups section", () => {
		assert.match(HANDOFF_TEMPLATE, /### Follow-ups/);
	});

	it("starts with ## Handoff heading", () => {
		assert.ok(HANDOFF_TEMPLATE.startsWith("## Handoff"));
	});

	it("is non-empty string", () => {
		assert.ok(typeof HANDOFF_TEMPLATE === "string");
		assert.ok(HANDOFF_TEMPLATE.length > 0);
	});

	it("has exactly 4 subsections", () => {
		const matches = HANDOFF_TEMPLATE.match(/^### /gm);
		assert.equal(matches?.length, 4);
	});
});

describe("renderTaskPacket with handoff integration", () => {
	const minimalPacket: TaskPacket = {
		objective: "Test objective",
		scope: "workspace",
		scopePath: undefined,
		repo: "test-repo",
		worktree: undefined,
		branchPolicy: "test branch policy",
		commitPolicy: "test commit policy",
		reportingContract: "test reporting",
		escalationPolicy: "test escalation",
		constraints: ["Stay within scope."],
		expectedArtifacts: ["prompt", "result"],
		verification: {
			requiredGreenLevel: "none",
			commands: [],
			allowManualEvidence: true,
		},
		acceptanceTests: [],
	};

	it("renders valid JSON in task packet output", () => {
		const rendered = renderTaskPacket(minimalPacket);
		assert.ok(rendered.includes("```json"));
		const jsonStr = rendered.split("```json")[1].split("```")[0].trim();
		const parsed = JSON.parse(jsonStr);
		assert.equal(parsed.objective, "Test objective");
	});
});
