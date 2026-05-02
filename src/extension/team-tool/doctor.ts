import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { loadConfig } from "../../config/config.ts";
import { projectCrewRoot, userCrewRoot } from "../../utils/paths.ts";
import { DEFAULT_PATHS } from "../../config/defaults.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { getPiSpawnCommand } from "../../runtime/pi-spawn.ts";
import { validateResources } from "../validate-resources.ts";
import { TeamToolParams } from "../../schema/team-tool-schema.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { configRecord, result, type TeamContext } from "./context.ts";

interface DoctorCheck {
	label: string;
	ok: boolean;
	detail: string;
}

function firstOutputLine(stdout: string | null | undefined, stderr: string | null | undefined): string {
	const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
	return output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "available";
}

function commandExists(command: string, args: string[]): { ok: boolean; detail: string } {
	try {
		const output = spawnSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		if (output.error) {
			return { ok: false, detail: output.error.message };
		}
		if (output.status !== 0) {
			return { ok: false, detail: firstOutputLine(output.stdout, output.stderr) || `status ${output.status}` };
		}
		return { ok: true, detail: firstOutputLine(output.stdout, output.stderr) };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function piCommandExists(): { ok: boolean; detail: string } {
	const spec = getPiSpawnCommand(["--version"]);
	const output = commandExists(spec.command, spec.args);
	if (!output.ok) return output;
	const executable = spec.command === "pi" ? "pi" : `${spec.command} ${spec.args[0] ?? ""}`.trim();
	return { ok: true, detail: `${output.detail} (${executable})` };
}

function checkWritableDir(dir: string): { ok: boolean; detail: string } {
	try {
		if (!fs.existsSync(dir)) return { ok: false, detail: `${dir}: missing` };
		if (!fs.statSync(dir).isDirectory()) return { ok: false, detail: `${dir}: not a directory` };
		// fs.accessSync(W_OK) is unreliable on Windows; verify by writing a temp file.
		const probePath = `${dir}/.pi-crew-write-test`;
		try {
			fs.writeFileSync(probePath, "ok", "utf-8");
			fs.rmSync(probePath, { force: true });
		} catch {
			return { ok: false, detail: `${dir}: not writable (write test failed)` };
		}
		return { ok: true, detail: dir };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `${dir}: ${message}` };
	}
}

function auditJsonSchema(schema: unknown): string[] {
	const issues: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object" || Array.isArray(node)) return;
		const record = node as Record<string, unknown>;
		if (Array.isArray(record.type)) issues.push("schema node uses array-valued type");
		if (record.description && !record.type && !record.anyOf && !record.oneOf && !record.allOf && !record.properties) issues.push(`description-only schema node: ${record.description}`);
		if (record.type === "array" && !record.items) issues.push("array schema missing items");
		if (record.type && (record.anyOf || record.oneOf)) issues.push("schema node combines type with union keyword");
		for (const value of Object.values(record)) {
			if (Array.isArray(value)) for (const item of value) walk(item);
			else walk(value);
		}
	};
	walk(schema);
	return issues;
}

function makeLine(check: DoctorCheck): string {
	return `- ${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.detail}`;
}

function section(title: string, checks: () => DoctorCheck[]): string[] {
	try {
		return [title, ...checks().map(makeLine)];
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return [title, `- FAIL ${title}: ${detail}`];
	}
}

export interface TeamDoctorReportInput {
	cwd: string;
	configPath: string;
	configErrors: string[];
	configWarnings: string[];
	model?: { provider: string; id: string };
	validationErrors: number;
	validationWarnings: number;
	smokeChildPi?: { ok: boolean; detail: string };
}

export interface TeamDoctorReport {
	text: string;
	hasErrors: boolean;
}

export function buildTeamDoctorReport(input: TeamDoctorReportInput): TeamDoctorReport {
	const sections = [
		section("Runtime", () => {
			const git = commandExists("git", ["--version"]);
			const pi = piCommandExists();
			return [
				{ label: "cwd", ok: true, detail: input.cwd },
				{ label: "platform", ok: true, detail: `${process.platform}/${process.arch} node=${process.version}` },
				{ label: "pi command", ok: pi.ok, detail: pi.detail },
				{ label: "git command", ok: git.ok, detail: git.detail },
				{ label: "config", ok: input.configErrors.length === 0, detail: `${input.configPath} (${input.configErrors.length} errors)` },
				{ label: "model", ok: true, detail: input.model ? `${input.model.provider}/${input.model.id}` : "not available in this context" },
				{ label: "config warnings", ok: true, detail: `${input.configWarnings.length} warnings` },
			];
		}),
		section("Filesystem", () => {
			const userWritable = checkWritableDir(userCrewRoot());
			const projectWritable = checkWritableDir(projectCrewRoot(input.cwd));
			return [
				{ label: "user state", ok: userWritable.ok || userWritable.detail.endsWith(": missing"), detail: userWritable.detail },
				{ label: "project state", ok: projectWritable.ok || projectWritable.detail.endsWith(": missing"), detail: projectWritable.detail },
				{ label: "project state root", ok: true, detail: path.join(projectCrewRoot(input.cwd), DEFAULT_PATHS.state.runsSubdir) },
				{ label: "artifacts root", ok: true, detail: path.join(projectCrewRoot(input.cwd), DEFAULT_PATHS.state.artifactsSubdir) },
			];
		}),
		section("Discovery", () => {
			const discoveredAgents = allAgents(discoverAgents(input.cwd));
			const discoveredTeams = allTeams(discoverTeams(input.cwd));
			const discoveredWorkflows = allWorkflows(discoverWorkflows(input.cwd));
			const agentModelHints = discoveredAgents.filter((agent) => agent.model || agent.fallbackModels?.length).length;
			return [
				{ label: "agents", ok: true, detail: `${discoveredAgents.length} discovered` },
				{ label: "teams", ok: true, detail: `${discoveredTeams.length} discovered` },
				{ label: "workflows", ok: true, detail: `${discoveredWorkflows.length} discovered` },
				{ label: "resource model hints", ok: true, detail: `${agentModelHints} agents declare model/fallback preferences` },
			];
		}),
		section("Resource validation", () => [{
			label: "resource validation",
			ok: input.validationErrors === 0,
			detail: `${input.validationErrors} errors, ${input.validationWarnings} warnings`,
		}]),
		section("Schema", () => {
			const schemaIssues = auditJsonSchema(TeamToolParams);
			return [{ label: "strict-provider schema", ok: schemaIssues.length === 0, detail: schemaIssues.length ? schemaIssues.slice(0, 3).join("; ") : "team tool schema compatible" }];
		}),
		section("Async/result delivery", () => [
			{ label: "result watcher", ok: true, detail: "fs.watch with polling fallback for EMFILE/ENOSPC/EPERM" },
			{ label: "async notifier", ok: true, detail: "session-stale guarded completion notifications enabled" },
		]),
		section("Worktrees", () => [
			{ label: "leader repository", ok: true, detail: input.cwd },
			{ label: "cleanup policy", ok: true, detail: "dirty worktrees preserved unless force is set" },
		]),
	];
	if (input.smokeChildPi) {
		sections.push([`Child check`, `- ${input.smokeChildPi.ok ? "OK" : "FAIL"} child Pi smoke: ${input.smokeChildPi.detail}`]);
	}
	const lines = ["pi-crew doctor report"];
	for (const block of sections) {
		if (block.length > 0) {
			lines.push(...block);
			lines.push("");
		}
	}
	if (lines.at(-1) === "") lines.pop();
	const text = lines.join("\n");
	return { text, hasErrors: sections.some((sectionLines) => sectionLines.some((line) => line.includes("FAIL"))) };
}

export function handleDoctor(ctx: TeamContext, params: TeamToolParamsValue = {}): PiTeamsToolResult {
	const loadedConfig = loadConfig(ctx.cwd);
	let smokeChildPi: { ok: boolean; detail: string } | undefined;
	if (configRecord(params.config).smokeChildPi === true) {
		try {
			const spec = getPiSpawnCommand(["--mode", "json", "-p", "Reply with exactly PI-TEAMS-SMOKE-OK"]);
			const output = execFileSync(spec.command, spec.args, {
				cwd: ctx.cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 15_000,
			}).trim();
			smokeChildPi = { ok: output.includes("PI-TEAMS-SMOKE-OK"), detail: output.split("\n").slice(-1)[0] ?? "completed" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			smokeChildPi = { ok: false, detail: message };
		}
	}
	const validation = validateResources(ctx.cwd);
	const { text, hasErrors } = buildTeamDoctorReport({
		cwd: ctx.cwd,
		configPath: loadedConfig.path,
		configErrors: loadedConfig.error ? [loadedConfig.error] : [],
		configWarnings: loadedConfig.warnings ?? [],
		model: ctx.model,
		validationErrors: validation.issues.filter((issue) => issue.level === "error").length,
		validationWarnings: validation.issues.filter((issue) => issue.level === "warning").length,
		smokeChildPi,
	});
	return result(text, { action: "doctor", status: hasErrors ? "error" : "ok" }, hasErrors);
}
