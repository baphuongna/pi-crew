import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { resolveContainedPath, resolveContainedRelativePath } from "../../../src/utils/safe-paths.ts";

describe("safe-paths null byte rejection", () => {
	it("resolveContainedPath rejects null bytes", () => {
		assert.throws(() => resolveContainedPath("/tmp", "foo\0bar"), /Security: path contains null byte/);
	});

	it("resolveContainedPath rejects null bytes at start", () => {
		assert.throws(() => resolveContainedPath("/tmp", "\0etc/passwd"), /Security: path contains null byte/);
	});

	it("resolveContainedRelativePath rejects null bytes", () => {
		assert.throws(() => resolveContainedRelativePath("/tmp", "sub\0dir", "test"), /Security: path contains null byte: test/);
	});

	it("resolveContainedPath allows safe paths", () => {
		const result = resolveContainedPath("/tmp", "foo/bar");
		// Cross-platform: result uses path.sep, so check the joined path
		assert.ok(
			result.endsWith(path.join("foo", "bar")) || result.includes("foo/bar") || result.includes("foo\\bar"),
			`expected result to end with foo/bar, got: ${result}`,
		);
	});

	it("resolveContainedRelativePath allows safe paths", () => {
		const result = resolveContainedRelativePath("/tmp", "sub/dir", "test");
		assert.ok(
			result.endsWith(path.join("sub", "dir")) || result.includes("sub/dir") || result.includes("sub\\dir"),
			`expected result to end with sub/dir, got: ${result}`,
		);
	});
});
