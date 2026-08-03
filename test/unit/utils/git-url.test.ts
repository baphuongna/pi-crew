import assert from "node:assert/strict";
import test from "node:test";
import { parseGitUrl } from "../../../src/utils/git.ts";

test("parses git+https team source", () => {
	const parsed = parseGitUrl("git+https://github.com/org/teams-repo.git#main");
	assert.deepEqual(parsed, {
		type: "git",
		repo: "https://github.com/org/teams-repo.git",
		host: "github.com",
		path: "org/teams-repo",
		ref: "main",
		pinned: true,
	});
});

test("parses scp-like git URL", () => {
	const parsed = parseGitUrl("git@github.com:org/teams-repo.git#main");
	assert.deepEqual(parsed, {
		type: "git",
		repo: "git@github.com:org/teams-repo.git",
		host: "github.com",
		path: "org/teams-repo",
		ref: "main",
		pinned: true,
	});
});

test("falls back for non-hosted git domains", () => {
	const parsed = parseGitUrl("git:internal.example/teams/legacy@release");
	assert.deepEqual(parsed, {
		type: "git",
		repo: "https://internal.example/teams/legacy",
		host: "internal.example",
		path: "teams/legacy",
		ref: "release",
		pinned: true,
	});
});

test("rejects non-git plain text", () => {
	assert.equal(parseGitUrl("just-a-name"), null);
});
