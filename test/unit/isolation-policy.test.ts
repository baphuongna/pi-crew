import assert from "node:assert/strict";
import test from "node:test";
import { resolveTaskRuntimeKind } from "../../src/runtime/model/runtime-policy.ts";

test("isolation policy defaults non-isolated roles to configured runtime", () => {
	assert.equal(
		resolveTaskRuntimeKind("live-session", "reviewer", {
			defaultRuntime: "child-process",
		}),
		"child-process",
	);
	assert.equal(
		resolveTaskRuntimeKind("child-process", "reviewer", {
			defaultRuntime: "live-session",
		}),
		"live-session",
	);
});

test("isolation policy isolated roles always use child-process unless scaffold", () => {
	assert.equal(
		resolveTaskRuntimeKind("live-session", "executor", {
			isolatedRoles: ["executor"],
			defaultRuntime: "live-session",
		}),
		"child-process",
	);
	assert.equal(
		resolveTaskRuntimeKind("scaffold", "executor", {
			isolatedRoles: ["executor"],
			defaultRuntime: "child-process",
		}),
		"scaffold",
	);
});

test("depth guard forces child-process when PI_CREW_DEPTH > 0", () => {
	const nested = { PI_CREW_DEPTH: "1" };
	const root = { PI_CREW_DEPTH: "0" };
	// Nested live-session → should fall back to child-process
	assert.equal(resolveTaskRuntimeKind("live-session", "explorer", undefined, nested), "child-process");
	assert.equal(resolveTaskRuntimeKind("live-session", "reviewer", undefined, nested), "child-process");
	// Root level → live-session is fine
	assert.equal(resolveTaskRuntimeKind("live-session", "explorer", undefined, root), "live-session");
	// Child-process at any depth → stays child-process
	assert.equal(resolveTaskRuntimeKind("child-process", "explorer", undefined, nested), "child-process");
	// Scaffold never overridden
	assert.equal(resolveTaskRuntimeKind("scaffold", "explorer", undefined, nested), "scaffold");
});
