import { isTeamRunStatus, isTeamTaskStatus } from "../state/contracts.ts";
import type { TeamEvent } from "../state/event-log.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { ExportedRunBundle } from "./run-export.ts";

export interface BundleValidationResult {
	ok: boolean;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateArtifact(value: unknown, index: number, errors: string[]): value is ArtifactDescriptor {
	if (!isRecord(value)) {
		errors.push(`manifest.artifacts[${index}] must be an object.`);
		return false;
	}
	const before = errors.length;
	if (typeof value.kind !== "string") errors.push(`manifest.artifacts[${index}].kind must be a string.`);
	if (typeof value.path !== "string") errors.push(`manifest.artifacts[${index}].path must be a string.`);
	if (typeof value.createdAt !== "string") errors.push(`manifest.artifacts[${index}].createdAt must be a string.`);
	if (typeof value.producer !== "string") errors.push(`manifest.artifacts[${index}].producer must be a string.`);
	if (value.retention !== "run" && value.retention !== "project" && value.retention !== "temporary")
		errors.push(`manifest.artifacts[${index}].retention is invalid.`);
	return errors.length === before;
}

function validateManifest(value: unknown, errors: string[]): value is TeamRunManifest {
	if (!isRecord(value)) {
		errors.push("manifest must be an object.");
		return false;
	}
	const before = errors.length;
	if (value.schemaVersion !== 1) errors.push("manifest.schemaVersion must be 1.");
	for (const field of [
		"runId",
		"team",
		"goal",
		"createdAt",
		"updatedAt",
		"cwd",
		"stateRoot",
		"artifactsRoot",
		"tasksPath",
		"eventsPath",
	] as const) {
		if (typeof value[field] !== "string") errors.push(`manifest.${field} must be a string.`);
	}
	if (!isTeamRunStatus(value.status)) errors.push("manifest.status is invalid.");
	if (value.workspaceMode !== "single" && value.workspaceMode !== "worktree")
		errors.push("manifest.workspaceMode must be single or worktree.");
	if (!Array.isArray(value.artifacts)) errors.push("manifest.artifacts must be an array.");
	else value.artifacts.forEach((artifact, index) => { validateArtifact(artifact, index, errors); });
	return errors.length === before;
}

function validateTask(value: unknown, index: number, errors: string[]): value is TeamTaskState {
	if (!isRecord(value)) {
		errors.push(`tasks[${index}] must be an object.`);
		return false;
	}
	const before = errors.length;
	for (const field of ["id", "runId", "role", "agent", "title", "cwd"] as const) {
		if (typeof value[field] !== "string") errors.push(`tasks[${index}].${field} must be a string.`);
	}
	if (!isTeamTaskStatus(value.status)) errors.push(`tasks[${index}].status is invalid.`);
	if (!Array.isArray(value.dependsOn)) errors.push(`tasks[${index}].dependsOn must be an array.`);
	return errors.length === before;
}

function validateEvent(value: unknown, index: number, errors: string[]): value is TeamEvent {
	if (!isRecord(value)) {
		errors.push(`events[${index}] must be an object.`);
		return false;
	}
	const before = errors.length;
	for (const field of ["time", "type", "runId"] as const) {
		if (typeof value[field] !== "string") errors.push(`events[${index}].${field} must be a string.`);
	}
	return errors.length === before;
}

export function validateRunBundle(value: unknown): BundleValidationResult {
	const errors: string[] = [];
	if (!isRecord(value)) return { ok: false, errors: ["bundle must be an object."] };
	if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
	if (typeof value.exportedAt !== "string") errors.push("exportedAt must be a string.");
	validateManifest(value.manifest, errors);
	if (!Array.isArray(value.tasks)) errors.push("tasks must be an array.");
	else value.tasks.forEach((task, index) => { validateTask(task, index, errors); });
	if (!Array.isArray(value.events)) errors.push("events must be an array.");
	else value.events.forEach((event, index) => { validateEvent(event, index, errors); });
	if (!Array.isArray(value.artifactPaths) || !value.artifactPaths.every((item) => typeof item === "string"))
		errors.push("artifactPaths must be an array of strings.");
	return { ok: errors.length === 0, errors };
}

export function assertRunBundle(value: unknown): asserts value is ExportedRunBundle {
	const validation = validateRunBundle(value);
	if (!validation.ok)
		throw new Error(`File is not a valid pi-crew exported run bundle:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
}
