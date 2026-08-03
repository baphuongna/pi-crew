import assert from "node:assert/strict";
import test from "node:test";
import { renderComposePreview, tokenizeMarkdown } from "../../../../src/ui/overlays/mailbox-compose-preview.ts";

test("compose preview renders empty body", () => {
	assert.ok(renderComposePreview("", 80).some((line) => line.includes("empty")));
});

test("compose preview tokenizes headings lists and code blocks", () => {
	const tokens = tokenizeMarkdown("# Title\n- item\n```\ncode\n```");
	assert.deepEqual(
		tokens.map((token) => token.type),
		["heading", "list-item", "code-block"],
	);
});

test("compose preview strips simple markdown markers", () => {
	const lines = renderComposePreview("**bold** and *italic* with `code`", 80);
	assert.ok(lines.some((line) => line.includes("bold and italic with code")));
});

test("compose preview renders link text without URL", () => {
	const lines = renderComposePreview("Read [docs](https://example.invalid)", 80);
	assert.ok(lines.some((line) => line.includes("Read docs")));
	assert.equal(
		lines.some((line) => line.includes("example.invalid")),
		false,
	);
});

test("compose preview handles numbered lists", () => {
	const tokens = tokenizeMarkdown("1. first\n2. second");
	assert.deepEqual(
		tokens.map((token) => token.type),
		["list-item", "list-item"],
	);
});

test("compose preview keeps unclosed code blocks", () => {
	const lines = renderComposePreview("```\ncode", 80);
	assert.ok(lines.some((line) => line.includes("code")));
});
