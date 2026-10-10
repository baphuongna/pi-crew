import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HANDOFF_TEMPLATE, renderTaskPacket } from "../../../../src/runtime/task-packet.ts";
import type { TaskPacket } from "../../../../src/state/types.ts";

/**
 * U10: the handoff template is restructured to the 6 PINNED sections ported
 * from durable's SUMMARIZATION_PROMPT (pi-durable compaction.ts:68-103):
 * Goal / Constraints & Preferences / Progress (Done·In Progress·Blocked) /
 * Key Decisions / Next Steps / Critical Context. The R3-2 Provenance identity
 * footer is retained as a 7th, final section (orthogonal pinned contract).
 */
const PINNED_SECTIONS = [
	"### Goal",
	"### Constraints & Preferences",
	"### Progress",
	"### Key Decisions",
	"### Next Steps",
	"### Critical Context",
] as const;

describe("HANDOFF_TEMPLATE", () => {
	it("contains all 6 pinned U10 sections in the pinned order", () => {
		let previous = -1;
		for (const section of PINNED_SECTIONS) {
			const index = HANDOFF_TEMPLATE.indexOf(section);
			assert.ok(index >= 0, `${section} section present`);
			assert.ok(index > previous, `${section} must come after the previous pinned section`);
			previous = index;
		}
	});

	it("Progress section instructs the Done·In Progress·Blocked split", () => {
		const progressStart = HANDOFF_TEMPLATE.indexOf("### Progress");
		const progressEnd = HANDOFF_TEMPLATE.indexOf("### ", progressStart + 1);
		const progressBody = HANDOFF_TEMPLATE.slice(progressStart, progressEnd);
		for (const group of ["Done:", "In Progress:", "Blocked:"]) {
			assert.ok(progressBody.includes(group), `Progress mentions '${group}'`);
		}
	});

	it("starts with ## Handoff heading", () => {
		assert.ok(HANDOFF_TEMPLATE.startsWith("## Handoff"));
	});

	it("is non-empty string", () => {
		assert.ok(typeof HANDOFF_TEMPLATE === "string");
		assert.ok(HANDOFF_TEMPLATE.length > 0);
	});

	it("has exactly the 6 pinned sections plus Provenance (7 subsections)", () => {
		const matches = HANDOFF_TEMPLATE.match(/^### /gm);
		assert.equal(matches?.length, 7);
	});

	it("includes the R3-2 Provenance subsection (worker PI_* self-report), pinned last", () => {
		assert.match(HANDOFF_TEMPLATE, /^### Provenance$/m);
		// Provenance stays the FINAL section so it can never push a pinned
		// content section out of a truncated render.
		const lastSection = HANDOFF_TEMPLATE.trim().slice(HANDOFF_TEMPLATE.trim().lastIndexOf("###"));
		assert.ok(lastSection.startsWith("### Provenance"), "Provenance is the last section");
	});

	it("keeps HTML comments as placeholders (skipped by the legacy parser)", () => {
		// The parser treats <!-- --> bodies as placeholders, never content —
		// every pinned section must be pure placeholder in the template.
		assert.ok(HANDOFF_TEMPLATE.includes("<!--"), "template still uses comment placeholders");
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
