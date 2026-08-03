import assert from "node:assert/strict";
import test from "node:test";
import { MailboxComposeOverlay, type MailboxComposeResult } from "../../../../src/ui/overlays/mailbox-compose-overlay.ts";

test("MailboxComposeOverlay validates body and submits payload", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { to: "worker" },
	});
	overlay.handleInput("\r");
	overlay.handleInput("\r");
	assert.ok(overlay.render(80).some((line) => line.includes("Body is required")));
	for (const char of "hello") overlay.handleInput(char);
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") assert.equal(results[0].payload.body, "hello");
});

test("MailboxComposeOverlay toggles preview and confirms long discard", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { body: "x".repeat(60), to: "worker" },
	});
	overlay.handleInput("P");
	assert.ok(overlay.render(100).some((line) => line.includes("Preview")));
	overlay.handleInput("\u001b");
	assert.ok(overlay.render(100).some((line) => line.includes("Discard draft")));
	overlay.handleInput("N");
	assert.equal(results.length, 0);
	overlay.handleInput("\u001b");
	overlay.handleInput("Y");
	assert.equal(results[0]?.type, "cancel");
});

test("MailboxComposeOverlay toggles direction with space on direction field", () => {
	const results: MailboxComposeResult[] = [];
	const overlay = new MailboxComposeOverlay({
		done: (result) => results.push(result),
		initial: { body: "hello", to: "worker" },
	});
	for (let index = 0; index < 3; index += 1) overlay.handleInput("\t");
	overlay.handleInput(" ");
	overlay.handleInput("\r");
	assert.equal(results[0]?.type, "submit");
	if (results[0]?.type === "submit") assert.equal(results[0].payload.direction, "outbox");
});
