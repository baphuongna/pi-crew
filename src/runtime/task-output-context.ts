import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { WorkflowStep } from "../workflows/workflow-config.ts";

export interface DependencyContextEntry {
	taskId: string;
	role: string;
	status: string;
	resultSummary: string;
	resultPath?: string;
	structuredResults?: Record<string, unknown>;
	artifactsProduced?: string[];
	usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

export interface DependencyOutputContext {
	dependencies: DependencyContextEntry[];
	sharedReads: Array<{ name: string; path: string; content: string }>;
}

function containedExists(filePath: string, baseDir?: string): boolean {
	try {
		const safePath = baseDir ? resolveRealContainedPath(baseDir, filePath) : filePath;
		return fs.existsSync(safePath);
	} catch {
		return false;
	}
}

function readIfSmall(filePath: string, maxBytes = 24_000, baseDir?: string): string | undefined {
	try {
		const safePath = baseDir ? resolveRealContainedPath(baseDir, filePath) : filePath;
		const stat = fs.statSync(safePath);
		if (stat.size > maxBytes) {
			// Use bounded read to avoid loading entire file into memory
			const buf = Buffer.alloc(maxBytes);
			const fd = fs.openSync(safePath, "r");
			try {
				fs.readSync(fd, buf, 0, maxBytes, 0);
			} finally {
				fs.closeSync(fd);
			}
			return `${buf.toString("utf-8")}\n\n...(truncated ${stat.size - maxBytes} bytes)`;
		}
		return fs.readFileSync(safePath, "utf-8");
	} catch {
		return undefined;
	}
}

function safeSharedName(name: string): string {
	const normalized = name.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (!normalized || normalized.split("/").some((segment) => segment === "..") || path.isAbsolute(normalized)) throw new Error(`Invalid shared artifact name: ${name}`);
	return normalized;
}

export function sharedPath(manifest: TeamRunManifest, name: string): string {
	const sharedRoot = path.resolve(manifest.artifactsRoot, "shared");
	const resolved = path.resolve(sharedRoot, safeSharedName(name));
	const relative = path.relative(sharedRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid shared artifact name: ${name}`);
	return resolved;
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Not valid JSON object — return undefined.
	}
	return undefined;
}

function listTaskArtifacts(manifest: TeamRunManifest, taskId: string): string[] | undefined {
	const produced = manifest.artifacts.filter((a) => a.producer === taskId);
	if (produced.length === 0) return undefined;
	return produced.map((a) => {
		const relative = path.relative(manifest.artifactsRoot, a.path);
		return relative.startsWith("..") ? a.path : relative;
	});
}

function aggregateUsage(task: TeamTaskState): DependencyContextEntry["usage"] {
	if (!task.usage) return undefined;
	const inputTokens = task.usage.input ?? 0;
	const outputTokens = task.usage.output ?? 0;
	const started = task.startedAt ? new Date(task.startedAt).getTime() : 0;
	const finished = task.finishedAt ? new Date(task.finishedAt).getTime() : 0;
	const durationMs = started && finished ? finished - started : 0;
	if (inputTokens === 0 && outputTokens === 0 && durationMs === 0) return undefined;
	return { inputTokens, outputTokens, durationMs };
}

export function collectDependencyOutputContext(manifest: TeamRunManifest, tasks: TeamTaskState[], task: TeamTaskState, step: WorkflowStep): DependencyOutputContext {
	const byStep = new Map(tasks.map((item) => [item.stepId, item]).filter((entry): entry is [string, TeamTaskState] => Boolean(entry[0])));
	const byId = new Map(tasks.map((item) => [item.id, item]));
	const dependencies = task.dependsOn.map((dep) => byStep.get(dep) ?? byId.get(dep)).filter((item): item is TeamTaskState => Boolean(item)).map((item) => {
		const resultText = item.resultArtifact ? readIfSmall(item.resultArtifact.path, 24_000, manifest.artifactsRoot) : undefined;
		return {
			taskId: item.id,
			role: item.role,
			status: item.status,
			resultSummary: resultText ?? "",
			resultPath: item.resultArtifact?.path,
			structuredResults: resultText ? tryParseJson(resultText) : undefined,
			artifactsProduced: listTaskArtifacts(manifest, item.id),
			usage: aggregateUsage(item),
		};
	});
	const sharedReads = (step.reads === false ? [] : step.reads ?? []).map((name) => {
		const filePath = sharedPath(manifest, name);
		return { name, path: filePath, content: readIfSmall(filePath, 24_000, path.resolve(manifest.artifactsRoot, "shared")) ?? "" };
	}).filter((item) => item.content.trim().length > 0);
	return { dependencies, sharedReads };
}

export function renderDependencyOutputContext(context: DependencyOutputContext): string {
	const parts: string[] = [];
	if (context.dependencies.length) {
		parts.push("# Dependency Outputs", "");
		for (const dep of context.dependencies) {
			parts.push(`## ${dep.taskId} (${dep.role})`, `Status: ${dep.status}`, dep.resultPath ? `Result artifact: ${dep.resultPath}` : "", "", dep.resultSummary?.trim() || "(no result output)", "");
			if (dep.structuredResults) parts.push("Structured results:", JSON.stringify(dep.structuredResults, null, 2), "");
			if (dep.artifactsProduced?.length) parts.push(`Artifacts produced: ${dep.artifactsProduced.join(", ")}`, "");
			if (dep.usage) parts.push(`Usage: ${dep.usage.inputTokens} input tokens, ${dep.usage.outputTokens} output tokens, ${dep.usage.durationMs}ms`, "");
		}
	}
	if (context.sharedReads.length) {
		parts.push("# Shared Run Context Reads", "");
		for (const read of context.sharedReads) parts.push(`## shared/${read.name}`, `Path: ${read.path}`, "", read.content.trim(), "");
	}
	return parts.join("\n").trim();
}

export function writeTaskSharedOutput(manifest: TeamRunManifest, step: WorkflowStep, task: TeamTaskState): ArtifactDescriptor | undefined {
	if (step.output === false) return undefined;
	const name = safeSharedName(step.output || `${task.id}.md`);
	const source = task.resultArtifact ? readIfSmall(task.resultArtifact.path, 80_000, manifest.artifactsRoot) : undefined;
	if (!source) return undefined;
	return writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `shared/${name}`,
		producer: task.id,
		content: source.endsWith("\n") ? source : `${source}\n`,
	});
}

export function writeTaskInputsArtifact(manifest: TeamRunManifest, task: TeamTaskState, context: DependencyOutputContext): ArtifactDescriptor {
	return writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: `metadata/${task.id}.inputs.json`,
		producer: task.id,
		content: `${JSON.stringify(context, null, 2)}\n`,
	});
}

export function aggregateTaskOutputs(tasks: TeamTaskState[], manifest?: TeamRunManifest): string {
	return tasks.map((task, index) => {
		const body = task.resultArtifact ? readIfSmall(task.resultArtifact.path, 40_000, manifest?.artifactsRoot) : undefined;
		const hasBody = Boolean(body?.trim());
		const expectedMissing = task.resultArtifact && !containedExists(task.resultArtifact.path, manifest?.artifactsRoot);
		const status = task.status === "skipped"
			? "SKIPPED"
			: task.status === "failed"
				? `FAILED${task.exitCode !== undefined ? ` (exit code ${task.exitCode ?? "null"})` : ""}${task.error ? `: ${task.error}` : ""}`
				: expectedMissing
					? `EMPTY OUTPUT (expected result artifact missing: ${task.resultArtifact?.path})`
					: !hasBody
						? "EMPTY OUTPUT (no textual response returned)"
						: task.status.toUpperCase();
		return [
			`=== Task ${index + 1}: ${task.id} (${task.agent}) ===`,
			`Status: ${status}`,
			task.role ? `Role: ${task.role}` : "",
			task.resultArtifact?.path ? `Result artifact: ${task.resultArtifact.path}` : "",
			task.logArtifact?.path ? `Log artifact: ${task.logArtifact.path}` : "",
			task.transcriptArtifact?.path ? `Transcript: ${task.transcriptArtifact.path}` : "",
			task.usage ? `Usage: ${JSON.stringify(task.usage)}` : "",
			"",
			hasBody ? body!.trim() : status,
		].filter(Boolean).join("\n");
	}).join("\n\n");
}
