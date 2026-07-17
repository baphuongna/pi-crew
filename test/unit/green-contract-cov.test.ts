import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createVerificationEvidence,
	evaluateGreenContract,
	greenLevelSatisfies,
	inferGreenLevelFromTask,
} from "../../src/runtime/green-contract.ts";
import type { VerificationContract } from "../../src/state/types.ts";

function makeContract(overrides: Partial<VerificationContract> = {}): VerificationContract {
	return {
		requiredGreenLevel: overrides.requiredGreenLevel ?? "none",
		commands: overrides.commands ?? [],
		allowManualEvidence: overrides.allowManualEvidence ?? false,
	};
}

describe("green-contract", () => {
	describe("greenLevelSatisfies", () => {
		it("none satisfies none", () => {
			assert.equal(greenLevelSatisfies("none", "none"), true);
		});

		it("targeted satisfies none", () => {
			assert.equal(greenLevelSatisfies("targeted", "none"), true);
		});

		it("none does not satisfy targeted", () => {
			assert.equal(greenLevelSatisfies("none", "targeted"), false);
		});

		it("workspace satisfies package", () => {
			assert.equal(greenLevelSatisfies("workspace", "package"), true);
		});

		it("merge_ready satisfies workspace", () => {
			assert.equal(greenLevelSatisfies("merge_ready", "workspace"), true);
		});

		it("package does not satisfy workspace", () => {
			assert.equal(greenLevelSatisfies("package", "workspace"), false);
		});

		it("merge_ready satisfies merge_ready", () => {
			assert.equal(greenLevelSatisfies("merge_ready", "merge_ready"), true);
		});
	});

	describe("evaluateGreenContract", () => {
		it("returns satisfied when observed >= required", () => {
			const result = evaluateGreenContract(makeContract({ requiredGreenLevel: "targeted" }), {
				requiredGreenLevel: "targeted",
				observedGreenLevel: "targeted",
				satisfied: true,
				commands: [],
			});
			assert.equal(result.satisfied, true);
			assert.equal(result.observedGreenLevel, "targeted");
		});

		it("returns unsatisfied when observed < required", () => {
			const result = evaluateGreenContract(makeContract({ requiredGreenLevel: "workspace" }));
			assert.equal(result.satisfied, false);
			assert.equal(result.observedGreenLevel, "none");
		});

		it("defaults to none when no evidence provided", () => {
			const result = evaluateGreenContract(makeContract({ requiredGreenLevel: "none" }));
			assert.equal(result.observedGreenLevel, "none");
			assert.equal(result.satisfied, true);
		});
	});

	describe("inferGreenLevelFromTask", () => {
		it("returns none when task failed", () => {
			assert.equal(inferGreenLevelFromTask(false, makeContract({ requiredGreenLevel: "targeted" })), "none");
		});

		it("returns none when required is none", () => {
			assert.equal(inferGreenLevelFromTask(true, makeContract({ requiredGreenLevel: "none" })), "none");
		});

		it("returns required level when allowManualEvidence and success", () => {
			assert.equal(
				inferGreenLevelFromTask(
					true,
					makeContract({
						requiredGreenLevel: "workspace",
						allowManualEvidence: true,
					}),
				),
				"workspace",
			);
		});

		it("returns targeted when not allowManualEvidence and success", () => {
			assert.equal(
				inferGreenLevelFromTask(
					true,
					makeContract({
						requiredGreenLevel: "workspace",
						allowManualEvidence: false,
					}),
				),
				"targeted",
			);
		});
	});

	describe("createVerificationEvidence", () => {
		it("creates evidence with correct green level for success", () => {
			const contract = makeContract({
				requiredGreenLevel: "targeted",
				commands: ["npm test"],
				allowManualEvidence: true,
			});
			const evidence = createVerificationEvidence(contract, true, "tests passed");
			assert.equal(evidence.observedGreenLevel, "targeted");
			assert.equal(evidence.satisfied, true);
			assert.equal(evidence.commands.length, 1);
			assert.equal(evidence.commands[0].cmd, "npm test");
			assert.equal(evidence.commands[0].status, "not_run");
			assert.equal(evidence.notes, "tests passed");
		});

		it("creates evidence with none for failure", () => {
			const contract = makeContract({
				requiredGreenLevel: "targeted",
				commands: ["npm test"],
				allowManualEvidence: false,
			});
			const evidence = createVerificationEvidence(contract, false, "tests failed");
			assert.equal(evidence.observedGreenLevel, "none");
			assert.equal(evidence.satisfied, false);
		});

		it("creates evidence with multiple commands", () => {
			const contract = makeContract({
				requiredGreenLevel: "package",
				commands: ["npm test", "npm run lint"],
				allowManualEvidence: true,
			});
			const evidence = createVerificationEvidence(contract, true, "all pass");
			assert.equal(evidence.commands.length, 2);
		});
	});
});
