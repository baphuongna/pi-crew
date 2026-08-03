import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findTemplate, getBuiltinTemplates, instantiateTemplate, listTemplates } from "../../../src/skills/skill-templates.ts";

describe("skill-templates", () => {
	describe("getBuiltinTemplates", () => {
		it("returns a non-empty array of templates", () => {
			const templates = getBuiltinTemplates();
			assert.ok(Array.isArray(templates));
			assert.ok(templates.length >= 5, "should have at least 5 builtin templates");
		});

		it("every template has required fields", () => {
			const templates = getBuiltinTemplates();
			for (const t of templates) {
				assert.ok(t.id, "template should have an id");
				assert.ok(t.name, "template should have a name");
				assert.ok(t.description, "template should have a description");
				assert.ok(t.category, "template should have a category");
				assert.ok(Array.isArray(t.variables), "template should have variables array");
				assert.ok(typeof t.body === "string" && t.body.length > 0, "template should have a body");
				assert.ok(Array.isArray(t.guardrails), "template should have guardrails array");
			}
		});

		it("contains expected template ids", () => {
			const templates = getBuiltinTemplates();
			const ids = templates.map((t) => t.id);
			assert.ok(ids.includes("code-review"), "should include code-review");
			assert.ok(ids.includes("testing"), "should include testing");
			assert.ok(ids.includes("security-audit"), "should include security-audit");
			assert.ok(ids.includes("refactor"), "should include refactor");
			assert.ok(ids.includes("documentation"), "should include documentation");
		});

		it("template ids are unique", () => {
			const templates = getBuiltinTemplates();
			const ids = templates.map((t) => t.id);
			const uniqueIds = new Set(ids);
			assert.equal(uniqueIds.size, ids.length, "template ids should be unique");
		});
	});

	describe("findTemplate", () => {
		it("finds a template by id (exact match)", () => {
			const t = findTemplate("code-review");
			assert.ok(t, "should find code-review by id");
			assert.equal(t.id, "code-review");
		});

		it("finds a template by name (case-insensitive)", () => {
			const t = findTemplate("code review");
			assert.ok(t, "should find template by name");
			assert.equal(t.id, "code-review");
		});

		it("finds a template by id case-insensitively", () => {
			const t = findTemplate("Code-Review");
			assert.ok(t, "should find template case-insensitively");
			assert.equal(t.id, "code-review");
		});

		it("returns undefined for unknown id", () => {
			const t = findTemplate("nonexistent-template");
			assert.equal(t, undefined);
		});

		it("returns undefined for empty string", () => {
			const t = findTemplate("");
			assert.equal(t, undefined);
		});
	});

	describe("instantiateTemplate", () => {
		it("instantiates a template with all variables provided", () => {
			const t = findTemplate("code-review");
			assert.ok(t);
			const result = instantiateTemplate(t, {
				language: "TypeScript",
				focusAreas: "correctness, performance",
				severityThreshold: "error",
			});
			assert.equal(result.filename, "code-review.SKILL.md");
			assert.ok(result.content.includes("TypeScript"), "should contain language value");
			assert.ok(result.content.includes("correctness, performance"), "should contain focus areas");
			assert.ok(result.content.includes("error"), "should contain severity threshold");
			assert.ok(result.content.includes("# Code Review Skill"), "should have the heading");
		});

		it("uses defaults for optional variables", () => {
			const t = findTemplate("code-review");
			assert.ok(t);
			const result = instantiateTemplate(t, {
				language: "Rust",
			});
			assert.ok(result.content.includes("Rust"), "should contain the provided language");
			assert.ok(result.content.includes("correctness, readability, performance"), "should use default focusAreas");
			assert.ok(result.content.includes("warning"), "should use default severityThreshold");
		});

		it("throws for missing required variables", () => {
			const t = findTemplate("code-review");
			assert.ok(t);
			assert.throws(
				() => instantiateTemplate(t, {}),
				(err: unknown) => {
					assert.ok(err instanceof Error, "should throw an Error");
					assert.ok(err.message.includes("language"), "error message should mention the missing variable");
					assert.ok(err.message.includes("required"), "error message should say required");
					return true;
				},
			);
		});

		it("throws for invalid option value", () => {
			const t = findTemplate("code-review");
			assert.ok(t);
			assert.throws(
				() =>
					instantiateTemplate(t, {
						language: "TypeScript",
						severityThreshold: "nonexistent",
					}),
				(err: unknown) => {
					assert.ok(err instanceof Error, "should throw an Error");
					assert.ok(err.message.includes("nonexistent"), "error should mention the invalid value");
					assert.ok(err.message.includes("Allowed values"), "error should mention allowed values");
					return true;
				},
			);
		});

		it("accepts valid option value for language", () => {
			const t = findTemplate("code-review");
			assert.ok(t);
			// Should not throw
			const result = instantiateTemplate(t, { language: "Go" });
			assert.ok(result.content.includes("Go"));
		});

		it("instantiates testing template correctly", () => {
			const t = findTemplate("testing");
			assert.ok(t);
			const result = instantiateTemplate(t, {
				framework: "vitest",
				coverageTarget: "90",
				testType: "unit",
			});
			assert.equal(result.filename, "testing.SKILL.md");
			assert.ok(result.content.includes("vitest"));
			assert.ok(result.content.includes("90"));
			assert.ok(result.content.includes("unit"));
		});

		it("instantiates security-audit template with defaults", () => {
			const t = findTemplate("security-audit");
			assert.ok(t);
			const result = instantiateTemplate(t, { scope: "api-surface" });
			assert.ok(result.content.includes("api-surface"));
			assert.ok(result.content.includes("medium"), "should use default severityThreshold");
			assert.ok(result.content.includes("OWASP Top 10"), "should use default complianceFramework");
		});

		it("instantiates refactor template with all variables", () => {
			const t = findTemplate("refactor");
			assert.ok(t);
			const result = instantiateTemplate(t, {
				scope: "authentication module",
				constraints: "keep backward compatibility",
				goal: "reduce coupling",
			});
			assert.ok(result.content.includes("authentication module"));
			assert.ok(result.content.includes("keep backward compatibility"));
			assert.ok(result.content.includes("reduce coupling"));
		});

		it("instantiates documentation template with defaults", () => {
			const t = findTemplate("documentation");
			assert.ok(t);
			const result = instantiateTemplate(t, { format: "markdown" });
			assert.ok(result.content.includes("markdown"));
			assert.ok(result.content.includes("developers"), "should use default audience");
			assert.ok(result.content.includes("standard"), "should use default detailLevel");
		});

		it("renders all variable placeholders in body", () => {
			const t = findTemplate("testing");
			assert.ok(t);
			const result = instantiateTemplate(t, {
				framework: "pytest",
				coverageTarget: "95",
				testType: "integration",
			});
			// No unresolved {placeholder} should remain
			const unresolved = result.content.match(/\{[a-zA-Z_]+\}/g);
			assert.equal(unresolved, null, "no unresolved placeholders should remain");
		});
	});

	describe("listTemplates", () => {
		it("returns a simplified template listing", () => {
			const listing = listTemplates();
			assert.ok(Array.isArray(listing));
			assert.equal(listing.length, getBuiltinTemplates().length, "should list all templates");
		});

		it("each entry has expected fields", () => {
			const listing = listTemplates();
			for (const entry of listing) {
				assert.ok(entry.id, "entry should have id");
				assert.ok(entry.name, "entry should have name");
				assert.ok(entry.description, "entry should have description");
				assert.ok(entry.category, "entry should have category");
				assert.ok(Array.isArray(entry.variables), "entry should have variables array");
				for (const v of entry.variables) {
					assert.ok(v.name, "variable should have name");
					assert.equal(typeof v.required, "boolean", "variable.required should be boolean");
				}
			}
		});

		it("does not expose template body or guardrails", () => {
			const listing = listTemplates();
			for (const entry of listing) {
				assert.equal((entry as Record<string, unknown>).body, undefined, "should not expose body");
				assert.equal((entry as Record<string, unknown>).guardrails, undefined, "should not expose guardrails");
			}
		});
	});
});
