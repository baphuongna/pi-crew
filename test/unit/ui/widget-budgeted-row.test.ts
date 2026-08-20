/**
 * Unit tests for the compact (one-line, width-budgeted) widget row.
 *
 * The budget contract (from pi-subtask's width-aware widget rows):
 *  - `lead` and `suffix` are fixed costs, never trimmed;
 *  - the activity shrinks first but keeps a readable floor;
 *  - the name grows into whatever the activity leaves over;
 *  - the assembled line never exceeds `width` at any terminal size.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCost, type BudgetedRowParts, budgetedRow } from "../../../src/ui/widget/widget-formatters.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

function parts(overrides: Partial<BudgetedRowParts> = {}): BudgetedRowParts {
	return {
		lead: "│ ❯✻ ",
		name: "explorer · explore the repo and map the auth flow end to end",
		activity: "grep /authFlow/ and read the router to trace who calls it",
		suffix: " · 12 tools · 45.2k tok · $0.05 · 41s",
		...overrides,
	};
}

function assertFits(row: string, width: number): void {
	const w = visibleWidth(row);
	assert.ok(w <= width, `row width ${w} exceeds ${width}: ${JSON.stringify(row.slice(0, 80))}`);
}

test("budgetedRow never overflows at 40 / 80 / 200 columns", () => {
	for (const width of [40, 80, 200]) {
		const row = budgetedRow(parts(), width);
		assertFits(row, width);
		assert.ok(row.startsWith(parts().lead), "lead must survive at every width");
	}
});

test("budgetedRow: a wider terminal shows a longer name", () => {
	const narrow = budgetedRow(parts(), 60);
	const wide = budgetedRow(parts(), 200);
	// Same lead/suffix, so extra width must go into the middle fields.
	assert.ok(visibleWidth(wide) >= visibleWidth(narrow), "wider output must never be shorter than narrow output");
	const nameNarrow = narrow.split(" · ")[1] ?? "";
	const nameWide = wide.split(" · ")[1] ?? "";
	assert.ok(visibleWidth(nameWide) >= visibleWidth(nameNarrow), "the name field must expand into the extra width");
});

test("budgetedRow: suffix is never trimmed (metrics stay comparable)", () => {
	const suffix = parts().suffix;
	for (const width of [60, 100]) {
		const row = budgetedRow(parts(), width);
		assert.ok(row.endsWith(suffix), `suffix intact at width ${width}: ${JSON.stringify(row.slice(-suffix.length - 5))}`);
	}
});

test("budgetedRow: missing activity falls back to name + suffix", () => {
	const row = budgetedRow(parts({ activity: "" }), 80);
	assert.ok(row.includes("explorer"));
	assert.ok(row.endsWith(parts().suffix));
	assertFits(row, 80);
});

test("budgetedRow: very narrow terminal degrades to name only, still fits", () => {
	const row = budgetedRow(parts(), 24);
	assertFits(row, 24);
});

test("agentCost: hides zero/undefined cost, formats real spend", () => {
	assert.equal(agentCost({ usage: undefined } as never), "");
	assert.equal(agentCost({ usage: { cost: 0 } } as never), "");
	assert.equal(agentCost({ usage: { cost: -1 } } as never), "");
	assert.equal(agentCost({ usage: { cost: 0.05 } } as never), "$0.0500");
	assert.equal(agentCost({ usage: { cost: 2 } } as never), "$2.00");
});
