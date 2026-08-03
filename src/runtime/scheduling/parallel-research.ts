import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowConfig, WorkflowStep } from "../../workflows/workflow-config.ts";

export function sourcePiProjects(cwd: string): string[] {
	const sourceDir = path.join(cwd, "Source");
	try {
		return fs
			.readdirSync(sourceDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-"))
			.map((entry) => `Source/${entry.name}`)
			.sort();
	} catch {
		return [];
	}
}

export function chunkProjects(projects: string[], target = 6): string[][] {
	const chunks = Array.from({ length: Math.min(Math.max(1, target), Math.max(1, projects.length)) }, () => [] as string[]);
	projects.forEach((project, index) => {
		chunks[index % chunks.length]!.push(project);
	});
	return chunks.filter((chunk) => chunk.length > 0);
}

export function expandParallelResearchWorkflow(workflow: WorkflowConfig, cwd: string): WorkflowConfig {
	if (workflow.name !== "parallel-research") return workflow;
	const projects = sourcePiProjects(cwd);
	if (projects.length === 0) return workflow;
	const chunks = chunkProjects(projects, Math.min(8, Math.max(4, Math.ceil(projects.length / 3))));
	const exploreSteps: WorkflowStep[] = chunks.map((paths, index) => ({
		id: `explore-shard-${index + 1}`,
		role: "explorer",
		parallelGroup: "explore",
		reads: paths,
		task: [
			`Explore this dynamic shard for: {goal}`,
			"",
			"Paths:",
			...paths.map((item) => `- ${item}`),
			"",
			"Focus on purpose, architecture, runtime/UI patterns, package config, docs, and lessons for pi-crew.",
		].join("\n"),
	}));
	return {
		...workflow,
		steps: [
			{
				id: "discover",
				role: "explorer",
				parallelGroup: "inventory",
				task: `Quickly inventory and validate ${projects.length} pi-* projects for: {goal}\n\nProjects:\n${projects.map((item) => `- ${item}`).join("\n")}\n\nDo not block shard work; summarize routing notes only.`,
			},
			...exploreSteps,
			{
				id: "synthesize",
				role: "analyst",
				dependsOn: exploreSteps.map((step) => step.id),
				task: "Synthesize all dynamic shard findings. Identify common patterns, gaps, and concrete recommendations. Use discover output if available, but prioritize completed shard outputs.",
			},
			{
				id: "write",
				role: "writer",
				dependsOn: ["synthesize"],
				output: "research-summary.md",
				task: "Write a concise final summary with evidence, risks, and actionable next steps.",
			},
		],
	};
}
