import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-expect-error TS7016 — dev-only script, no .d.mts (test-runner-exit pattern).
import { COMMENT_MARKER, parseArgs, postPrComment, redactToken } from "../../../scripts/gh-pr-comment.mjs";

/**
 * US-031 (2026-09-23): PR-comment reporter — create-or-update one marker
 * comment, token never leaves the Authorization header, failure non-fatal by
 * default. All fetch I/O injected — zero network in tests.
 *
 * Mutation: drop the marker match in the find() → the update path degrades to
 * comment-spam creation → the update test goes RED.
 */

interface Recorded {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

function makeApi(steps: Array<{ status: number; json?: unknown; matchUrl?: string; method?: string }>): {
	calls: Recorded[];
	fetch: typeof globalThis.fetch;
} {
	const calls: Recorded[] = [];
	const impl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const target = String(url);
		const method = init?.method ?? "GET";
		const step =
			steps.find((s) => (s.method ? s.method === method : true) && (s.matchUrl ? target.includes(s.matchUrl) : true)) ??
			steps[steps.length - 1];
		calls.push({
			method: init?.method ?? "GET",
			url: target,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === "string" ? init.body : undefined,
		});
		return Promise.resolve({
			ok: step.status >= 200 && step.status < 300,
			status: step.status,
			json: () => Promise.resolve(step.json),
		} as unknown as Response);
	};
	return { calls, fetch: impl as unknown as typeof globalThis.fetch };
}

const SPEC = { pr: 42, bodyFile: "/tmp/report.md", marker: COMMENT_MARKER, hardFail: false, apiBase: "https://api.example.test" };

function withBodyFile(content: string, run: (file: string) => Promise<void>): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us031-"));
	const file = path.join(dir, "report.md");
	fs.writeFileSync(file, content);
	return run(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("US-031 AC-2: no existing marker comment → CREATE one POST with the marker + body", async () => {
	await withBodyFile("# Run report\nall green", async (file) => {
		const { calls, fetch } = makeApi([
			{ status: 200, method: "GET", json: [{ id: 1, body: "some other comment" }] },
			{ status: 201, method: "POST", json: { id: 99 } },
		]);
		const outcome = await postPrComment({
			spec: { ...SPEC, bodyFile: file },
			token: "ghp_test1234567890abcdefghij",
			repository: "acme/widget",
			fetchImpl: fetch,
		});
		assert.deepEqual(outcome, { action: "created", id: 99 });
		const post = calls.find((c) => c.method === "POST");
		assert.ok(post, "a POST must happen");
		const body = JSON.parse(post.body as string) as { body: string };
		assert.ok(body.body.startsWith(COMMENT_MARKER), "body starts with the marker");
		assert.ok(body.body.includes("# Run report"));
	});
});

test("US-031 AC-2: existing marker comment → PATCH it (no spam), never a POST", async () => {
	await withBodyFile("# Run report v2", async (file) => {
		const { calls, fetch } = makeApi([
			{ status: 200, method: "GET", json: [{ id: 7, body: `unrelated\n${COMMENT_MARKER}\nold report` }] },
			{ status: 200, method: "PATCH", json: { id: 7 } },
		]);
		const outcome = await postPrComment({
			spec: { ...SPEC, bodyFile: file },
			token: "tok",
			repository: "acme/widget",
			fetchImpl: fetch,
		});
		assert.deepEqual(outcome, { action: "updated", id: 7 });
		const patch = calls.find((c) => c.method === "PATCH");
		assert.ok(patch?.url.endsWith("/comments/7"), "PATCH targets the existing comment id");
		assert.equal(
			calls.some((c) => c.method === "POST"),
			false,
			"no comment spam",
		);
	});
});

test("US-031 AC-3: the token appears ONLY in the Authorization header — never a URL, never a body", async () => {
	await withBodyFile("report", async (file) => {
		const token = "ghp_secretsecretsecretsecret12";
		const { calls, fetch } = makeApi([
			{ status: 200, method: "GET", json: [] },
			{ status: 201, method: "POST", json: { id: 5 } },
		]);
		await postPrComment({ spec: { ...SPEC, bodyFile: file }, token, repository: "acme/widget", fetchImpl: fetch });
		for (const call of calls) {
			assert.ok(!call.url.includes(token), `token must never be in a URL: ${call.url}`);
			assert.ok(!call.body?.includes(token), "token must never be in a body");
			assert.equal((call.headers as Record<string, string>).Authorization, `Bearer ${token}`);
		}
		// And the redactor scrubs it from any message it might reach.
		assert.ok(!redactToken(`failed with ${token}`).includes(token));
		assert.ok(redactToken("failed with Bearer abc123.xyz").includes("***redacted***"));
	});
});

test("US-031 AC-4: API failure returns { error } without throwing (caller decides exit policy)", async () => {
	await withBodyFile("report", async (file) => {
		const { fetch } = makeApi([{ status: 403, json: { message: "Resource not accessible" } }]);
		const outcome = await postPrComment({
			spec: { ...SPEC, bodyFile: file },
			token: "tok",
			repository: "acme/widget",
			fetchImpl: fetch,
		});
		assert.match(outcome.error ?? "", /list comments: HTTP 403/);
		// Network throw → { error }, still no exception.
		const throwing = (async () => {
			throw new Error("socket hang up with Bearer leakcheck123");
		}) as unknown as typeof fetch;
		const outcome2 = await postPrComment({
			spec: { ...SPEC, bodyFile: file },
			token: "tok",
			repository: "acme/widget",
			fetchImpl: throwing,
		});
		assert.match(outcome2.error ?? "", /socket hang up/);
		assert.ok(!outcome2.error?.includes("leakcheck123"), "redactor scrubs Bearer fragments from thrown messages");
	});
});

test("US-031: unreadable body file → { error }, no fetch call", async () => {
	const { calls, fetch } = makeApi([]);
	const outcome = await postPrComment({
		spec: { ...SPEC, bodyFile: "/nonexistent/x.md" },
		token: "tok",
		repository: "acme/widget",
		fetchImpl: fetch,
	});
	assert.match(outcome.error ?? "", /cannot read body file/);
	assert.equal(calls.length, 0);
});

test("US-031 AC-1: example workflow YAML parses", async () => {
	const yamlText = fs.readFileSync(
		path.resolve(import.meta.dirname, "..", "..", "..", "docs", "ci", "github-actions-example.yml"),
		"utf-8",
	);
	// No in-tree YAML dependency — structural sanity + the load-bearing bits.
	assert.ok(yamlText.includes("pull-requests: write"), "documented required permission");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template placeholder
	assert.ok(yamlText.includes("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}"), "token via secrets");
	assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(yamlText), "no literal tokens");
	assert.ok(yamlText.includes(`gh-pr-comment.mjs`));
	// actionlint, if available, gives the real validation (CI-side, optional).
});

test("US-031: parseArgs requires --pr and --body-file; --hard-fail and unknown args", () => {
	assert.equal(parseArgs(["--pr", "7", "--body-file", "a.md"]).hardFail, false);
	assert.ok(parseArgs(["--pr", "7", "--body-file", "a.md", "--hard-fail"]).hardFail);
	assert.match(parseArgs(["--body-file", "a.md"]).error ?? "", /--pr/);
	assert.match(parseArgs(["--pr", "7"]).error ?? "", /--body-file/);
	assert.match(parseArgs(["--pr", "7", "--body-file", "a.md", "--wat"]).error ?? "", /unknown argument/);
});
