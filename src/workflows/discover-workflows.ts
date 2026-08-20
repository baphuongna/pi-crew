import * as fs from "node:fs";
import * as path from "node:path";
import type { ResourceSource } from "../agents/agent-config.ts";
import { parseCsv, parseFrontmatter } from "../utils/frontmatter.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { packageRoot, projectCrewRoot, userPiRoot } from "../utils/paths.ts";
import type { WorkflowConfig, WorkflowStep } from "./workflow-config.ts";

export interface WorkflowDiscoveryResult {
	builtin: WorkflowConfig[];
	user: WorkflowConfig[];
	project: WorkflowConfig[];
}

const STEP_CONFIG_KEYS = new Set([
	"role",
	"dependsOn",
	"parallelGroup",
	"output",
	"reads",
	"model",
	"skills",
	"progress",
	"worktree",
	"verify",
	"task",
	"seedPaths",
	"specRefs",
	"specStrict",
	"preStepScript",
	"preStepArgs",
	"preStepTimeout",
	"preStepOptional",
]);

function parseStepSection(id: string, body: string): WorkflowStep | undefined {
	const lines = body.trim().split("\n");
	const config: Record<string, string> = {};
	const taskLines: string[] = [];
	let inTask = false;
	let sawConfig = false;
	for (const line of lines) {
		if (!inTask) {
			if (line.trim() === "") {
				if (!sawConfig) continue;
				inTask = true;
				continue;
			}
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			if (match) {
				config[match[1]!.trim()] = match[2]!.trim();
				sawConfig = true;
				continue;
			}
			inTask = true;
		}
		taskLines.push(line);
	}
	const role = config.role || id;
	return {
		id,
		role,
		task: taskLines.join("\n").trim() || config.task || "{goal}",
		dependsOn: parseCsv(config.dependsOn),
		parallelGroup: config.parallelGroup || undefined,
		output: config.output === "false" ? false : config.output || undefined,
		reads: config.reads === "false" ? false : parseCsv(config.reads),
		model: config.model || undefined,
		skills: config.skills === "false" ? false : parseCsv(config.skills),
		progress: config.progress === "true" ? true : config.progress === "false" ? false : undefined,
		worktree: config.worktree === "true" ? true : config.worktree === "false" ? false : undefined,
		verify: config.verify === "true" ? true : config.verify === "false" ? false : undefined,
		seedPaths: parseCsv(config.seedPaths) || undefined,
		specRefs: parseCsv(config.specRefs) || undefined,
		// Tri-state (round-1 P1-2): ABSENT = undefined so the workflow-level flag
		// survives the `step.specStrict ?? workflow.specStrict` dispatch merge; an
		// explicit `false` stays false (per-step opt-out of a strict workflow).
		specStrict: config.specStrict === undefined ? undefined : config.specStrict === "true" || config.specStrict === "1",
		preStepScript: config.preStepScript || undefined,
		preStepArgs: parseCsv(config.preStepArgs) || undefined,
		preStepTimeout: parseOptionalInteger(config.preStepTimeout) ?? undefined,
		preStepOptional: config.preStepOptional === "true" || config.preStepOptional === "1",
	};
}

const parseOptionalInteger = (value: string | undefined): number | undefined => {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const n = Number.parseInt(trimmed, 10);
	return Number.isNaN(n) ? undefined : n;
};

const parseOptionalBoolean = (value: string | undefined): boolean | undefined => {
	const trimmed = value?.trim().toLowerCase();
	if (!trimmed) return undefined;
	if (trimmed === "true" || trimmed === "yes" || trimmed === "1") return true;
	if (trimmed === "false" || trimmed === "no" || trimmed === "0") return false;
	return undefined;
};

/** Parse frontmatter `topology:` field. Validates against allowed enum; bad values are silently
 *  dropped (fall through to auto-classification in topology-analyzer). */
const parseTopology = (value: string | undefined): WorkflowConfig["topology"] => {
	if (!value) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "single" || v === "sequential" || v === "concurrent" || v === "complex-dag" || v === "dynamic") {
		return v;
	}
	return undefined;
};

function hasSectionBoundary(body: string, match: RegExpMatchArray): boolean {
	const index = match.index ?? 0;
	if (index === 0 || body.slice(0, index).trim() === "") return true;
	const prev = body.slice(Math.max(0, index - 2), index);
	// Accept blank line or single newline before heading.
	return prev === "\n\n" || prev.endsWith("\n");
}

function isStepHeading(body: string, match: RegExpMatchArray): boolean {
	const sectionStart = match.index! + match[0].length + (body[match.index! + match[0].length] === "\n" ? 1 : 0);
	const nextHeading = body.slice(sectionStart).search(/^##\s+.+[^\S\n]*$/m);
	const section = body.slice(sectionStart, nextHeading >= 0 ? sectionStart + nextHeading : body.length);
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const config = trimmed.match(/^([\w-]+):\s*(.*)$/);
		if (config && STEP_CONFIG_KEYS.has(config[1]!)) return true;
		return false;
	}
	return false;
}

function parseWorkflowFile(filePath: string, source: ResourceSource): WorkflowConfig | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter(content);
		const name = frontmatter.name?.trim() || path.basename(filePath, ".workflow.md");
		const matches = [...body.matchAll(/^##\s+(.+)[^\S\n]*$/gm)];
		const explicitStepIndexes = new Set(
			matches
				.map((match, index) => (isStepHeading(body, match) ? index : undefined))
				.filter((index): index is number => index !== undefined),
		);
		const effectiveMatches = matches.filter(
			(match, index) =>
				explicitStepIndexes.has(index) || (hasSectionBoundary(body, match) && /^[a-z][a-z0-9-]*$/.test(match[1]?.trim() ?? "")),
		);
		const parseMatches = explicitStepIndexes.size ? effectiveMatches : matches;
		const steps: WorkflowStep[] = [];
		for (let i = 0; i < parseMatches.length; i++) {
			const match = parseMatches[i]!;
			const id = match[1]!.trim();
			const sectionStart = match.index! + match[0].length + (body[match.index! + match[0].length] === "\n" ? 1 : 0);
			const sectionEnd = i + 1 < parseMatches.length ? parseMatches[i + 1]!.index! : body.length;
			const step = parseStepSection(id, body.slice(sectionStart, sectionEnd));
			if (step) {
				// F-02 SECURITY: stamp provenance on each step so task-runner.ts can
				// gate preStepScript execution for project-sourced workflows.
				step.source = source;
				// F-02 SECURITY: strip preStepScript from project-sourced workflows at
				// the discover layer. Defense-in-depth: task-runner.ts also guards at
				// runtime, but stripping here prevents the script value from even reaching
				// downstream consumers (coalesce-tasks, policy-engine, etc.).
				if (source === "project" && step.preStepScript) {
					// F-02 redaction: NEVER log the preStepScript body — project workflows
					// are untrusted input and the script may contain secrets. Log name,
					// step id, and script length only.
					logInternalError(
						"discover-workflows",
						new Error(
							`Stripping preStepScript from project workflow '${name}' step '${step.id}' — script body redacted (${step.preStepScript.length} chars) (F-02: project-sourced pre-step scripts are not allowed for RCE prevention)`,
						),
						undefined,
						"warn",
					);
					step.preStepScript = undefined;
					step.preStepArgs = undefined;
					step.preStepTimeout = undefined;
					step.preStepOptional = undefined;
				}
				steps.push(step);
			}
		}
		return {
			name,
			description: frontmatter.description?.trim() || "No description provided.",
			source,
			filePath,
			maxConcurrency: parseOptionalInteger(frontmatter.maxConcurrency),
			topology: parseTopology(frontmatter.topology),
			coalesceMicroTasks: parseOptionalBoolean(frontmatter.coalesceMicroTasks),
			specStrict: parseOptionalBoolean(frontmatter.specStrict),
			steps,
		};
	} catch {
		return undefined;
	}
}

function readWorkflowDir(dir: string, source: ResourceSource): WorkflowConfig[] {
	if (!fs.existsSync(dir)) return [];
	const staticWorkflows = fs
		.readdirSync(dir)
		.filter((entry) => entry.endsWith(".workflow.md"))
		.map((entry) => parseWorkflowFile(path.join(dir, entry), source))
		.filter((workflow): workflow is WorkflowConfig => workflow !== undefined)
		.sort((a, b) => a.name.localeCompare(b.name));
	// P2: also discover dynamic workflows (*.dwf.ts). A .dwf.ts's default export is a JS orchestrator.
	const dynamicWorkflows = fs
		.readdirSync(dir)
		.filter((entry) => entry.endsWith(".dwf.ts"))
		.map((entry) => parseDynamicWorkflowFile(path.join(dir, entry), source))
		.filter((workflow): workflow is WorkflowConfig => workflow !== undefined);
	return [...staticWorkflows, ...dynamicWorkflows].sort((a, b) => a.name.localeCompare(b.name));
}

/** P2: a .dwf.ts is a dynamic workflow. Name = filename stem; script = the file itself. */
function parseDynamicWorkflowFile(filePath: string, source: ResourceSource): WorkflowConfig | undefined {
	try {
		const basename = path.basename(filePath, ".dwf.ts");
		return {
			name: basename,
			description: `Dynamic workflow script (${basename}.dwf.ts).`,
			source,
			filePath,
			steps: [],
			runtime: "dynamic",
			dynamicScript: filePath,
		};
	} catch {
		return undefined;
	}
}

// ─── Workflow Discovery Cache (F17) ──────────────────────────────────────
// Mirrors the Agent Discovery Cache pattern (see discover-agents.ts:493-556).
// `discoverWorkflows(cwd)` is called on the powerbar hot path (≤200 ms coalesce =
// up to ~5 Hz when a run is active + emitting events). Without caching, each call
// walks 3 roots, each requiring readdirSync × 2 + readFileSync + regex-parse per
// `.workflow.md`. We use TTL + dir-stamp invalidation so the cache survives
// steady-state rendering yet still picks up file changes within a few seconds.
//
// SECURITY: ResourceIdentity preserved — same precedence + same parsers as before.
// Reviewers: there is no path-component concern; this only memoises a pure function
// of the filesystem state into a process-local Map.
const WORKFLOW_DISCOVERY_TTL_MS = 5000;
const WORKFLOW_DISCOVERY_MAX_ENTRIES = 32;
interface CachedWorkflowEntry {
	result: WorkflowDiscoveryResult;
	expiresAt: number;
	/** mtime tuple of the 3 workflow source dirs; change ⇒ invalidate early. */
	dirStamp: string;
}
const workflowCache = new Map<string, CachedWorkflowEntry>();

/** Compact mtime signature for the 3 workflow source dirs. Cheap (3 statSync). */
function workflowDirStamp(cwd: string): string {
	const dirs = [
		path.join(packageRoot(), "workflows"),
		path.join(userPiRoot(), "workflows"),
		path.join(projectCrewRoot(cwd), "workflows"),
	];
	let out = "";
	for (const d of dirs) {
		try {
			const st = fs.statSync(d);
			out += `${st.mtimeMs}|`;
		} catch {
			out += "0|";
		}
	}
	return out;
}

/** Drop one or all cached entries. Called from management actions and tests. */
export function invalidateWorkflowDiscoveryCache(cwd?: string): void {
	if (cwd) {
		workflowCache.delete(cwd);
	} else {
		workflowCache.clear();
	}
}

export function discoverWorkflows(cwd: string): WorkflowDiscoveryResult {
	if (!cwd || typeof cwd !== "string") {
		return { builtin: [], user: [], project: [] };
	}
	// F17: serve from cache when both TTL is fresh AND dir-stamp is unchanged.
	// `dirStamp` is a 3-stat pulse we run on every cached call — it is much
	// cheaper than the disk scan it protects against (3 statSync vs 2 readdirSync
	// + N readFileSync + regex parse per `.workflow.md`).
	const now = Date.now();
	const stamp = workflowDirStamp(cwd);
	const cached = workflowCache.get(cwd);
	if (cached && cached.expiresAt > now && cached.dirStamp === stamp) {
		return cached.result;
	}
	const result: WorkflowDiscoveryResult = {
		builtin: readWorkflowDir(path.join(packageRoot(), "workflows"), "builtin"),
		user: readWorkflowDir(path.join(userPiRoot(), "workflows"), "user"),
		project: readWorkflowDir(path.join(projectCrewRoot(cwd), "workflows"), "project"),
	};
	workflowCache.set(cwd, {
		result,
		expiresAt: now + WORKFLOW_DISCOVERY_TTL_MS,
		dirStamp: stamp,
	});
	// Bounded LRU-ish eviction by insertion order (Map iteration order).
	while (workflowCache.size > WORKFLOW_DISCOVERY_MAX_ENTRIES) {
		const oldest = workflowCache.keys().next().value;
		if (oldest === undefined) break;
		workflowCache.delete(oldest);
	}
	return result;
}

export function allWorkflows(discovery: WorkflowDiscoveryResult | undefined): WorkflowConfig[] {
	if (!discovery) return [];
	const byName = new Map<string, WorkflowConfig>();
	for (const workflow of [...discovery.project, ...discovery.builtin, ...discovery.user]) {
		byName.set(workflow.name, workflow);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
