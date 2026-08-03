import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

// Replicate the preStepScript containment check logic for direct testing
function validatePreStepScript(preStepScript: string, cwd: string): void {
	const resolved = path.resolve(cwd, preStepScript);
	if (!resolved.startsWith(path.resolve(cwd) + path.sep) && resolved !== path.resolve(cwd)) {
		throw new Error(`Security: preStepScript path escapes working directory: ${preStepScript}`);
	}
}

describe("preStepScript path validation", () => {
	it("accepts relative path within cwd", () => {
		assert.doesNotThrow(() => validatePreStepScript("scripts/setup.sh", "/project"));
	});

	it("accepts simple filename", () => {
		assert.doesNotThrow(() => validatePreStepScript("setup.sh", "/project"));
	});

	it("accepts nested relative path", () => {
		assert.doesNotThrow(() => validatePreStepScript("scripts/sub/deep.sh", "/project"));
	});

	it("rejects parent directory traversal", () => {
		assert.throws(() => validatePreStepScript("../escape.sh", "/project"), /Security: preStepScript path escapes working directory/);
	});

	it("rejects deep parent traversal", () => {
		assert.throws(
			() => validatePreStepScript("foo/../../escape.sh", "/project"),
			/Security: preStepScript path escapes working directory/,
		);
	});

	it("rejects absolute path outside cwd", () => {
		assert.throws(() => validatePreStepScript("/etc/passwd", "/project"), /Security: preStepScript path escapes working directory/);
	});

	it("rejects absolute path in different root", () => {
		assert.throws(() => validatePreStepScript("/tmp/evil.sh", "/project"), /Security: preStepScript path escapes working directory/);
	});

	it("accepts dot-relative path", () => {
		assert.doesNotThrow(() => validatePreStepScript("./scripts/run.sh", "/project"));
	});
});
