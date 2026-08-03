import assert from "node:assert/strict";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectProjectId, getGlobalStorageDir, getProjectStorageDir } from "../../../src/utils/project-detector.ts";

describe("detectProjectId", () => {
	const originalEnv = process.env.CLAUDE_PROJECT_DIR;

	beforeEach(() => {
		delete process.env.CLAUDE_PROJECT_DIR;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.CLAUDE_PROJECT_DIR = originalEnv;
		} else {
			delete process.env.CLAUDE_PROJECT_DIR;
		}
	});

	it("uses CLAUDE_PROJECT_DIR env var when set", () => {
		process.env.CLAUDE_PROJECT_DIR = "/home/user/my-project";
		const info = detectProjectId("/some/other/path");
		assert.equal(info.projectName, "my-project");
		assert.ok(info.projectId.length > 0);
	});

	it("returns consistent projectId for the same cwd", () => {
		const info1 = detectProjectId("/tmp/test-dir");
		const info2 = detectProjectId("/tmp/test-dir");
		assert.equal(info1.projectId, info2.projectId);
	});

	it("returns different projectIds for different cwd", () => {
		const info1 = detectProjectId("/tmp/dir-a");
		const info2 = detectProjectId("/tmp/dir-b");
		assert.notEqual(info1.projectId, info2.projectId);
	});

	it("uses basename of cwd as projectName when no git", () => {
		const info = detectProjectId("/tmp/my-special-dir");
		assert.equal(info.projectName, "my-special-dir");
	});

	it("handles CLAUDE_PROJECT_DIR with trailing whitespace", () => {
		process.env.CLAUDE_PROJECT_DIR = "  /home/user/whitespace-project  ";
		const info = detectProjectId("/tmp");
		assert.equal(info.projectName, "whitespace-project");
	});

	it("projectId is a 16-char hex string", () => {
		const info = detectProjectId("/tmp/test");
		assert.match(info.projectId, /^[0-9a-f]{16}$/);
	});
});

describe("getProjectStorageDir", () => {
	it("returns path under instincts/projects/{projectId}", () => {
		const crewRoot = path.join(path.sep, "root", ".crew");
		const result = getProjectStorageDir("abc123", crewRoot);
		assert.equal(result, path.join(crewRoot, "instincts", "projects", "abc123"));
	});

	it("handles empty crewRoot", () => {
		const result = getProjectStorageDir("abc", "");
		assert.equal(result, path.join("instincts", "projects", "abc"));
	});
});

describe("getGlobalStorageDir", () => {
	it("returns path under instincts/global", () => {
		const crewRoot = path.join(path.sep, "root", ".crew");
		const result = getGlobalStorageDir(crewRoot);
		assert.equal(result, path.join(crewRoot, "instincts", "global"));
	});

	it("handles empty crewRoot", () => {
		const result = getGlobalStorageDir("");
		assert.equal(result, path.join("instincts", "global"));
	});
});
