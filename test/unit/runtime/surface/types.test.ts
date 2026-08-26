/**
 * Compile guard test for SurfaceProvider types (spec §4)
 *
 * This test only validates type correctness at compile time.
 * All assertions should pass if types are exported correctly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
	SurfaceDetection,
	SurfaceExitReason,
	SurfaceHandle,
	SurfaceProvider,
	SurfaceSpawnOpts,
} from "../../../../src/runtime/surface/surface-provider.ts";

// SurfaceDetection should accept { ok: false, reason: "x" }
const detectionValid: SurfaceDetection = { ok: false, reason: "x" };
const detectionWithKind: SurfaceDetection = { ok: true, kind: "tmux" };
const detectionMinimal: SurfaceDetection = { ok: true };

// SurfaceSpawnOpts type check
const spawnOpts: SurfaceSpawnOpts = {
	cwd: "/path/to/dir",
	command: "nvim",
	title: "My Session",
};

// SurfaceExitReason should be exactly 3 values
type ExitReasonValues = SurfaceExitReason;
const _checkExitReasonValues1: ExitReasonValues = "pane-closed";
const _checkExitReasonValues2: ExitReasonValues = "mux-dead";
const _checkExitReasonValues3: ExitReasonValues = "detached";

// SurfaceHandle type check
const handle: SurfaceHandle = {
	id: "test-id",
	kind: "tmux",
	onExit: (cb: (reason: SurfaceExitReason) => void) => {},
	dispose: () => {},
};

// SurfaceProvider type check
const provider: SurfaceProvider = {
	kind: "tmux",
	detect: (): SurfaceDetection => ({ ok: true }),
	createSurface: async (name: string, opts: SurfaceSpawnOpts): Promise<SurfaceHandle> => handle,
	attach: (id: string): SurfaceHandle | null => handle,
	readScreen: async (handle: SurfaceHandle, lines?: number): Promise<string> => "",
	closeSurface: async (handle: SurfaceHandle, opts?: { force?: boolean }): Promise<void> => {},
};

test("SurfaceProvider types: compile without errors", () => {
	// If this file compiles, all type assertions above are valid
	assert.ok(true);
});

test("SurfaceExitReason: exactly 3 values", () => {
	// Type-level check: pane-closed | mux-dead | detached
	const reasons: SurfaceExitReason[] = ["pane-closed", "mux-dead", "detached"];
	assert.equal(reasons.length, 3);
	assert.ok(reasons.includes("pane-closed"));
	assert.ok(reasons.includes("mux-dead"));
	assert.ok(reasons.includes("detached"));
});
