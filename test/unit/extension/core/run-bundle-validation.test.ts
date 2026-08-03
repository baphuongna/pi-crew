import assert from "node:assert/strict";
import test from "node:test";
import { validateRunBundle } from "../../../../src/extension/run-bundle-schema.ts";

test("validateRunBundle reports malformed bundles", () => {
	const result = validateRunBundle({
		schemaVersion: 1,
		exportedAt: "now",
		manifest: {},
		tasks: [{}],
		events: [{}],
		artifactPaths: [1],
	});
	assert.equal(result.ok, false);
	assert.ok(result.errors.length > 0);
	assert.ok(result.errors.some((error) => error.includes("manifest.runId")));
});
