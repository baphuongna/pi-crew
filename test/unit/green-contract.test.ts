import test from "node:test";
import assert from "node:assert/strict";
import {
	greenLevelSatisfies,
	evaluateGreenContract,
	inferGreenLevelFromTask,
	createVerificationEvidence,
} from "../../src/runtime/green-contract.ts";
import type { GreenLevel, VerificationContract, VerificationEvidence } from "../../src/state/types.ts";

/**
 * Round 30 (test coverage gaps): `green-contract.ts` provides green-level
 * verification contract evaluation for task verification gates.
 *
 * All exports are pure functions — no file I/O.
 */

const BASE_CONTRACT: VerificationContract = {
	requiredGreenLevel: "targeted",
	commands: ["npm test"],
	allowManualEvidence: true,
};

// ─── greenLevelSatisfies ───────────────────────────────────────────────────

test("greenLevelSatisfies: same level satisfies", () => {
	assert.equal(greenLevelSatisfies("targeted", "targeted"), true);
});

test("greenLevelSatisfies: higher level satisfies lower", () => {
	assert.equal(greenLevelSatisfies("workspace", "targeted"), true);
	assert.equal(greenLevelSatisfies("merge_ready", "none"), true);
});

test("greenLevelSatisfies: lower level does not satisfy higher", () => {
	assert.equal(greenLevelSatisfies("none", "targeted"), false);
	assert.equal(greenLevelSatisfies("targeted", "workspace"), false);
});

test("greenLevelSatisfies: none satisfies none", () => {
	assert.equal(greenLevelSatisfies("none", "none"), true);
});

// ─── evaluateGreenContract ─────────────────────────────────────────────────

test("evaluateGreenContract: satisfied when evidence meets requirement", () => {
	const result = evaluateGreenContract(BASE_CONTRACT, {
		requiredGreenLevel: "targeted",
		observedGreenLevel: "targeted",
		satisfied: true,
		commands: [],
		notes: "",
	});
	assert.equal(result.satisfied, true);
	assert.equal(result.observedGreenLevel, "targeted");
});

test("evaluateGreenContract: not satisfied when evidence below requirement", () => {
	const result = evaluateGreenContract(BASE_CONTRACT, {
		requiredGreenLevel: "targeted",
		observedGreenLevel: "none",
		satisfied: false,
		commands: [],
		notes: "",
	});
	assert.equal(result.satisfied, false);
	assert.equal(result.observedGreenLevel, "none");
});

test("evaluateGreenContract: defaults to 'none' without evidence", () => {
	const contract: VerificationContract = { requiredGreenLevel: "none", commands: [], allowManualEvidence: false };
	const result = evaluateGreenContract(contract);
	assert.equal(result.observedGreenLevel, "none");
	assert.equal(result.satisfied, true);
});

test("evaluateGreenContract: not satisfied when no evidence but required > none", () => {
	const result = evaluateGreenContract(BASE_CONTRACT);
	assert.equal(result.satisfied, false);
	assert.equal(result.observedGreenLevel, "none");
});

// ─── inferGreenLevelFromTask ───────────────────────────────────────────────

test("inferGreenLevelFromTask: returns 'none' for failed task", () => {
	assert.equal(inferGreenLevelFromTask(false, BASE_CONTRACT), "none");
});

test("inferGreenLevelFromTask: returns 'none' when required is 'none'", () => {
	const contract: VerificationContract = { requiredGreenLevel: "none", commands: [], allowManualEvidence: false };
	assert.equal(inferGreenLevelFromTask(true, contract), "none");
});

test("inferGreenLevelFromTask: returns required level when success and allowManualEvidence", () => {
	assert.equal(inferGreenLevelFromTask(true, BASE_CONTRACT), "targeted");
});

test("inferGreenLevelFromTask: returns 'targeted' when success but no manual evidence", () => {
	const contract: VerificationContract = { requiredGreenLevel: "workspace", commands: [], allowManualEvidence: false };
	assert.equal(inferGreenLevelFromTask(true, contract), "targeted");
});

// ─── createVerificationEvidence ────────────────────────────────────────────

test("createVerificationEvidence: creates evidence from success", () => {
	const evidence = createVerificationEvidence(BASE_CONTRACT, true, "all tests pass");
	assert.equal(evidence.observedGreenLevel, "targeted");
	assert.equal(evidence.satisfied, true);
	assert.equal(evidence.notes, "all tests pass");
	assert.equal(evidence.commands.length, 1);
	assert.equal(evidence.commands[0]!.cmd, "npm test");
	assert.equal(evidence.commands[0]!.status, "not_run");
});

test("createVerificationEvidence: creates evidence from failure", () => {
	const evidence = createVerificationEvidence(BASE_CONTRACT, false, "tests failed");
	assert.equal(evidence.observedGreenLevel, "none");
	assert.equal(evidence.satisfied, false);
	assert.equal(evidence.notes, "tests failed");
});
