import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createCrewAutocompleteProvider, suggestCrewPhrases } from "../../../../src/extension/crew-autocomplete.ts";

/** A stub provider that records delegation and returns a fixed marker. */
function makeStubProvider(captured: { delegated: boolean }): AutocompleteProvider {
	return {
		async getSuggestions() {
			captured.delegated = true;
			return { items: [{ value: "STUB", label: "stub" }], prefix: "" };
		},
		applyCompletion(lines, _cl, _cc, item) {
			return {
				lines: [...lines],
				cursorLine: 0,
				cursorCol: item.value.length,
			};
		},
	};
}

describe("suggestCrewPhrases", () => {
	it("returns all phrases for an empty query", () => {
		const items = suggestCrewPhrases("");
		// Every shared CREW_PHRASES entry should appear.
		assert.ok(items.length >= 8, `expected many phrases, got ${items.length}`);
		for (const item of items) {
			assert.ok(item.value.length > 0);
			assert.ok(item.description?.startsWith("→ /"), `description should map to a slash command: ${item.description}`);
		}
	});

	it("filters by keyword prefix", () => {
		const items = suggestCrewPhrases("da");
		// "da" matches "dashboard" keyword
		assert.ok(
			items.some((i) => i.value === "crew dashboard"),
			"should include crew dashboard",
		);
		for (const item of items) {
			// keyword is the part after "crew " — must start with "da"
			const keyword = item.value.split(/\s+/).slice(1).join(" ") || item.value;
			assert.ok(keyword.toLowerCase().startsWith("da"), `${keyword} should start with da`);
		}
	});

	it("returns nothing for a non-matching query", () => {
		const items = suggestCrewPhrases("zzzznotaphrase");
		assert.equal(items.length, 0);
	});

	it("includes the bare 'teams' phrase", () => {
		const items = suggestCrewPhrases("tea");
		assert.ok(
			items.some((i) => i.value === "teams"),
			"should include teams",
		);
	});

	it("respects the MAX_PHRASES ceiling (bounded)", () => {
		const items = suggestCrewPhrases("");
		// MAX_PHRASES is 12; the shared list has ~10, so we won't hit the cap
		// but the result must never exceed it.
		assert.ok(items.length <= 12, `expected <= 12, got ${items.length}`);
	});
});

describe("createCrewAutocompleteProvider", () => {
	it("returns phrase suggestions for a crew trigger", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		const result = await provider.getSuggestions(["crew da"], 0, 7, {
			signal: new AbortController().signal,
		});
		assert.ok(result, "expected suggestions");
		assert.ok(!captured.delegated, "should NOT delegate on a crew trigger");
		assert.ok(result.items.length > 0, "should have phrase items");
		// prefix should be the full text to cursor
		assert.equal(result.prefix, "crew da");
	});

	it("delegates to the wrapped provider for non-crew input", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		const result = await provider.getSuggestions(["hello world"], 0, 5, {
			signal: new AbortController().signal,
		});
		assert.ok(captured.delegated, "should delegate non-crew input");
		assert.ok(result, "delegated result returned");
		assert.equal(result?.items[0]?.value, "STUB");
	});

	it("delegates slash-command input (does not shadow /commands)", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		await provider.getSuggestions(["/team-st"], 0, 8, {
			signal: new AbortController().signal,
		});
		assert.ok(captured.delegated, "slash commands must be delegated to built-in");
	});

	it("delegates file-mention input (@)", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		await provider.getSuggestions(["@sr"], 0, 4, {
			signal: new AbortController().signal,
		});
		assert.ok(captured.delegated, "@-mentions must be delegated");
	});

	it("does not trigger on a bare keyword without trailing space (e.g. 'cre')", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		await provider.getSuggestions(["cre"], 0, 3, {
			signal: new AbortController().signal,
		});
		assert.ok(captured.delegated, "partial keyword 'cre' is not a trigger — delegate");
	});

	it("triggers on 'crew ' (bare keyword + space, empty query)", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		const result = await provider.getSuggestions(["crew "], 0, 5, {
			signal: new AbortController().signal,
		});
		assert.ok(!captured.delegated, "should handle the crew trigger");
		assert.ok(result, "expected suggestions");
		assert.ok(result.items.length > 0, "empty query → all phrases");
	});

	it("returns empty (not null) for a crew trigger with no matches", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		const result = await provider.getSuggestions(["crew zzznomatch"], 0, 15, { signal: new AbortController().signal });
		assert.ok(!captured.delegated, "should not fall through to file completion");
		assert.ok(result, "expected a (empty) suggestions object");
		assert.equal(result.items.length, 0);
	});

	it("only triggers on the first line", async () => {
		const captured = { delegated: false };
		const provider = createCrewAutocompleteProvider(makeStubProvider(captured));
		// Multi-line input, cursor on line 1 (not 0) — should delegate even
		// though the text looks like a crew phrase.
		await provider.getSuggestions(["something", "crew da"], 1, 7, {
			signal: new AbortController().signal,
		});
		assert.ok(captured.delegated, "crew trigger only applies on line 0");
	});

	it("shouldTriggerFileCompletion returns false inside a crew phrase", () => {
		const provider = createCrewAutocompleteProvider(makeStubProvider({ delegated: false }));
		assert.equal(provider.shouldTriggerFileCompletion?.(["crew st"], 0, 7), false);
	});

	it("shouldTriggerFileCompletion delegates for normal input", () => {
		const provider = createCrewAutocompleteProvider(makeStubProvider({ delegated: false }));
		// For normal input, delegates to wrapped provider's method (undefined → default true)
		assert.equal(provider.shouldTriggerFileCompletion?.(["hello"], 0, 3), true);
	});

	it("applyCompletion delegates to the wrapped provider", () => {
		const calls: AutocompleteItem[] = [];
		const stub: AutocompleteProvider = {
			async getSuggestions() {
				return { items: [], prefix: "" };
			},
			applyCompletion(lines, cl, cc, item) {
				calls.push(item);
				return { lines, cursorLine: cl, cursorCol: cc };
			},
		};
		const provider = createCrewAutocompleteProvider(stub);
		const item: AutocompleteItem = {
			value: "crew status",
			label: "crew status",
		};
		provider.applyCompletion(["crew st"], 0, 7, item, "crew st");
		assert.equal(calls.length, 1, "wrapped applyCompletion should be invoked");
		assert.equal(calls[0]?.value, "crew status");
	});
});
