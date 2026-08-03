import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveParentModelFromRegistry } from "../../src/runtime/live-session/live-session-runtime.ts";

describe("resolveParentModelFromRegistry (round 18 — stale parentModel)", () => {
	const buildRegistry = (available: Array<{ provider: string; id: string; fullId: string }>) => ({
		getAvailable: () => available,
		find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
	});

	it("returns raw parentModel when it has auth (full provider/id form)", () => {
		const reg = buildRegistry([
			{
				provider: "minimax",
				id: "MiniMax-M3",
				fullId: "minimax/MiniMax-M3",
			},
		]);
		assert.equal(resolveParentModelFromRegistry(reg, "minimax/MiniMax-M3"), "minimax/MiniMax-M3");
	});

	it("falls back to first available when parentModel has NO auth (claude-sonnet-4-5)", () => {
		const reg = buildRegistry([
			{
				provider: "minimax",
				id: "MiniMax-M3",
				fullId: "minimax/MiniMax-M3",
			},
		]);
		// claude-sonnet-4-5 has no auth → must fall back to first available (minimax/MiniMax-M3)
		assert.equal(resolveParentModelFromRegistry(reg, "anthropic/claude-sonnet-4-5"), "minimax/MiniMax-M3");
	});

	it("falls back to first available when bare id has no auth", () => {
		const reg = buildRegistry([{ provider: "zai", id: "glm-5.2", fullId: "zai/glm-5.2" }]);
		assert.equal(resolveParentModelFromRegistry(reg, "claude-sonnet-4-5"), "zai/glm-5.2");
	});

	it("resolves bare id via registry.fullId when bare id exists", () => {
		const reg = buildRegistry([
			{
				provider: "minimax",
				id: "MiniMax-M3",
				fullId: "minimax/MiniMax-M3",
			},
		]);
		assert.equal(resolveParentModelFromRegistry(reg, "MiniMax-M3"), "minimax/MiniMax-M3");
	});

	it("returns raw parentModel when registry empty (lets downstream E008)", () => {
		const reg = buildRegistry([]);
		assert.equal(resolveParentModelFromRegistry(reg, "anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
	});

	it("handles undefined parentModel gracefully", () => {
		const reg = buildRegistry([
			{
				provider: "minimax",
				id: "MiniMax-M3",
				fullId: "minimax/MiniMax-M3",
			},
		]);
		assert.equal(resolveParentModelFromRegistry(reg, undefined), "minimax/MiniMax-M3");
	});
});
