/**
 * Unit tests for the view-command dispatch path (inline-panel/index.ts).
 *
 * The contract under test:
 *  - `/crew-view …` / `/crew-back` MUST reach pi's extension-command executor.
 *    pi's `sendUserMessage` forces `expandPromptTemplates: false` ("skip
 *    command handling"), so a command sent through it never executes — the
 *    regression where "the view only changed the input, everything else stayed
 *    the main session".
 *  - The editor submit path is the one route that dispatches extension
 *    commands immediately in every session state (onSubmit → prompt() with
 *    expansion on → _tryExecuteExtensionCommand runs before the streaming
 *    check), so the dispatch prefers it whenever an editor is mounted.
 *  - With no editor (headless), the dispatch degrades to sendUserMessage as a
 *    best-effort notification path instead of crashing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchViewCommandWith } from "../../../src/ui/inline-panel/index.ts";

interface EditorLike {
	dispatchCommandFallback: (text: string) => void;
}

interface PiLike {
	sendUserMessage?: (content: string, options?: unknown) => void;
}

function makeEditor(calls: string[]): EditorLike {
	return {
		dispatchCommandFallback: (text: string) => {
			calls.push(`editor:${text}`);
		},
	};
}

function makePi(calls: string[]): PiLike {
	return {
		sendUserMessage: (content: string, options?: unknown) => {
			calls.push(`pi:${content}:${JSON.stringify(options ?? {})}`);
		},
	};
}

test("dispatch routes through the editor submit path when an editor is mounted", () => {
	const calls: string[] = [];
	dispatchViewCommandWith(makeEditor(calls), makePi(calls), "/crew-view run1 task1");
	assert.deepEqual(calls, ["editor:/crew-view run1 task1"]);
});

test("dispatch never calls sendUserMessage when the editor is available (it cannot run commands)", () => {
	const calls: string[] = [];
	dispatchViewCommandWith(makeEditor(calls), makePi(calls), "/crew-back");
	assert.equal(calls.length, 1);
	assert.ok(calls[0].startsWith("editor:"), `expected editor dispatch, got ${calls[0]}`);
});

test("dispatch degrades to sendUserMessage when no editor is mounted (headless)", () => {
	const calls: string[] = [];
	dispatchViewCommandWith(undefined, makePi(calls), "/crew-back");
	assert.equal(calls.length, 1);
	assert.ok(calls[0].startsWith("pi:/crew-back"), `expected pi fallback dispatch, got ${calls[0]}`);
});

test("dispatch with neither editor nor pi is a silent no-op (no crash)", () => {
	assert.doesNotThrow(() => dispatchViewCommandWith(undefined, undefined, "/crew-back"));
});
