import * as fs from "node:fs";
import * as path from "node:path";
import { projectCrewRoot } from "../utils/paths.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import type { TeamRunManifest } from "../state/types.ts";

export interface OnboardingOptions {
  team?: string;
  limit?: number;
  cwd?: string;
}

interface RunSummary {
  runId: string;
  status: string;
  goal: string;
  team: string;
  createdAt: string;
  completedAt?: string;
  taskCount: number;
}

/**
 * Load run summaries from the state directory.
 */
function loadRunSummaries(cwd: string, options: OnboardingOptions = {}): RunSummary[] {
  const crewRoot = projectCrewRoot(cwd);
  const runsRoot = path.join(crewRoot, "state", "runs");

  if (!fs.existsSync(runsRoot)) return [];

  const limit = options.limit ?? 5;
  const teamFilter = options.team;

  const entries = fs.readdirSync(runsRoot)
    .filter((e) => {
      try {
        return fs.statSync(path.join(runsRoot, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, 100);

  const summaries: RunSummary[] = [];

  for (const runId of entries) {
    if (summaries.length >= limit) break;

    const manifestPath = path.join(runsRoot, runId, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as TeamRunManifest & { completedAt?: string };

      if (teamFilter && raw.team !== teamFilter) continue;

      summaries.push({
        runId,
        status: raw.status,
        goal: raw.goal ?? "",
        team: raw.team,
        createdAt: raw.createdAt,
        completedAt: raw.completedAt ?? raw.updatedAt,
        taskCount: (raw as Record<string, unknown>).tasks != null
          ? ((raw as Record<string, unknown>).tasks as unknown[]).length
          : 0,
      });
    } catch {
      continue;
    }
  }

  return summaries;
}

/**
 * Format duration in minutes.
 */
function formatDuration(createdAt: string, completedAt?: string): string {
  const start = new Date(createdAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const minutes = Math.round((end - start) / 1000 / 60);
  if (minutes < 1) return "<1m";
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

/**
 * Build markdown onboarding guide for a team.
 */
export function buildTeamOnboarding(team: string, cwd: string, options: OnboardingOptions = {}): string {
  const runs = loadRunSummaries(cwd, { ...options, team });

  const lines: string[] = [];

  // Header
  lines.push(`# Team: ${team}`);
  lines.push("");
  lines.push(`> Multi-agent ${team} team for pi-crew.`);
  lines.push("");

  // Overview stats
  const completed = runs.filter((r) => r.status === "completed");
  const failed = runs.filter((r) => r.status === "failed" || r.status === "cancelled");

  let avgDuration = 0;
  if (completed.length > 0) {
    const totalMs = completed.reduce((sum, r) => {
      const start = new Date(r.createdAt).getTime();
      const end = r.completedAt ? new Date(r.completedAt).getTime() : Date.now();
      return sum + (end - start);
    }, 0);
    avgDuration = totalMs / completed.length / 1000 / 60;
  }

  lines.push("## Overview");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total runs | ${runs.length} |`);
  lines.push(`| Completed | ${completed.length} |`);
  lines.push(`| Failed/Cancelled | ${failed.length} |`);
  if (avgDuration > 0) {
    lines.push(`| Avg duration | ${avgDuration.toFixed(1)} min |`);
  }
  lines.push("");

  // Past runs table
  if (runs.length > 0) {
    lines.push("## Past Runs");
    lines.push("");
    lines.push("| Run | Goal | Duration | Status |");
    lines.push("|-----|------|----------|--------|");

    for (const run of runs) {
      const duration = formatDuration(run.createdAt, run.completedAt);
      const goalPreview = run.goal ? run.goal.slice(0, 40) : "N/A";
      const statusIcon = run.status === "completed" ? "✅" : run.status === "failed" ? "❌" : "⚠️";
      lines.push(`| \`${run.runId.slice(-8)}\` | ${goalPreview}${run.goal.length > 40 ? "..." : ""} | ${duration} | ${statusIcon} ${run.status} |`);
    }
    lines.push("");
  }

  // How to run
  lines.push("## How to Run");
  lines.push("");
  lines.push("```bash");
  lines.push(`team action='run' team='${team}' goal="<your goal>"`);
  lines.push("```");
  lines.push("");
  lines.push("See `team action='help'` for more options.");
  lines.push("");

  // Teams
  lines.push("## Available Teams");
  lines.push("");
  try {
    const discovery = discoverTeams(cwd);
    const teams = allTeams(discovery);
    for (const t of teams) {
      lines.push(`- \`${t.name}\` — ${t.description ?? "No description"}`);
    }
  } catch {
    lines.push("- *(team discovery unavailable)*");
  }
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("*Generated by pi-crew. For up-to-date info, check recent run history.*");

  return lines.join("\n");
}
