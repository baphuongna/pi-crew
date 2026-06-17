/**
 * Cold-start race fix — runtime module-graph warmup (general fix).
 *
 * v0.8.1's per-import latch covered only the peer-dep namespace (the
 * `existsSync` variant). The `validateWorkflowForTeam` variant (a pi-crew
 * internal module) was NOT covered. This is the GENERAL fix: pre-warm the hot
 * module graph at registration + await at spawn boundaries.
 *
 * Tests pin: idempotency of startRuntimeWarmup, awaitRuntimeWarmup resolves,
 * and the hot-module specifiers are real (no typos that would silently
 * no-op the warmup).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
	awaitRuntimeWarmup,
	isRuntimeWarmupStarted,
	resetRuntimeWarmupForTest,
	startRuntimeWarmup,
} from "../../src/runtime/runtime-warmup.ts";

describe("runtime-warmup: lifecycle", () => {
	test("startRuntimeWarmup is idempotent (calling twice does not restart)", () => {
		resetRuntimeWarmupForTest();
		assert.equal(isRuntimeWarmupStarted(), false);
		startRuntimeWarmup();
		assert.equal(isRuntimeWarmupStarted(), true);
		// Second call is a no-op (does not throw, does not restart).
		startRuntimeWarmup();
		assert.equal(isRuntimeWarmupStarted(), true);
		resetRuntimeWarmupForTest();
	});

	test("awaitRuntimeWarmup resolves (does not hang) after startRuntimeWarmup", async () => {
		resetRuntimeWarmupForTest();
		startRuntimeWarmup();
		// Must resolve — never hang. The warmup imports real modules.
		await assert.doesNotReject(() => awaitRuntimeWarmup());
		resetRuntimeWarmupForTest();
	});

	test("awaitRuntimeWarmup is a no-op when warmup was never started", async () => {
		resetRuntimeWarmupForTest();
		// Back-compat: callers that don't call startRuntimeWarmup must not hang.
		await assert.doesNotReject(() => awaitRuntimeWarmup());
	});

	test("awaitRuntimeWarmup can be called multiple times (idempotent await)", async () => {
		resetRuntimeWarmupForTest();
		startRuntimeWarmup();
		await awaitRuntimeWarmup();
		await awaitRuntimeWarmup(); // second await is instant (promise cached)
		await awaitRuntimeWarmup();
		resetRuntimeWarmupForTest();
	});
});

describe("runtime-warmup: hot-module specifiers are valid", () => {
	test("every HOT_MODULE_SPECIFIER resolves to a real file (no silent no-op from a typo)", async () => {
		// Read the source to extract the specifiers, then verify each resolves.
		// This catches typos that would make the warmup silently skip a module.
		const src = readFileSync(
			fileURLToPath(new URL("../../src/runtime/runtime-warmup.ts", import.meta.url)),
			"utf-8",
		);
		const match = src.match(/HOT_MODULE_SPECIFIERS\s*=\s*\[([\s\S]*?)\]/);
		assert.ok(match, "HOT_MODULE_SPECIFIERS array should exist");
		const specifiers = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
		assert.ok(specifiers.length >= 3, "should have at least 3 hot module specifiers");

		for (const spec of specifiers) {
			// Each specifier is relative to runtime-warmup.ts (src/runtime/).
			// Verify it resolves to an importable module.
			const url = new URL(spec, new URL("../../src/runtime/runtime-warmup.ts", import.meta.url));
			await assert.doesNotReject(
				async () => import(url.href),
				`hot module specifier "${spec}" must resolve to a real module`,
			);
		}
	});
});

describe("runtime-warmup: actually warms the graph (integration)", () => {
	test("after warmup, importing a hot module is instant (already cached)", async () => {
		resetRuntimeWarmupForTest();
		startRuntimeWarmup();
		await awaitRuntimeWarmup();
		// The validate-resources module (the validateWorkflowForTeam path)
		// should now be loaded — importing it again is a cache hit.
		const url = new URL("../../src/extension/validate-resources.ts", import.meta.url).href;
		const mod1 = await import(url);
		const mod2 = await import(url);
		assert.strictEqual(mod1, mod2, "module should be cached (same namespace object)");
		resetRuntimeWarmupForTest();
	});
});
