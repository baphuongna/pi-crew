import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteCrewInput, handleCrewInput, registerCrewInputRouter } from "../../src/extension/crew-input-router.ts";
import type { InputEvent } from "@earendil-works/pi-coding-agent";

describe("rewriteCrewInput", () => {
	it("returns null for slash commands (never shadows)", () => {
		assert.equal(rewriteCrewInput("/team-status"), null);
		assert.equal(rewriteCrewInput("/anything else"), null);
	});

	it("returns null for plain sentences", () => {
		assert.equal(rewriteCrewInput("how do I use the crew feature?"), null);
		assert.equal(rewriteCrewInput("the team is working on it"), null);
		assert.equal(rewriteCrewInput(""), null);
	});

	it("rewrites 'crew status' → /team-status", () => {
		assert.equal(rewriteCrewInput("crew status"), "/team-status");
		assert.equal(rewriteCrewInput("team status"), "/team-status");
	});

	it("rewrites 'crew list' → /team-status", () => {
		assert.equal(rewriteCrewInput("crew list"), "/team-status");
	});

	it("rewrites 'crew dashboard' → /team-dashboard", () => {
		assert.equal(rewriteCrewInput("crew dashboard"), "/team-dashboard");
		assert.equal(rewriteCrewInput("team board"), "/team-dashboard");
		assert.equal(rewriteCrewInput("team panel"), "/team-dashboard");
	});

	it("rewrites 'crew help' → /team-help", () => {
		assert.equal(rewriteCrewInput("crew help"), "/team-help");
		assert.equal(rewriteCrewInput("team commands"), "/team-help");
	});

	it("rewrites 'teams' → /teams", () => {
		assert.equal(rewriteCrewInput("teams"), "/teams");
	});

	it("rewrites 'crew doctor' → /team-doctor", () => {
		assert.equal(rewriteCrewInput("crew doctor"), "/team-doctor");
		assert.equal(rewriteCrewInput("team diagnose"), "/team-doctor");
	});

	it("carries trailing args forward", () => {
		assert.equal(rewriteCrewInput("crew status team_abc123"), "/team-status team_abc123");
		assert.equal(rewriteCrewInput("crew dashboard run1"), "/team-dashboard run1");
	});

	it("is case-insensitive", () => {
		assert.equal(rewriteCrewInput("CREW STATUS"), "/team-status");
		assert.equal(rewriteCrewInput("Team Status"), "/team-status");
		assert.equal(rewriteCrewInput("Crew Dashboard"), "/team-dashboard");
	});

	it("requires a word boundary (no partial matches mid-word)", () => {
		// "crews" should not match "crew status" rule
		assert.equal(rewriteCrewInput("crews of workers"), null);
	});
});

describe("handleCrewInput", () => {
	it("transforms interactive crew phrases", () => {
		const event: InputEvent = { type: "input", text: "crew status", source: "interactive" };
		const result = handleCrewInput(event);
		assert.equal(result.action, "transform");
		if (result.action === "transform") assert.equal(result.text, "/team-status");
	});

	it("passes through non-crew interactive input", () => {
		const event: InputEvent = { type: "input", text: "explain this code", source: "interactive" };
		const result = handleCrewInput(event);
		assert.equal(result.action, "continue");
	});

	it("passes through slash commands", () => {
		const event: InputEvent = { type: "input", text: "/team-status", source: "interactive" };
		const result = handleCrewInput(event);
		assert.equal(result.action, "continue");
	});

	it("does NOT transform non-interactive (rpc/extension) input", () => {
		const event: InputEvent = { type: "input", text: "crew status", source: "rpc" };
		const result = handleCrewInput(event);
		assert.equal(result.action, "continue");
	});

	it("preserves images when transforming", () => {
		const event: InputEvent = {
			type: "input",
			text: "crew dashboard",
			source: "interactive",
			images: [{ type: "image", source: { kind: "inline", data: "abc" } } as never],
		};
		const result = handleCrewInput(event);
		assert.equal(result.action, "transform");
		if (result.action === "transform") {
			assert.ok(result.images);
			assert.equal(result.images!.length, 1);
		}
	});
});

describe("registerCrewInputRouter", () => {
	it("registers an input handler without throwing", () => {
		const events: string[] = [];
		const fakePi = { on: (event: string) => { events.push(event); } };
		registerCrewInputRouter(fakePi as never);
		assert.ok(events.includes("input"));
	});

	it("is safe when pi.on is undefined", () => {
		registerCrewInputRouter({} as never);
		// Should not throw
	});
});
