import assert from "node:assert/strict";
import test from "node:test";
import {
	canTransitionToPhase,
	createWorkflowStateMachine,
	getPhaseInputs,
	type PhaseGuardContext,
	type PhaseState,
	transitionPhase,
	validatePhasePreconditions,
	type WorkflowStateMachine,
} from "../../../src/runtime/workflow-state.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function phase(overrides: Partial<PhaseState> & { name: string }): PhaseState {
	return {
		status: "pending",
		inputs: [],
		outputs: [],
		...overrides,
	};
}

function emptyContext(overrides?: Partial<PhaseGuardContext>): PhaseGuardContext {
	return {
		completedArtifacts: [],
		previousPhaseStatus: "completed",
		taskResults: [],
		...overrides,
	};
}

// ── createWorkflowStateMachine ────────────────────────────────────────────────

test("createWorkflowStateMachine: returns machine with all phases pending", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	assert.equal(machine.phases.length, 2);
	assert.equal(machine.phases[0]!.status, "pending");
	assert.equal(machine.phases[1]!.status, "pending");
	assert.equal(machine.currentPhaseIndex, 0);
});

test("createWorkflowStateMachine: preserves existing status values", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan", status: "completed" })]);
	assert.equal(machine.phases[0]!.status, "completed");
});

test("createWorkflowStateMachine: empty phases returns empty machine", () => {
	const machine = createWorkflowStateMachine([]);
	assert.equal(machine.phases.length, 0);
	assert.equal(machine.currentPhaseIndex, 0);
});

// ── getPhaseInputs ────────────────────────────────────────────────────────────

test("getPhaseInputs: returns declared inputs for valid index", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan", inputs: ["requirements.md"] })]);
	assert.deepEqual(getPhaseInputs(machine, 0), ["requirements.md"]);
});

test("getPhaseInputs: returns empty array for out-of-bounds index", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	assert.deepEqual(getPhaseInputs(machine, 5), []);
});

test("getPhaseInputs: returns empty array for phase with no inputs", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	assert.deepEqual(getPhaseInputs(machine, 0), []);
});

// ── canTransitionToPhase ──────────────────────────────────────────────────────

test("canTransitionToPhase: first phase is always allowed", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = canTransitionToPhase(machine, 0, emptyContext());
	assert.equal(result.allowed, true);
});

test("canTransitionToPhase: out-of-bounds index is rejected", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = canTransitionToPhase(machine, 1, emptyContext());
	assert.equal(result.allowed, false);
	assert.ok(result.reason!.includes("out of bounds"));
});

test("canTransitionToPhase: negative index is rejected", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = canTransitionToPhase(machine, -1, emptyContext());
	assert.equal(result.allowed, false);
});

test("canTransitionToPhase: previous phase must be completed", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const result = canTransitionToPhase(machine, 1, emptyContext({ previousPhaseStatus: "running" }));
	assert.equal(result.allowed, false);
	assert.ok(result.reason!.includes("Previous phase status is 'running'"));
});

test("canTransitionToPhase: previous phase completed allows transition", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const result = canTransitionToPhase(machine, 1, emptyContext({ previousPhaseStatus: "completed" }));
	assert.equal(result.allowed, true);
});

test("canTransitionToPhase: previous phase skipped allows transition", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const result = canTransitionToPhase(machine, 1, emptyContext({ previousPhaseStatus: "skipped" }));
	assert.equal(result.allowed, true);
});

test("canTransitionToPhase: missing inputs block transition", () => {
	const machine = createWorkflowStateMachine([
		phase({ name: "plan" }),
		phase({ name: "execute", inputs: ["plan-output.md", "specs.json"] }),
	]);
	const result = canTransitionToPhase(
		machine,
		1,
		emptyContext({
			previousPhaseStatus: "completed",
			completedArtifacts: ["plan-output.md"],
		}),
	);
	assert.equal(result.allowed, false);
	assert.ok(result.reason!.includes("specs.json"));
	assert.ok(result.reason!.includes("Missing required artifacts"));
});

test("canTransitionToPhase: all inputs present allows transition", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute", inputs: ["plan-output.md"] })]);
	const result = canTransitionToPhase(
		machine,
		1,
		emptyContext({
			previousPhaseStatus: "completed",
			completedArtifacts: ["plan-output.md"],
		}),
	);
	assert.equal(result.allowed, true);
});

test("canTransitionToPhase: phase with no inputs only requires previous completion", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const result = canTransitionToPhase(machine, 1, emptyContext({ previousPhaseStatus: "completed" }));
	assert.equal(result.allowed, true);
});

// ── validatePhasePreconditions ────────────────────────────────────────────────

test("validatePhasePreconditions: returns ready when all inputs present", () => {
	const machine = createWorkflowStateMachine([phase({ name: "execute", inputs: ["plan.md", "specs.json"] })]);
	const result = validatePhasePreconditions(
		machine,
		emptyContext({
			completedArtifacts: ["plan.md", "specs.json"],
		}),
	);
	assert.equal(result.ready, true);
	assert.deepEqual(result.blocking, []);
});

test("validatePhasePreconditions: returns blocking list when inputs missing", () => {
	const machine = createWorkflowStateMachine([phase({ name: "execute", inputs: ["plan.md", "specs.json"] })]);
	const result = validatePhasePreconditions(
		machine,
		emptyContext({
			completedArtifacts: ["plan.md"],
		}),
	);
	assert.equal(result.ready, false);
	assert.deepEqual(result.blocking, ["specs.json"]);
});

test("validatePhasePreconditions: phase with no inputs is always ready", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = validatePhasePreconditions(machine, emptyContext());
	assert.equal(result.ready, true);
	assert.deepEqual(result.blocking, []);
});

test("validatePhasePreconditions: out-of-bounds current index returns not ready", () => {
	const machine: WorkflowStateMachine = { phases: [], currentPhaseIndex: 0 };
	const result = validatePhasePreconditions(machine, emptyContext());
	assert.equal(result.ready, false);
	assert.deepEqual(result.blocking, ["No phase at index 0."]);
});

// ── transitionPhase (immutability) ────────────────────────────────────────────

test("transitionPhase: does not mutate the original machine", () => {
	const original = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = transitionPhase(original, 0, "running");
	assert.equal(original.phases[0]!.status, "pending");
	assert.equal(result.machine.phases[0]!.status, "running");
	assert.notEqual(original, result.machine);
	assert.notEqual(original.phases, result.machine.phases);
});

test("transitionPhase: sets startedAt when transitioning to running", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	const result = transitionPhase(machine, 0, "running");
	assert.equal(typeof result.machine.phases[0]!.startedAt, "string");
	assert.ok(result.machine.phases[0]!.startedAt!.length > 0);
});

test("transitionPhase: sets finishedAt on terminal status", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" })]);
	for (const terminalStatus of ["completed", "failed", "skipped"] as const) {
		const result = transitionPhase(machine, 0, terminalStatus);
		assert.equal(typeof result.machine.phases[0]!.finishedAt, "string", `finishedAt for ${terminalStatus}`);
	}
});

test("transitionPhase: advances currentPhaseIndex to the target index", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const result = transitionPhase(machine, 1, "running");
	assert.equal(result.machine.currentPhaseIndex, 1);
});

test("transitionPhase: does not regress currentPhaseIndex", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute" })]);
	const advanced = { ...machine, currentPhaseIndex: 1 };
	const result = transitionPhase(advanced, 0, "completed");
	assert.equal(result.machine.currentPhaseIndex, 1);
});

test("transitionPhase: with context that blocks returns machine UNCHANGED with guardResult", () => {
	const machine = createWorkflowStateMachine([phase({ name: "plan" }), phase({ name: "execute", inputs: ["missing.md"] })]);
	const ctx = emptyContext({
		previousPhaseStatus: "completed",
		completedArtifacts: [],
	});
	const result = transitionPhase(machine, 1, "running", ctx);
	// Machine should be UNCHANGED (not auto-failed)
	assert.equal(result.machine.phases[1]!.status, "pending");
	assert.equal(result.machine.phases[1]!.finishedAt, undefined);
	// Guard result should be present
	assert.ok(result.guardResult);
	assert.equal(result.guardResult!.allowed, false);
	assert.ok(result.guardResult!.reason!.includes("Missing required artifacts"));
});

test("transitionPhase: with context that allows proceeds normally", () => {
	const machine = createWorkflowStateMachine([
		phase({ name: "plan", outputs: ["plan.md"] }),
		phase({ name: "execute", inputs: ["plan.md"] }),
	]);
	const ctx = emptyContext({
		previousPhaseStatus: "completed",
		completedArtifacts: ["plan.md"],
	});
	const result = transitionPhase(machine, 1, "running", ctx);
	assert.equal(result.machine.phases[1]!.status, "running");
	assert.equal(result.guardResult, undefined);
});

// ── End-to-end lifecycle ──────────────────────────────────────────────────────

test("full lifecycle: plan → execute → review with artifact passing", () => {
	let machine = createWorkflowStateMachine([
		phase({ name: "plan", outputs: ["plan.md"] }),
		phase({ name: "execute", inputs: ["plan.md"], outputs: ["code.diff"] }),
		phase({ name: "review", inputs: ["plan.md", "code.diff"] }),
	]);

	// Phase 0: plan
	assert.ok(validatePhasePreconditions(machine, emptyContext()).ready);
	machine = transitionPhase(machine, 0, "running").machine;
	assert.equal(machine.phases[0]!.status, "running");
	machine = transitionPhase(machine, 0, "completed").machine;
	assert.equal(machine.phases[0]!.status, "completed");

	// Phase 1: execute
	const afterPlan = emptyContext({
		completedArtifacts: ["plan.md"],
		previousPhaseStatus: machine.phases[0]!.status,
	});
	assert.ok(validatePhasePreconditions(machine, afterPlan).ready);
	assert.ok(canTransitionToPhase(machine, 1, afterPlan).allowed);
	machine = transitionPhase(machine, 1, "running").machine;
	machine = transitionPhase(machine, 1, "completed").machine;

	// Phase 2: review
	const afterExecute = emptyContext({
		completedArtifacts: ["plan.md", "code.diff"],
		previousPhaseStatus: machine.phases[1]!.status,
	});
	assert.ok(validatePhasePreconditions(machine, afterExecute).ready);
	assert.ok(canTransitionToPhase(machine, 2, afterExecute).allowed);
	machine = transitionPhase(machine, 2, "running").machine;
	machine = transitionPhase(machine, 2, "completed").machine;

	assert.equal(machine.phases[0]!.status, "completed");
	assert.equal(machine.phases[1]!.status, "completed");
	assert.equal(machine.phases[2]!.status, "completed");
	assert.equal(machine.currentPhaseIndex, 2);
});
