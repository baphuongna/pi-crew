import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTaskRuntimeKind } from "../../src/runtime/runtime-policy.ts";

describe("runtime-policy", () => {
	describe("resolveTaskRuntimeKind", () => {
		it("returns scaffold when globalKind is scaffold", () => {
			assert.equal(resolveTaskRuntimeKind("scaffold", "executor", undefined), "scaffold");
		});

		it("returns scaffold regardless of other arguments", () => {
			assert.equal(
				resolveTaskRuntimeKind("scaffold", "executor", {
					isolatedRoles: ["executor"],
				}),
				"scaffold",
			);
		});

		it("returns child-process for isolated roles", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "reviewer", {
					isolatedRoles: ["reviewer"],
				}),
				"child-process",
			);
		});

		it("returns globalKind when role is not isolated", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", { isolatedRoles: ["reviewer"] }, { PI_CREW_DEPTH: "0" }),
				"live-session",
			);
		});

		it("returns defaultRuntime from isolationPolicy when set", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", {
					defaultRuntime: "child-process",
				}),
				"child-process",
			);
		});

		it("returns globalKind when no isolation policy", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", undefined, {
					PI_CREW_DEPTH: "0",
				}),
				"live-session",
			);
		});

		it("forces child-process when nested (depth > 0)", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", undefined, {
					PI_CREW_DEPTH: "1",
				}),
				"child-process",
			);
		});

		it("does not force child-process at depth 0", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", undefined, {
					PI_CREW_DEPTH: "0",
				}),
				"live-session",
			);
		});

		it("allows live-session when PI_CREW_MOCK_LIVE_SESSION is set", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", undefined, {
					PI_CREW_DEPTH: "1",
					PI_CREW_MOCK_LIVE_SESSION: "success",
				}),
				"live-session",
			);
		});

		it("returns child-process for child-process globalKind", () => {
			assert.equal(
				resolveTaskRuntimeKind("child-process", "executor", undefined, {
					PI_CREW_DEPTH: "0",
				}),
				"child-process",
			);
		});

		it("returns live-session for live-session globalKind with no nesting", () => {
			assert.equal(resolveTaskRuntimeKind("live-session", "executor", undefined, {}), "live-session");
		});

		it("uses PI_TEAMS_DEPTH as fallback", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "executor", undefined, {
					PI_TEAMS_DEPTH: "2",
				}),
				"child-process",
			);
		});

		it("isolatedRoles takes precedence over defaultRuntime", () => {
			assert.equal(
				resolveTaskRuntimeKind("live-session", "reviewer", {
					isolatedRoles: ["reviewer"],
					defaultRuntime: "live-session",
				}),
				"child-process",
			);
		});
	});
});
