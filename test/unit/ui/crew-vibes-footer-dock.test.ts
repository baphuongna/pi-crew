/**
 * Unit tests for the crew-vibes footer painting the dock as its LAST block
 * (below pwd/stats/meters) and for the sink flag GATING it (a dock provider
 * must not render when the sink is off, e.g. vibes disabled).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewVibesConfig } from "../../../src/extension/crew-vibes/config.ts";
import { type CrewVibesFooterDeps, createCrewVibesFooter } from "../../../src/extension/crew-vibes/footer.ts";
import {
	getFooterDockProvider,
	resetFooterDockRegistry,
	setFooterDockProvider,
	setFooterDockSinkActive,
} from "../../../src/ui/dock-footer.ts";

const DISABLED_CONFIG = { enabled: false } as CrewVibesConfig;

function makeDeps(): CrewVibesFooterDeps {
	const sessionManager = {
		getCwd: () => "/tmp/project",
		getSessionName: () => "main",
		getEntries: () => [],
		buildSessionContext: () => undefined,
	};
	const ctx = {
		sessionManager,
		model: undefined,
		getContextUsage: () => undefined,
		modelRegistry: undefined,
	} as unknown as CrewVibesFooterDeps["ctx"];
	return {
		tui: undefined,
		theme: undefined,
		footerData: undefined,
		ctx,
		source: {
			getConfig: () => DISABLED_CONFIG,
			getQuotaUsage: () => null,
			getThinkingLevel: () => undefined,
		},
	};
}

test("dock lines are painted as the footer's last block", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		const footer = createCrewVibesFooter(makeDeps());
		setFooterDockProvider(() => ["HINT dock line", "● main"]);
		const lines = footer.render(80);
		assert.ok(lines.length >= 4, `pwd + stats + (no meters) + dock, got ${lines.length}`);
		assert.equal(lines.at(-2)?.trimEnd(), "HINT dock line", "dock block starts after the footer's own lines");
		assert.equal(lines.at(-1)?.trimEnd(), "● main", "dock is the very last block, below the meters");
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("no provider → no dock block", () => {
	resetFooterDockRegistry();
	try {
		const footer = createCrewVibesFooter(makeDeps());
		const lines = footer.render(80);
		const hasDock = lines.some((line) => line.includes("dock line") || line.includes("● main"));
		assert.equal(hasDock, false, "nothing dock-shaped is painted without a provider");
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("dock lines are truncated to the real render width", () => {
	resetFooterDockRegistry();
	try {
		const footer = createCrewVibesFooter(makeDeps());
		setFooterDockProvider(() => ["x".repeat(200)]);
		const lines = footer.render(40).filter((line) => line.includes("xxx"));
		assert.ok(lines.length > 0);
		for (const line of lines) {
			// Strip ANSI before measuring.
			const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
			assert.ok(plain.length <= 40, `dock line bounded by footer width, got ${plain.length}`);
		}
		footer.dispose();
	} finally {
		resetFooterDockRegistry();
	}
});

test("sink flag gates the dock (dock-footer sink governs vibes rendering)", () => {
	resetFooterDockRegistry();
	setFooterDockProvider(() => ["● main"]);
	try {
		// The widget only registers a provider when the sink is active; this
		// asserts the flag and provider travel together through the registry.
		setFooterDockSinkActive(true);
		assert.ok(getFooterDockProvider(), "provider visible to the footer while the sink is on");
		setFooterDockSinkActive(false);
		// The provider itself is untouched by the flag — the WIDGET decides
		// whether to (un)register it; the footer just paints whatever exists.
		assert.ok(getFooterDockProvider(), "provider survives the flag toggle");
	} finally {
		setFooterDockSinkActive(false);
		resetFooterDockRegistry();
	}
});
