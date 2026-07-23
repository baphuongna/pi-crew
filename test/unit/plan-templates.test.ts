import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanTemplate } from "../../src/runtime/plan-templates.ts";
import { getPlanTemplate, listPlanTemplates, registerPlanTemplate, renderPlanTemplate } from "../../src/runtime/plan-templates.ts";

describe("plan-templates: registerPlanTemplate + getPlanTemplate", () => {
	it("retrieves a built-in template", () => {
		const tmpl = getPlanTemplate("standard-review");
		assert.ok(tmpl);
		assert.equal(tmpl!.name, "standard-review");
		assert.ok(tmpl!.phases.length > 0);
	});

	it("retrieves the full-implementation built-in template", () => {
		const tmpl = getPlanTemplate("full-implementation");
		assert.ok(tmpl);
		assert.equal(tmpl!.name, "full-implementation");
		assert.equal(tmpl!.phases.length, 5);
	});

	it("returns undefined for unknown template", () => {
		const tmpl = getPlanTemplate("nonexistent-template");
		assert.equal(tmpl, undefined);
	});

	it("registers and retrieves a custom template", () => {
		const custom: PlanTemplate = {
			name: "test-custom",
			description: "A test template",
			phases: [
				{
					name: "step1",
					role: "agent",
					taskTemplate: "Do {{thing}}",
					maxTasks: 1,
					dependsOn: [],
				},
			],
			verificationCommands: {},
		};
		registerPlanTemplate(custom);
		const retrieved = getPlanTemplate("test-custom");
		assert.ok(retrieved);
		assert.equal(retrieved!.name, "test-custom");
	});
});

describe("plan-templates: listPlanTemplates", () => {
	it("includes built-in templates", () => {
		const names = listPlanTemplates();
		assert.ok(names.includes("standard-review"));
		assert.ok(names.includes("full-implementation"));
	});
});

describe("plan-templates: renderPlanTemplate", () => {
	it("renders standard-review with variable substitution", () => {
		const rendered = renderPlanTemplate("standard-review", {
			goal: "fix security bug",
			focusAreas: "auth module",
		});
		assert.ok(rendered);
		assert.equal(rendered!.templateName, "standard-review");
		assert.equal(rendered!.phases.length, 3);

		// Check variable substitution happened
		const explore = rendered!.phases.find((p) => p.name === "explore");
		assert.ok(explore);
		assert.ok(explore!.task.includes("fix security bug"));
		assert.ok(explore!.task.includes("auth module"));
	});

	it("renders full-implementation template", () => {
		const rendered = renderPlanTemplate("full-implementation", {
			goal: "add feature X",
		});
		assert.ok(rendered);
		assert.equal(rendered!.phases.length, 5);

		// Check dependencies are preserved
		const plan = rendered!.phases.find((p) => p.name === "plan");
		assert.ok(plan);
		assert.deepEqual(plan!.dependsOn, ["explore"]);
	});

	it("preserves unsubstituted variables as-is", () => {
		// Register a custom template for this test
		registerPlanTemplate({
			name: "var-test",
			description: "Variable test",
			phases: [
				{
					name: "step",
					role: "agent",
					taskTemplate: "Do {{known}} and {{unknown}}",
					maxTasks: 1,
					dependsOn: [],
				},
			],
			verificationCommands: {},
		});

		const rendered = renderPlanTemplate("var-test", { known: "hello" });
		assert.ok(rendered);
		assert.ok(rendered!.phases[0].task.includes("hello"));
		assert.ok(rendered!.phases[0].task.includes("{{unknown}}"));
	});

	it("returns undefined for nonexistent template", () => {
		const rendered = renderPlanTemplate("nonexistent", {});
		assert.equal(rendered, undefined);
	});

	it("includes verification commands from phase and template level", () => {
		const rendered = renderPlanTemplate("standard-review", {
			goal: "test",
			focusAreas: "all",
		});
		assert.ok(rendered);

		const verifyPhase = rendered!.phases.find((p) => p.name === "verify");
		assert.ok(verifyPhase);
		assert.equal(verifyPhase!.verificationCommand, "npm run test:critical && npx tsc --noEmit");
	});
});
