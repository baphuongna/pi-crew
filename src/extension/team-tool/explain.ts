import * as fs from "node:fs";
import * as path from "node:path";
import { loadRunManifestById } from "../../state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";

/**
 * Local wrapper matching the planned `result` API used by handleExplain.
 */
function result(text: string, details: Record<string, unknown>, isError: boolean): { isError: boolean; text: string } {
  return { isError, text };
}

export interface TaskExplainContext {
  taskId: string;
  role: string;
  status: string;
  phase?: string;
  why: string;
  what: string;
  filesTouched: string[];
  connectedTasks: Array<{ taskId: string; status: string; relation: string }>;
  layer: string;
  complexity: "simple" | "moderate" | "complex";
  usage?: { inputTokens?: number; outputTokens?: number };
  duration?: number;
}

/**
 * Build explain context for a specific task in a run.
 */
export function buildTaskExplainContext(
  manifest: TeamRunManifest,
  tasks: TeamTaskState[],
  taskId: string,
): TaskExplainContext {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in run ${manifest.runId}`);
  }

  const dependsOn = task.dependsOn ?? [];
  const dependents = tasks.filter((t) => (t.dependsOn ?? []).includes(taskId));

  // Layer from phase
  const layerMap: Record<string, string> = {
    explore: "exploration",
    plan: "planning",
    assess: "assessment",
    execute: "execution",
    verify: "verification",
    analyze: "analysis",
    write: "documentation",
    "": "unknown",
  };
  const layer = layerMap[task.adaptive?.phase ?? ""] ?? "unknown";

  // Why it exists
  let why = `Part of ${manifest.team ?? "unknown"} team workflow.`;
  if (dependsOn.length > 0) {
    const depTasks = dependsOn.map((d) => {
      const dep = tasks.find((t) => t.id === d);
      return dep ? `\`${d}\` (${dep.status})` : `\`${d}\``;
    }).join(", ");
    why += ` Depends on ${depTasks}.`;
  }
  if (dependents.length > 0) {
    why += ` ${dependents.length} task(s) depend on this.`;
  }

  // What it did
  let what = `Ran agent: ${task.role}`;
  if (task.model) {
    what += ` (${task.model})`;
  }
  if (task.usage) {
    const inputTokens = task.usage.input ?? 0;
    const outputTokens = task.usage.output ?? 0;
    what += `. Usage: input=${inputTokens}, output=${outputTokens}`;
  }
  if (task.status === "failed") {
    what += `. Status: FAILED`;
    if (task.error) {
      what += ` — ${task.error}`;
    }
  }

  // Files from artifacts
  const artifactsPath = manifest.artifactsRoot;
  const filesTouched: string[] = [];
  if (fs.existsSync(artifactsPath)) {
    try {
      const entries = fs.readdirSync(artifactsPath);
      for (const entry of entries) {
        const fullPath = path.join(artifactsPath, entry);
        try {
          if (fs.statSync(fullPath).isFile()) {
            filesTouched.push(entry);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Duration
  let duration: number | undefined;
  if (task.startedAt && task.finishedAt) {
    duration = (new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime()) / 1000;
  }

  // Complexity
  const complexity = tasks.length <= 3 ? "simple" : tasks.length <= 8 ? "moderate" : "complex";

  return {
    taskId,
    role: task.role,
    status: task.status,
    phase: task.adaptive?.phase,
    why,
    what,
    filesTouched,
    connectedTasks: [
      ...dependsOn.map((d) => {
        const dep = tasks.find((t) => t.id === d);
        return {
          taskId: d,
          status: dep?.status ?? "unknown",
          relation: "depends on",
        };
      }),
      ...dependents.map((d) => ({
        taskId: d.id,
        status: d.status,
        relation: "depended on by",
      })),
    ],
    layer,
    complexity,
    usage: task.usage ? { inputTokens: task.usage.input, outputTokens: task.usage.output } : undefined,
    duration,
  };
}

/**
 * Format task explain context as markdown.
 */
export function formatTaskExplain(ctx: TaskExplainContext): string {
  const lines: string[] = [];

  lines.push(`# Task: ${ctx.taskId} (${ctx.role})`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| **Status** | ${ctx.status} |`);
  if (ctx.phase) lines.push(`| **Phase** | ${ctx.phase} |`);
  lines.push(`| **Layer** | ${ctx.layer} |`);
  lines.push(`| **Complexity** | ${ctx.complexity} |`);

  if (ctx.duration) {
    const minutes = Math.round(ctx.duration / 60);
    lines.push(`| **Duration** | ${minutes} min |`);
  }

  if (ctx.usage) {
    const input = ctx.usage.inputTokens ?? 0;
    const output = ctx.usage.outputTokens ?? 0;
    lines.push(`| **Usage** | ↑${input} ↓${output} tokens |`);
  }

  lines.push("");
  lines.push(`## Why it exists`);
  lines.push("");
  lines.push(ctx.why);
  lines.push("");
  lines.push(`## What it did`);
  lines.push("");
  lines.push(ctx.what);
  lines.push("");

  if (ctx.filesTouched.length > 0) {
    lines.push("## Files produced");
    lines.push("");
    for (const file of ctx.filesTouched) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (ctx.connectedTasks.length > 0) {
    lines.push("## Connected tasks");
    lines.push("");
    for (const conn of ctx.connectedTasks) {
      lines.push(`- ${conn.relation} \`${conn.taskId}\` (${conn.status})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Handle team action='explain'.
 */
export function handleExplain(params: {
  runId?: string;
  taskId?: string;
  cwd?: string;
}, cwd: string): { isError: boolean; text: string } {
  if (!params.runId) {
    return result("explain requires runId", { action: "explain", status: "error" }, true);
  }

  const loaded = loadRunManifestById(cwd, params.runId);
  if (!loaded) {
    return result(`Run '${params.runId}' not found.`, { action: "explain", status: "error" }, true);
  }

  const { manifest, tasks } = loaded;

  if (params.taskId) {
    try {
      const ctx = buildTaskExplainContext(manifest, tasks, params.taskId);
      const output = formatTaskExplain(ctx);
      return result(output, { action: "explain", runId: params.runId }, false);
    } catch (err) {
      return result(`Task '${params.taskId}' not found: ${err instanceof Error ? err.message : String(err)}`, { action: "explain", status: "error" }, true);
    }
  }

  // Explain entire run
  const lines: string[] = [];
  lines.push(`# Run: ${params.runId}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);

  const start = new Date(manifest.createdAt).getTime();
  const end = manifest.updatedAt ? new Date(manifest.updatedAt).getTime() : Date.now();
  const duration = Math.round((end - start) / 1000 / 60);

  lines.push(`| **Team** | ${manifest.team} |`);
  lines.push(`| **Workflow** | ${manifest.workflow ?? "default"} |`);
  lines.push(`| **Status** | ${manifest.status} |`);
  lines.push(`| **Duration** | ${duration} min |`);
  lines.push(`| **Tasks** | ${tasks.length} |`);
  lines.push("");

  lines.push("## Tasks");
  lines.push("");
  lines.push("| Task | Role | Status | Layer |");
  lines.push("|------|------|--------|-------|");

  for (const task of tasks) {
    const layerMap: Record<string, string> = {
      explore: "exploration", plan: "planning", assess: "assessment",
      execute: "execution", verify: "verification", analyze: "analysis", write: "documentation",
    };
    const layer = layerMap[task.adaptive?.phase ?? ""] ?? "unknown";
    const statusIcon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : "⏳";
    lines.push(`| \`${task.id}\` | ${task.role} | ${statusIcon} ${task.status} | ${layer} |`);
  }
  lines.push("");

  lines.push("---");
  lines.push(`*Use \`team action='explain' runId=${params.runId} taskId=<taskId>\` for task detail.*`);

  return result(lines.join("\n"), { action: "explain", runId: params.runId }, false);
}
