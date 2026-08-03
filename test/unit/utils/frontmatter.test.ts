import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseFrontmatter } from "../../../src/utils/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("returns empty frontmatter for content without frontmatter", () => {
		const result = parseFrontmatter("Hello world");
		assert.deepEqual(result.frontmatter, {});
		assert.equal(result.body, "Hello world");
	});

	it("parses simple key:value frontmatter", () => {
		const content = "---\ntitle: My Page\nauthor: Bob\n---\nBody here";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "My Page");
		assert.equal(result.frontmatter.author, "Bob");
		assert.equal(result.body, "Body here");
	});

	it("handles CRLF line endings", () => {
		const content = "---\r\ntitle: Test\r\n---\r\nBody";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "Test");
		assert.equal(result.body, "Body");
	});

	it("skips comment lines in frontmatter", () => {
		const content = "---\n# comment\ntitle: Test\n---\nBody";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "Test");
		assert.ok(!("comment" in result.frontmatter));
		assert.equal(result.body, "Body");
	});

	it("skips empty lines in frontmatter", () => {
		const content = "---\n\ntitle: Test\n\n---\nBody";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "Test");
	});

	it("handles frontmatter ending at EOF without trailing newline", () => {
		const content = "---\ntitle: Test\n---";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "Test");
		assert.equal(result.body, "");
	});

	it("returns raw content when frontmatter is unclosed (no closing ---)", () => {
		const content = "---\ntitle: Test\nBody continues";
		const result = parseFrontmatter(content);
		assert.deepEqual(result.frontmatter, {});
		assert.equal(result.body, content);
	});

	it("trims whitespace around key and value", () => {
		const content = "---\n  title  :  My Title  \n---\nBody";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "My Title");
	});

	it("ignores lines without colon separator", () => {
		const content = "---\nno-colon-here\ntitle: Test\n---\nBody";
		const result = parseFrontmatter(content);
		assert.equal(result.frontmatter.title, "Test");
		assert.ok(!("no-colon-here" in result.frontmatter));
	});
});

describe("parseCsv", () => {
	it("returns undefined for undefined input", () => {
		assert.equal(parseCsv(undefined), undefined);
	});

	it("parses a simple comma-separated string", () => {
		assert.deepEqual(parseCsv("a, b, c"), ["a", "b", "c"]);
	});

	it("handles quoted values with commas inside", () => {
		assert.deepEqual(parseCsv('"hello, world", other'), ["hello, world", "other"]);
	});

	it("deduplicates values", () => {
		assert.deepEqual(parseCsv("a, b, a, c"), ["a", "b", "c"]);
	});

	it("returns undefined for empty/whitespace-only input", () => {
		assert.equal(parseCsv(""), undefined);
		assert.equal(parseCsv("   "), undefined);
	});

	it("trims whitespace around values", () => {
		assert.deepEqual(parseCsv("  a  ,  b  "), ["a", "b"]);
	});

	it("handles single value", () => {
		assert.deepEqual(parseCsv("only"), ["only"]);
	});
});
