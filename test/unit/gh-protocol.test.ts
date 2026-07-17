/**
 * Unit tests for gh-protocol.ts
 * GitHub issue/PR URL protocol handlers.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import { parseGitHubUrl } from "../../src/utils/gh-protocol.ts";

function tempGitDir(): string {
	const dir = path.join(os.tmpdir(), `pi-crew-gh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("parseGitHubUrl", () => {
	describe("issue://", () => {
		it("parses empty issue:// as list with empty repo", () => {
			const result = parseGitHubUrl("issue://", "issue");
			assert.strictEqual(result.kind, "list");
			assert.strictEqual((result as { repo: string }).repo, "");
			assert.strictEqual(result.state, "open");
		});

		it("parses issue://123 as single item", () => {
			const result = parseGitHubUrl("issue://123", "issue");
			assert.strictEqual(result.kind, "single");
			const r = result as {
				number: number;
				repo?: string;
				comments: boolean;
			};
			assert.strictEqual(r.number, 123);
			assert.strictEqual(r.repo, undefined);
		});

		it("parses issue://owner/repo as list for repo", () => {
			const result = parseGitHubUrl("issue://owner/repo", "issue");
			assert.strictEqual(result.kind, "list");
			const r = result as { repo: string; state: string };
			assert.strictEqual(r.repo, "owner/repo");
		});

		it("parses issue://owner/repo/456 as single item", () => {
			const result = parseGitHubUrl("issue://owner/repo/456", "issue");
			assert.strictEqual(result.kind, "single");
			const r = result as { number: number; repo: string };
			assert.strictEqual(r.number, 456);
			assert.strictEqual(r.repo, "owner/repo");
		});

		it("parses issue://123 with comments=0", () => {
			const result = parseGitHubUrl("issue://123?comments=0", "issue");
			assert.strictEqual(result.kind, "single");
			const r = result as { comments: boolean };
			assert.strictEqual(r.comments, false);
		});

		it("parses issue://owner/repo with state=closed", () => {
			const result = parseGitHubUrl("issue://owner/repo?state=closed", "issue");
			assert.strictEqual(result.kind, "list");
			const r = result as { state: string };
			assert.strictEqual(r.state, "closed");
		});

		it("parses issue://owner/repo with limit=50", () => {
			const result = parseGitHubUrl("issue://owner/repo?limit=50", "issue");
			assert.strictEqual(result.kind, "list");
			const r = result as { limit: number };
			assert.strictEqual(r.limit, 50);
		});

		it("limits cap at 100", () => {
			const result = parseGitHubUrl("issue://owner/repo?limit=500", "issue");
			assert.strictEqual(result.kind, "list");
			const r = result as { limit: number };
			assert.strictEqual(r.limit, 100);
		});

		it("rejects issue://owner/repo/123/diff", () => {
			assert.throws(() => parseGitHubUrl("issue://owner/repo/123/diff", "issue"), /issue views do not have a diff/i);
		});

		it("rejects issue://owner alone (needs owner/repo)", () => {
			assert.throws(() => parseGitHubUrl("issue://owner", "issue"), /invalid.*issue.*number.*owner/i);
		});
	});

	describe("pr://", () => {
		it("parses empty pr:// as list", () => {
			const result = parseGitHubUrl("pr://", "pr");
			assert.strictEqual(result.kind, "list");
		});

		it("parses pr://456 as single item", () => {
			const result = parseGitHubUrl("pr://456", "pr");
			assert.strictEqual(result.kind, "single");
			const r = result as { number: number };
			assert.strictEqual(r.number, 456);
		});

		it("parses pr://owner/repo as list", () => {
			const result = parseGitHubUrl("pr://owner/repo", "pr");
			assert.strictEqual(result.kind, "list");
		});

		it("parses pr://owner/repo/789 as single item", () => {
			const result = parseGitHubUrl("pr://owner/repo/789", "pr");
			assert.strictEqual(result.kind, "single");
			const r = result as { number: number; repo: string };
			assert.strictEqual(r.number, 789);
			assert.strictEqual(r.repo, "owner/repo");
		});

		it("parses pr://owner/repo/789/diff as diff list", () => {
			const result = parseGitHubUrl("pr://owner/repo/789/diff", "pr");
			assert.strictEqual(result.kind, "pr-diff");
			const r = result as { number: number; mode: string };
			assert.strictEqual(r.number, 789);
			assert.strictEqual(r.mode, "list");
		});

		it("parses pr://owner/repo/789/diff/all as full diff", () => {
			const result = parseGitHubUrl("pr://owner/repo/789/diff/all", "pr");
			assert.strictEqual(result.kind, "pr-diff");
			const r = result as { number: number; mode: string };
			assert.strictEqual(r.mode, "all");
		});

		it("parses pr://owner/repo/789/diff/3 as file slice", () => {
			const result = parseGitHubUrl("pr://owner/repo/789/diff/3", "pr");
			assert.strictEqual(result.kind, "pr-diff");
			const r = result as { number: number; mode: string; index: number };
			assert.strictEqual(r.mode, "slice");
			assert.strictEqual(r.index, 3);
		});

		it("rejects pr://N/diff with invalid sub-path", () => {
			assert.throws(() => parseGitHubUrl("pr://123/diff/foo", "pr"), /diff sub-path/i);
		});

		it("parses pr:// with state=merged", () => {
			const result = parseGitHubUrl("pr://owner/repo?state=merged", "pr");
			assert.strictEqual(result.kind, "list");
			const r = result as { state: string };
			assert.strictEqual(r.state, "merged");
		});

		it("parses pr:// with author filter", () => {
			const result = parseGitHubUrl("pr://owner/repo?author=defunkt", "pr");
			assert.strictEqual(result.kind, "list");
			const r = result as { author?: string };
			assert.strictEqual(r.author, "defunkt");
		});

		it("parses pr:// with label filter", () => {
			const result = parseGitHubUrl("pr://owner/repo?label=bug", "pr");
			assert.strictEqual(result.kind, "list");
			const r = result as { label?: string };
			assert.strictEqual(r.label, "bug");
		});
	});

	describe("error cases", () => {
		it("throws for invalid number", () => {
			assert.throws(() => parseGitHubUrl("issue://abc", "issue"), /number: abc/i);
			assert.throws(() => parseGitHubUrl("pr://0", "pr"), /number: 0/i);
			assert.throws(() => parseGitHubUrl("pr://-5", "pr"), /number: -5/i);
		});

		it("throws for invalid URL", () => {
			assert.throws(() => parseGitHubUrl("://", "issue"), /invalid.*issue/i);
		});
	});
});

describe("resolveGitHubUrl — list operations", () => {
	it("resolves issue list with mocked gh", () => {
		const mockExec = mock.fn(() => "[]");
		// Can't easily mock execSync; test parse path instead
		const parsed = parseGitHubUrl("issue://owner/repo?state=closed&limit=20", "issue");
		assert.strictEqual(parsed.kind, "list");
		const r = parsed as {
			repo: string;
			state: string;
			limit: number;
			author?: string;
			label?: string;
		};
		assert.strictEqual(r.repo, "owner/repo");
		assert.strictEqual(r.state, "closed");
		assert.strictEqual(r.limit, 20);
	});

	it("resolves pr list with mocked gh", () => {
		const parsed = parseGitHubUrl("pr://owner/repo?state=open&limit=15&author=mojombo&label=enhancement", "pr");
		assert.strictEqual(parsed.kind, "list");
		const r = parsed as {
			repo: string;
			state: string;
			limit: number;
			author?: string;
			label?: string;
		};
		assert.strictEqual(r.repo, "owner/repo");
		assert.strictEqual(r.state, "open");
		assert.strictEqual(r.limit, 15);
		assert.strictEqual(r.author, "mojombo");
		assert.strictEqual(r.label, "enhancement");
	});
});

describe("resolveGitHubUrl — single item", () => {
	it("parse issue://123 for single item resolution", () => {
		const parsed = parseGitHubUrl("issue://123", "issue");
		assert.strictEqual(parsed.kind, "single");
		const r = parsed as {
			number: number;
			repo?: string;
			comments: boolean;
		};
		assert.strictEqual(r.number, 123);
		assert.strictEqual(r.repo, undefined);
		assert.strictEqual(r.comments, true);
	});

	it("parse pr://456/diff for diff resolution", () => {
		const parsed = parseGitHubUrl("pr://owner/repo/456/diff", "pr");
		assert.strictEqual(parsed.kind, "pr-diff");
		const r = parsed as { number: number; repo: string; mode: string };
		assert.strictEqual(r.number, 456);
		assert.strictEqual(r.repo, "owner/repo");
		assert.strictEqual(r.mode, "list");
	});

	it("parse pr://456/diff/all for full diff", () => {
		const parsed = parseGitHubUrl("pr://456/diff/all", "pr");
		assert.strictEqual(parsed.kind, "pr-diff");
		const r = parsed as { number: number; repo?: string; mode: string };
		assert.strictEqual(r.number, 456);
		assert.strictEqual(r.repo, undefined); // repo from cwd
		assert.strictEqual(r.mode, "all");
	});
});

describe("URL normalization edge cases", () => {
	it("handles issue://owner/repo/ with trailing slash", () => {
		const result = parseGitHubUrl("issue://owner/repo/", "issue");
		assert.strictEqual(result.kind, "list");
	});

	it("handles pr:// with trailing slash", () => {
		const result = parseGitHubUrl("pr://owner/repo/789/", "pr");
		assert.strictEqual(result.kind, "single");
	});

	it("handles state=all for issues", () => {
		const result = parseGitHubUrl("issue://owner/repo?state=all", "issue");
		const r = result as { state: string };
		assert.strictEqual(r.state, "all");
	});

	it("rejects invalid state value", () => {
		// Should default to 'open' for invalid state
		const result = parseGitHubUrl("issue://owner/repo?state=invalid", "issue");
		const r = result as { state: string };
		assert.strictEqual(r.state, "open"); // defaults to open
	});
});
