import assert from "node:assert/strict";
import test from "node:test";
import { type CrewSelectItem, CrewSelectList } from "../../src/ui/crew-select-list.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";

const theme: CrewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

function items(count: number): CrewSelectItem<number>[] {
	return Array.from({ length: count }, (_value, index) => ({
		value: index,
		label: `Item ${index}`,
		description: `Desc ${index}`,
	}));
}

test("CrewSelectList renders items with selected marker", () => {
	const list = new CrewSelectList(items(5), theme, {
		onSelect: () => undefined,
		onCancel: () => undefined,
	});
	const lines = list.render(80);
	assert.equal(lines.length, 5);
	assert.ok(lines[0].includes(" → Item 0"));
});

test("CrewSelectList moves down with j and previews selected item", () => {
	const previews: number[] = [];
	const list = new CrewSelectList(items(3), theme, {
		onSelect: () => undefined,
		onCancel: () => undefined,
		onPreview: (item) => previews.push(item.value),
	});
	list.handleInput("j");
	assert.equal(list.getSelected()?.value, 1);
	assert.deepEqual(previews, [1]);
});

test("CrewSelectList selects current item on enter", () => {
	let selected: number | undefined;
	const list = new CrewSelectList(items(3), theme, {
		onSelect: (item) => {
			selected = item.value;
		},
		onCancel: () => undefined,
	});
	list.setSelectedIndex(2);
	list.handleInput("\n");
	assert.equal(selected, 2);
});

test("CrewSelectList cancels on escape", () => {
	let cancelled = false;
	const list = new CrewSelectList(items(1), theme, {
		onSelect: () => undefined,
		onCancel: () => {
			cancelled = true;
		},
	});
	list.handleInput("\u001b");
	assert.equal(cancelled, true);
});

test("CrewSelectList scrolls and shows more indicators", () => {
	const list = new CrewSelectList(items(10), theme, {
		onSelect: () => undefined,
		onCancel: () => undefined,
		maxHeight: 3,
	});
	list.setSelectedIndex(5);
	const lines = list.render(80);
	assert.equal(lines.length, 3);
	assert.ok(lines.some((line) => line.includes("↑")));
	assert.ok(lines.some((line) => line.includes("↓")));
	assert.ok(lines.some((line) => line.includes(" → Item 5")));
});
