import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverWorkflows, allWorkflows } from "../../src/workflows/discover-workflows.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

describe("discoverWorkflows", () => {
	it("returns empty result for empty string cwd", () => {
		const result = discoverWorkflows("");
		assert.deepEqual(result, { builtin: [], user: [], project: [] });
	});

	it("returns empty result for non-string cwd", () => {
		// @ts-expect-error testing invalid input
		const result = discoverWorkflows(null);
		assert.deepEqual(result, { builtin: [], user: [], project: [] });
	});

	it("returns empty result for undefined cwd", () => {
		// @ts-expect-error testing invalid input
		const result = discoverWorkflows(undefined);
		assert.deepEqual(result, { builtin: [], user: [], project: [] });
	});

	it("returns empty project array when no project workflows directory exists", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const result = discoverWorkflows(tmp);
			assert.ok(Array.isArray(result.project));
			assert.equal(result.project.length, 0);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("discovers project workflows from .crew/workflows", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "test.workflow.md"), [
				"---",
				"name: test-wf",
				"description: A test workflow",
				"---",
				"## step1",
				"role: explorer",
				"",
				"Do the thing",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project.length, 1);
			assert.equal(result.project[0]!.name, "test-wf");
			assert.equal(result.project[0]!.description, "A test workflow");
			assert.equal(result.project[0]!.source, "project");
			assert.equal(result.project[0]!.steps.length, 1);
			assert.equal(result.project[0]!.steps[0]!.id, "step1");
			assert.equal(result.project[0]!.steps[0]!.role, "explorer");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("ignores non .workflow.md files", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "notes.md"), "# Notes", "utf-8");
			fs.writeFileSync(path.join(wfDir, "valid.workflow.md"), [
				"---",
				"name: valid",
				"---",
				"## step1",
				"role: explorer",
				"",
				"task",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project.length, 1);
			assert.equal(result.project[0]!.name, "valid");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("sorts workflows by name", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "beta.workflow.md"), [
				"---\nname: beta\n---\n## s1\nrole: x\n\nt",
			].join("\n"), "utf-8");
			fs.writeFileSync(path.join(wfDir, "alpha.workflow.md"), [
				"---\nname: alpha\n---\n## s1\nrole: x\n\nt",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project.length, 2);
			assert.equal(result.project[0]!.name, "alpha");
			assert.equal(result.project[1]!.name, "beta");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("uses filename as name when frontmatter name is missing", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "my-flow.workflow.md"), [
				"---\n---\n## step1\nrole: explorer\n\ntask",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project.length, 1);
			assert.equal(result.project[0]!.name, "my-flow");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("parses step config keys including dependsOn and parallelGroup", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "deps.workflow.md"), [
				"---\nname: deps\n---",
				"## step1",
				"role: explorer",
				"",
				"Explore",
				"## step2",
				"role: analyst",
				"dependsOn: step1",
				"parallelGroup: analysis",
				"",
				"Analyze",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project.length, 1);
			const steps = result.project[0]!.steps;
			assert.equal(steps.length, 2);
			assert.deepEqual(steps[1]!.dependsOn, ["step1"]);
			assert.equal(steps[1]!.parallelGroup, "analysis");
		} finally {
			removeTrackedTempDir(tmp);
		}
	});

	it("parses output: false correctly", () => {
		const tmp = createTrackedTempDir("pi-crew-dw-");
		try {
			const wfDir = path.join(tmp, ".crew", "workflows");
			fs.mkdirSync(wfDir, { recursive: true });
			fs.writeFileSync(path.join(wfDir, "out.workflow.md"), [
				"---\nname: out\n---",
				"## step1",
				"role: explorer",
				"output: false",
				"",
				"Task",
			].join("\n"), "utf-8");

			const result = discoverWorkflows(tmp);
			assert.equal(result.project[0]!.steps[0]!.output, false);
		} finally {
			removeTrackedTempDir(tmp);
		}
	});
});

describe("allWorkflows", () => {
	it("returns empty array for undefined input", () => {
		assert.deepEqual(allWorkflows(undefined), []);
	});

	it("merges and deduplicates by name (user wins over builtin, which wins over project)", () => {
		const projectWf = {
			name: "shared",
			description: "project version",
			source: "project" as const,
			filePath: "/p",
			steps: [],
		};
		const builtinWf = {
			name: "shared",
			description: "builtin version",
			source: "builtin" as const,
			filePath: "/b",
			steps: [],
		};
		const userWf = {
			name: "user-only",
			description: "user only",
			source: "user" as const,
			filePath: "/u",
			steps: [],
		};
		const discovery = {
			builtin: [builtinWf],
			user: [userWf],
			project: [projectWf],
		};

		const result = allWorkflows(discovery);
		assert.equal(result.length, 2);
		// Iteration order is project, builtin, user — Map.set overwrites, so user wins
		// But "shared" is only in project and builtin, so builtin wins (last-set for that name)
		const shared = result.find((w) => w.name === "shared");
		assert.ok(shared);
		assert.equal(shared!.source, "builtin");
	});

	it("sorts merged workflows alphabetically", () => {
		const discovery = {
			builtin: [{ name: "zebra", description: "", source: "builtin" as const, filePath: "/z", steps: [] }],
			user: [{ name: "alpha", description: "", source: "user" as const, filePath: "/a", steps: [] }],
			project: [],
		};
		const result = allWorkflows(discovery);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.name, "alpha");
		assert.equal(result[1]!.name, "zebra");
	});

	it("returns empty when all source arrays are empty", () => {
		const result = allWorkflows({ builtin: [], user: [], project: [] });
		assert.deepEqual(result, []);
	});
});
