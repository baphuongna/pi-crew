/**
 * R3-12 — `scopedModels` binding for live sessions.
 *
 * `resolveScopedSessionModels` turns pi-crew's fallback chain (model-ref
 * strings from `buildConfiguredModelRouting`) into pi SDK `scopedModels`
 * entries (`{ model }`), resolved through the SAME registry lookup the
 * session's primary `model` option uses. Guarantees under test:
 *   - registry-resolvable candidates appear in chain order, deduped;
 *   - non-resolvable / non-object / throwing lookups are skipped;
 *   - no candidates → empty array (caller must NOT pass the option —
 *     the "explicit non-empty" guard keeps pi's default scope).
 *
 * A source-wiring guard pins the option to the `createAgentSession` call
 * (same style as the import-latch regression test — there is no seam to
 * intercept the real SDK factory in-process).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveScopedSessionModels } from "../../../../src/runtime/live-session/live-session-runtime.ts";

const SRC = fileURLToPath(new URL("../../../../src/runtime/live-session/live-session-runtime.ts", import.meta.url));

function registryWith(models: Record<string, unknown>): unknown {
	return {
		find: (provider: string, id: string) => models[`${provider}/${id}`],
	};
}

const MODEL_A = { id: "model-a", provider: "prov", name: "Model A" };
const MODEL_B = { id: "model-b", provider: "prov", name: "Model B" };

describe("resolveScopedSessionModels (R3-12)", () => {
	it("resolves fallback-chain candidates to scoped model entries in order", () => {
		const registry = registryWith({ "prov/model-a": MODEL_A, "prov/model-b": MODEL_B });
		const scoped = resolveScopedSessionModels(registry, ["prov/model-a", "prov/model-b"]);
		assert.equal(scoped.length, 2);
		assert.equal(scoped[0]!.model, MODEL_A);
		assert.equal(scoped[1]!.model, MODEL_B);
	});

	it("dedupes repeated candidates by resolved object identity", () => {
		const registry = registryWith({ "prov/model-a": MODEL_A });
		const scoped = resolveScopedSessionModels(registry, ["prov/model-a", "prov/model-a"]);
		assert.equal(scoped.length, 1);
		assert.equal(scoped[0]!.model, MODEL_A);
	});

	it("skips candidates that do not resolve in the registry", () => {
		const registry = registryWith({ "prov/model-b": MODEL_B });
		const scoped = resolveScopedSessionModels(registry, ["prov/model-a", "prov/model-b", "no-slash"]);
		assert.equal(scoped.length, 1);
		assert.equal(scoped[0]!.model, MODEL_B);
	});

	it("skips non-object registry results (defensive against API drift)", () => {
		const registry = registryWith({ "prov/model-a": "just-a-string", "prov/model-b": MODEL_B });
		const scoped = resolveScopedSessionModels(registry, ["prov/model-a", "prov/model-b"]);
		assert.equal(scoped.length, 1);
		assert.equal(scoped[0]!.model, MODEL_B);
	});

	it("returns empty when the registry has no find function or find throws", () => {
		assert.deepEqual(resolveScopedSessionModels(undefined, ["prov/model-a"]), []);
		assert.deepEqual(
			resolveScopedSessionModels(
				{
					find: () => {
						throw new Error("boom");
					},
				},
				["prov/model-a"],
			),
			[],
		);
	});

	it("returns empty for an empty fallback chain (explicit non-empty guard)", () => {
		assert.deepEqual(resolveScopedSessionModels(registryWith({ "prov/model-a": MODEL_A }), []), []);
	});

	it("wiring guard: createAgentSession receives scopedModels only when non-empty", () => {
		const src = readFileSync(SRC, "utf-8");
		assert.ok(
			src.includes("resolveScopedSessionModels(input.modelRegistry, modelRouting.candidates)"),
			"scoped models must be derived from the routing fallback chain",
		);
		assert.ok(
			src.includes("scopedSessionModels.length > 0 ? { scopedModels: scopedSessionModels } : {}"),
			"the option must be omitted entirely when the chain resolves to zero models",
		);
	});
});
