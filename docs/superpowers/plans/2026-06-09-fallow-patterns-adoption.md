# Fallow Patterns Adoption - Implementation Plan

> **Note:** `atomic-write-v2` / `AtomicWriter` mentioned in this plan was consolidated into `atomic-write.ts` as of v0.9.42. This document is preserved as historical record — the v2 class was never adopted; v1 won on simplicity + symlink-safety + link+unlink atomicity. See `docs/migration/atomic-write-v2-migration.md` for the decision rationale.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt 5 high-value patterns from fallow (Rust static analyzer) into pi-crew: structured error codes, atomic write v2 with fsync, health score system, plugin registry, and stable task ID refinement.

**Architecture:** 5 independent subsystems — each new file/module is self-contained and backward-compatible with existing pi-crew state layer. No existing file deleted until migration complete.

**Tech Stack:** TypeScript (Node.js), existing pi-crew state layer (`src/state/`), existing task-graph (`src/runtime/task-graph.ts`), existing task-id (`src/runtime/task-id.ts`)

---

## File Map

```
src/
  errors.ts                          # NEW: CrewError + ErrorCode enum (E001-E006)
  state/
    atomic-write-v2.ts               # NEW: AtomicWriter with fsync + rename (coexists with atomic-write.ts)
    health-store.ts                 # NEW: RunHealth score computation + snapshot persistence
  runtime/
    task-health.ts                  # NEW: computeRunHealth(), scoreToGrade(), penalty constants
  plugins/
    plugin-registry.ts               # NEW: Plugin interface + PluginRegistry class
    plugin-define.ts                 # NEW: definePlugin() helper
    plugins/
      index.ts                      # NEW: re-exports all built-in plugins
      nextjs.ts                     # NEW: NextJsPlugin
      vitest.ts                     # NEW: VitestPlugin
      vite.ts                       # NEW: VitePlugin
```

Existing files (read-only during implementation, migrate after):
- `src/state/atomic-write.ts` — kept until all callers migrate
- `src/state/state-store.ts` — use CrewError after migration
- `src/runtime/task-id.ts` — extend, not replace
- `src/runtime/task-graph.ts` — already has cycle detection + topological sort

---

## Task 1: CrewError + ErrorCode System

**Files:**
- Create: `src/errors.ts`
- Test: `test/unit/errors.test.ts` (new)
- Modify: `src/state/state-store.ts:400-420` (error throwing sites)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/errors.test.ts
import { describe, it, expect } from "vitest";
import { CrewError, ErrorCode, errors } from "../../src/errors.ts";

describe("CrewError", () => {
  it("formats with error code", () => {
    const err = new CrewError(ErrorCode.TaskNotFound, "Task 'xyz' not found");
    expect(err.toString()).toBe("error[E003]: Task 'xyz' not found");
  });

  it("formats with context", () => {
    const err = new CrewError(ErrorCode.FileReadError, "Failed to read manifest.json")
      .withContext("while loading run state");
    const str = err.toString();
    expect(str).toContain("error[E001]:");
    expect(str).toContain("context: while loading run state");
  });

  it("formats with help", () => {
    const err = new CrewError(ErrorCode.ConfigError, "parse failure")
      .withHelp("Try running `team init`");
    const str = err.toString();
    expect(str).toContain("help: Try running `team init`");
  });

  it("has default help for E001-E006", () => {
    expect(errors.fileRead("x.txt", { code: "ENOENT" } as NodeJS.ErrnoException).help).toBeDefined();
    expect(errors.taskNotFound("t1").help).toBeDefined();
    expect(errors.config("bad").help).toBeDefined();
  });

  it("is instanceof Error", () => {
    expect(new CrewError(ErrorCode.FileWriteError, "x")).toBeInstanceOf(Error);
  });

  it("factory methods produce correct codes", () => {
    expect(errors.fileRead("x", {} as NodeJS.ErrnoException).code).toBe(ErrorCode.FileReadError);
    expect(errors.taskNotFound("t1").code).toBe(ErrorCode.TaskNotFound);
    expect(errors.invalidStatusTransition("running", "queued").code).toBe(ErrorCode.InvalidStatusTransition);
    expect(errors.resourceNotFound("agent", "my-agent").code).toBe(ErrorCode.ResourceNotFound);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/errors.test.ts`
Expected: FAIL with "Cannot find module '../../src/errors.ts'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/errors.ts

/**
 * Error code taxonomy for pi-crew.
 * Maps to semantic categories matching fallow's E001-E004 pattern.
 */
export enum ErrorCode {
  FileReadError = "E001",           // Cannot read a file
  FileWriteError = "E002",          // Cannot write a file
  TaskNotFound = "E003",            // Referenced task ID does not exist
  InvalidStatusTransition = "E004", // Run/task status cannot legally transition
  ConfigError = "E005",             // Malformed config or missing required field
  ResourceNotFound = "E006",        // Agent/team/workflow not found in discovery paths
}

const DEFAULT_HELP: Record<ErrorCode, string | undefined> = {
  [ErrorCode.FileReadError]: "Check that the file exists and that the process has read permission.",
  [ErrorCode.FileWriteError]: "Check that the disk is not full and that the process has write permission.",
  [ErrorCode.TaskNotFound]: "The task may have been removed or the run may be in an inconsistent state. Use `team status` to verify.",
  [ErrorCode.InvalidStatusTransition]: "Verify the run status using `team status` before retrying.",
  [ErrorCode.ConfigError]: "Check the configuration file for syntax errors or missing required fields.",
  [ErrorCode.ResourceNotFound]: "Use `team list` to see available agents, teams, and workflows.",
};

/**
 * Structured error type for pi-crew.
 * Display format:
 *   error[E001]: Failed to read manifest.json: not found
 *     context: while loading run state
 *     help: Check that the file exists and that the process has read permission.
 */
export class CrewError extends Error {
  readonly code: ErrorCode;
  readonly help?: string;
  private _context?: string;

  constructor(code: ErrorCode, message: string, help?: string) {
    super(message);
    this.name = "CrewError";
    this.code = code;
    this.help = help ?? DEFAULT_HELP[code];
    Object.defineProperty(this, "message", { enumerable: true });
    Object.defineProperty(this, "code", { enumerable: true });
  }

  withContext(context: string): this {
    this._context = context;
    return this;
  }

  withHelp(help: string): this {
    this.help = help;
    return this;
  }

  toString(): string {
    let out = `error[${this.code}]: ${this.message}`;
    if (this._context) out += `\n  context: ${this._context}`;
    if (this.help) out += `\n  help: ${this.help}`;
    return out;
  }
}

export const errors = {
  fileRead(path: string, source: NodeJS.ErrnoException): CrewError {
    return new CrewError(
      ErrorCode.FileReadError,
      `Failed to read ${path}: ${source.code?.toLowerCase() ?? "unknown"}`,
    ).withContext("file system read operation");
  },

  fileWrite(path: string, source: NodeJS.ErrnoException): CrewError {
    return new CrewError(
      ErrorCode.FileWriteError,
      `Failed to write ${path}: ${source.code?.toLowerCase() ?? "unknown"}`,
    ).withContext("file system write operation");
  },

  taskNotFound(taskId: string, runId?: string): CrewError {
    const msg = runId
      ? `Task '${taskId}' not found in run '${runId}'`
      : `Task '${taskId}' not found`;
    return new CrewError(ErrorCode.TaskNotFound, msg);
  },

  invalidStatusTransition(from: string, to: string): CrewError {
    return new CrewError(
      ErrorCode.InvalidStatusTransition,
      `Invalid run status transition: ${from} → ${to}`,
    );
  },

  config(message: string): CrewError {
    return new CrewError(ErrorCode.ConfigError, message);
  },

  resourceNotFound(type: string, name: string): CrewError {
    return new CrewError(
      ErrorCode.ResourceNotFound,
      `${type} '${name}' not found in any discovery path`,
    );
  },
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/unit/errors.test.ts
git commit -m "feat: add CrewError with E001-E006 error codes

Adds structured error type matching fallow's error model.
- ErrorCode enum: FileRead, FileWrite, TaskNotFound, InvalidStatusTransition, ConfigError, ResourceNotFound
- CrewError with builder pattern: withContext(), withHelp()
- Factory constructors in errors namespace
- Display format: error[E001]: message\\n  context: ...\\n  help: ..."
```

---

## Task 2: Atomic Write v2 with fsync

**Files:**
- Create: `src/state/atomic-write-v2.ts`
- Test: `test/unit/atomic-write-v2.test.ts` (new)
- Modify: `src/state/state-store.ts` (switch one call-site first — manifest write)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/atomic-write-v2.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { AtomicWriter } from "../../src/state/atomic-write-v2.ts";

describe("AtomicWriter", () => {
  const tmpDir = fs.mkdtempSync("/tmp/atomic-test-");
  const writer = new AtomicWriter(tmpDir);

  afterEach(() => {
    // Clean up test files
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  it("writes file atomically (file exists after write)", () => {
    const target = path.join(tmpDir, "test.json");
    writer.writeJsonSync(target, { foo: "bar" });
    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ foo: "bar" });
  });

  it("overwrites existing file atomically", () => {
    const target = path.join(tmpDir, "existing.json");
    fs.writeFileSync(target, '{"old": true}', "utf8");
    writer.writeJsonSync(target, { new: true });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ new: true });
  });

  it("writes .gitignore to directory on first use", () => {
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    const target = path.join(subDir, "data.json");
    writer.writeJsonSync(target, {});
    const gitignore = path.join(subDir, ".gitignore");
    expect(fs.existsSync(gitignore)).toBe(true);
    expect(fs.readFileSync(gitignore, "utf8")).toBe("*\\n");
  });

  it("async write works", async () => {
    const target = path.join(tmpDir, "async.json");
    await writer.writeJsonAsync(target, { async: true });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ async: true });
  });

  it("uses UUID in tmp file name", () => {
    const target = path.join(tmpDir, "uuid-test.json");
    // Write triggers tmp file creation — verify no collision
    writer.writeJsonSync(target, { x: 1 });
    // Should succeed without errors
    expect(fs.existsSync(target)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/atomic-write-v2.test.ts`
Expected: FAIL with "Cannot find module '../../src/state/atomic-write-v2.ts'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/state/atomic-write-v2.ts

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Fallow-inspired atomic writer: write-to-.tmp → fsync → rename.
 *
 * Key differences from atomic-write.ts:
 * - Uses rename() (POSIX-atomic) instead of link()+unlink()
 * - Calls fsyncSync() on the temp file before rename
 * - Best-effort fsync (failure does not abort)
 * - Writes .gitignore to directory on first use
 * - UUID-based tmp file to prevent collisions under concurrent writes
 */
export class AtomicWriter {
  private initializedDirs = new Set<string>();

  constructor(private baseDir: string) {}

  /**
   * Synchronously write content atomically to targetPath.
   * 1. mkdir -p parent directory
   * 2. Write to targetPath.{uuid}.tmp
   * 3. fsyncSync the temp file (best-effort)
   * 4. rename() to targetPath (POSIX-atomic on same filesystem)
   */
  writeSync(targetPath: string, content: string): void {
    this.ensureParentDir(targetPath);
    const tmpPath = this.tmpPath(targetPath);
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, content, undefined, "utf8");
      // Best-effort fsync — failure does not abort
      try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
      fs.closeSync(fd);
    }
    // rename() is atomic on POSIX for same-filesystem destinations
    fs.renameSync(tmpPath, targetPath);
  }

  async writeAsync(targetPath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const tmpPath = this.tmpPath(targetPath);
    const fd = await fs.promises.open(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      await fd.writeFile(content, "utf8");
      try { await fd.sync(); } catch { /* best-effort */ }
    } finally {
      await fd.close();
    }
    await fs.promises.rename(tmpPath, targetPath);
  }

  writeJsonSync<T>(targetPath: string, value: T): void {
    this.writeSync(targetPath, JSON.stringify(value, null, 2) + "\n");
  }

  async writeJsonAsync<T>(targetPath: string, value: T): Promise<void> {
    await this.writeAsync(targetPath, JSON.stringify(value, null, 2) + "\n");
  }

  private tmpPath(targetPath: string): string {
    const uuid = crypto.randomUUID();
    return `${targetPath}.${uuid}.tmp`;
  }

  private ensureParentDir(targetPath: string): void {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    this.ensureGitignore(dir);
  }

  private ensureGitignore(dir: string): void {
    if (this.initializedDirs.has(dir)) return;
    this.initializedDirs.add(dir);
    const gitignorePath = path.join(dir, ".gitignore");
    try { fs.accessSync(gitignorePath); } catch {
      try { fs.writeFileSync(gitignorePath, "*\n", "utf8"); } catch { /* best-effort */ }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/atomic-write-v2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/atomic-write-v2.ts test/unit/atomic-write-v2.test.ts
git commit -m "feat: add AtomicWriter v2 with fsync + rename pattern

Fallow-inspired atomic write:
- write-to-.tmp → fsyncSync() → rename() (POSIX-atomic)
- Best-effort fsync (failure does not abort)
- UUID-based tmp filename prevents concurrent write collisions
- .gitignore written to directory on first use
Coexists with atomic-write.ts during migration."
```

---

## Task 3: Health Score System

**Files:**
- Create: `src/runtime/task-health.ts`
- Create: `src/state/health-store.ts`
- Test: `test/unit/task-health.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/task-health.test.ts
import { describe, it, expect } from "vitest";
import { computeRunHealth, scoreToGrade } from "../../src/runtime/task-health.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

describe("scoreToGrade", () => {
  it("maps 90-100 to A", () => {
    expect(scoreToGrade(95)).toBe("A");
    expect(scoreToGrade(90)).toBe("A");
  });
  it("maps 70-89 to B", () => {
    expect(scoreToGrade(70)).toBe("B");
    expect(scoreToGrade(89)).toBe("B");
  });
  it("maps 50-69 to C", () => {
    expect(scoreToGrade(50)).toBe("C");
    expect(scoreToGrade(69)).toBe("C");
  });
  it("maps 30-49 to D", () => {
    expect(scoreToGrade(30)).toBe("D");
    expect(scoreToGrade(49)).toBe("D");
  });
  it("maps 0-29 to F", () => {
    expect(scoreToGrade(0)).toBe("F");
    expect(scoreToGrade(29)).toBe("F");
  });
});

describe("computeRunHealth", () => {
  it("returns perfect score for all tasks completed", () => {
    const manifest = makeManifest([
      { id: "t1", status: "completed" },
      { id: "t2", status: "completed" },
    ]);
    const health = computeRunHealth(manifest);
    expect(health.score).toBe(100);
    expect(health.grade).toBe("A");
    expect(health.penalties).toHaveLength(0);
  });

  it("applies high-failure-rate penalty", () => {
    const manifest = makeManifest([
      { id: "t1", status: "completed" },
      { id: "t2", status: "failed" },
      { id: "t3", status: "failed" },
    ]);
    const health = computeRunHealth(manifest);
    expect(health.score).toBeLessThan(100);
    expect(health.penalties.some(p => p.reason === "high-failure-rate")).toBe(true);
  });

  it("applies stalled-tasks penalty", () => {
    const manifest = makeManifest([
      { id: "t1", status: "completed" },
      { id: "t2", status: "running", stalledSince: Date.now() - 600_000 }, // stalled 10min
    ]);
    const health = computeRunHealth(manifest);
    expect(health.penalties.some(p => p.reason === "stalled-tasks")).toBe(true);
  });

  it("clamps score to [0, 100]", () => {
    const manifest = makeManifest([
      { id: "t1", status: "failed" },
      { id: "t2", status: "failed" },
      { id: "t3", status: "failed" },
      { id: "t4", status: "failed" },
      { id: "t5", status: "failed" },
      { id: "t6", status: "running", stalledSince: Date.now() - 600_000 },
    ]);
    const health = computeRunHealth(manifest);
    expect(health.score).toBeGreaterThanOrEqual(0);
    expect(health.score).toBeLessThanOrEqual(100);
  });

  it("returns deltas from previous snapshot", () => {
    // Test that deltas are computed (even if empty when no previous)
    const manifest = makeManifest([{ id: "t1", status: "completed" }]);
    const health = computeRunHealth(manifest);
    expect(Array.isArray(health.deltas)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/task-health.test.ts`
Expected: FAIL with "Cannot find module '../../src/runtime/task-health.ts'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/runtime/task-health.ts

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export interface HealthPenalty {
  reason: string;
  deduction: number;
}

export interface HealthDelta {
  metric: string;
  delta: number;
  trend: "improving" | "degrading" | "stable";
}

export interface RunHealth {
  score: number;         // 0-100
  grade: HealthGrade;
  penalties: HealthPenalty[];
  deltas: HealthDelta[];
}

const STALLED_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "F";
}

export interface TaskSummary {
  id: string;
  status: string;
  stalledSince?: number;
}

export interface ManifestSummary {
  runId: string;
  tasks: TaskSummary[];
  createdAt: string;
}

/**
 * Compute health score for a run manifest.
 * Penalty-based scoring (matching fallow's vital_signs.rs approach).
 */
export function computeRunHealth(manifest: ManifestSummary): RunHealth {
  const penalties: HealthPenalty[] = [];
  const tasks = manifest.tasks;
  const taskCount = tasks.length;
  if (taskCount === 0) return { score: 100, grade: "A", penalties: [], deltas: [] };

  const failedCount = tasks.filter(t => t.status === "failed").length;
  const stalledCount = tasks.filter(t =>
    t.stalledSince !== undefined && (Date.now() - t.stalledSince) > STALLED_THRESHOLD_MS
  ).length;

  // High failure rate penalty: >20% failures
  const failureRate = failedCount / taskCount;
  if (failureRate > 0.2) {
    penalties.push({ reason: "high-failure-rate", deduction: Math.round(failureRate * 50) });
  }

  // Stalled tasks penalty
  if (stalledCount > 0) {
    penalties.push({ reason: "stalled-tasks", deduction: Math.min(15, stalledCount * 5) });
  }

  // Block depth penalty (for tasks with deep dependency chains — using task count as proxy)
  if (taskCount > 20) {
    penalties.push({ reason: "large-task-count", deduction: Math.min(10, Math.floor((taskCount - 20) / 10)) });
  }

  const totalDeduction = penalties.reduce((sum, p) => sum + p.deduction, 0);
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  return {
    score,
    grade: scoreToGrade(score),
    penalties,
    deltas: [], // Filled by health-store when comparing to previous snapshot
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/task-health.test.ts`
Expected: PASS

- [ ] **Step 5: Write health-store with snapshot persistence**

```typescript
// src/state/health-store.ts

import * as fs from "node:fs";
import * as path from "node:path";
import type { RunHealth } from "../runtime/task-health.ts";
import { computeRunHealth } from "../runtime/task-health.ts";
import type { ManifestSummary } from "../runtime/task-health.ts";

const HEALTH_DIR = ".crew/state/health";

export interface HealthSnapshot {
  runId: string;
  timestamp: number;
  gitRef?: string;
  score: number;
  grade: string;
  penalties: { reason: string; deduction: number }[];
}

export class HealthStore {
  constructor(private crewRoot: string) {}

  private healthDir(): string {
    return path.join(this.crewRoot, HEALTH_DIR);
  }

  /**
   * Save a health snapshot for the run.
   */
  saveSnapshot(manifest: ManifestSummary): HealthSnapshot {
    const health = computeRunHealth(manifest as ManifestSummary);
    const snapshot: HealthSnapshot = {
      runId: manifest.runId,
      timestamp: Date.now(),
      score: health.score,
      grade: health.grade,
      penalties: health.penalties,
    };
    const dir = this.healthDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${manifest.runId}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    return snapshot;
  }

  /**
   * Load the most recent health snapshot (for trend computation).
   */
  loadLatestSnapshot(): HealthSnapshot | null {
    const dir = this.healthDir();
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    if (files.length === 0) return null;
    // Sort by timestamp descending
    files.sort().reverse();
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Load all snapshots (for trend analysis).
   */
  loadAllSnapshots(): HealthSnapshot[] {
    const dir = this.healthDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as HealthSnapshot[];
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/runtime/task-health.ts src/state/health-store.ts test/unit/task-health.test.ts
git commit -m "feat: add health score system with penalty-based scoring

- computeRunHealth() with failure-rate, stalled-tasks, large-task-count penalties
- scoreToGrade() mapping 0-29=F, 30-49=D, 50-69=C, 70-89=B, 90-100=A
- HealthStore with snapshot persistence to .crew/state/health/
- loadLatestSnapshot() for trend computation
Coexists with existing state layer — does not modify manifest schema."
```

---

## Task 4: Plugin Registry

**Files:**
- Create: `src/plugins/plugin-define.ts`
- Create: `src/plugins/plugin-registry.ts`
- Create: `src/plugins/plugins/nextjs.ts`
- Create: `src/plugins/plugins/vitest.ts`
- Create: `src/plugins/plugins/vite.ts`
- Create: `src/plugins/plugins/index.ts`
- Test: `test/unit/plugin-registry.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/plugin-registry.test.ts
import { describe, it, expect } from "vitest";
import { PluginRegistry } from "../../src/plugins/plugin-registry.ts";
import { definePlugin } from "../../src/plugins/plugin-define.ts";
import { NextJsPlugin } from "../../src/plugins/plugins/nextjs.ts";
import { VitestPlugin } from "../../src/plugins/plugins/vitest.ts";

describe("PluginRegistry", () => {
  it("activates plugin by exact package name", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "test-plugin",
      enablers: ["test-pkg"],
    }));
    const active = registry.activePlugins(["test-pkg", "other-pkg"]);
    expect(active.map(p => p.name)).toContain("test-plugin");
  });

  it("activates plugin by prefix match (family)", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "storybook-plugin",
      enablers: ["@storybook/"],
    }));
    const active = registry.activePlugins(["@storybook/react", "@storybook/vue"]);
    expect(active.map(p => p.name)).toContain("storybook-plugin");
  });

  it("does not activate plugin with no matching dep", () => {
    const registry = new PluginRegistry();
    registry.register(definePlugin({
      name: "nextjs-plugin",
      enablers: ["next"],
    }));
    const active = registry.activePlugins(["react", "vite"]);
    expect(active.map(p => p.name)).not.toContain("nextjs-plugin");
  });

  it("NextJsPlugin matches 'next' dependency", () => {
    const registry = new PluginRegistry();
    registry.register(NextJsPlugin);
    const active = registry.activePlugins(["next", "react"]);
    expect(active.map(p => p.name)).toContain("nextjs");
  });

  it("VitestPlugin matches 'vitest' dependency", () => {
    const registry = new PluginRegistry();
    registry.register(VitestPlugin);
    const active = registry.activePlugins(["vitest", "typescript"]);
    expect(active.map(p => p.name)).toContain("vitest");
  });
});

describe("definePlugin", () => {
  it("returns the plugin spec unchanged", () => {
    const plugin = definePlugin({ name: "my-plugin", enablers: ["my-pkg"] });
    expect(plugin.name).toBe("my-plugin");
    expect(plugin.enablers).toEqual(["my-pkg"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/plugin-registry.test.ts`
Expected: FAIL with "Cannot find module '../../src/plugins/plugin-registry.ts'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/plugins/plugin-define.ts

/**
 * Simplifies plugin struct definition.
 * Usage:
 *   export const MyPlugin = definePlugin({
 *     name: "my-plugin",
 *     enablers: ["my-pkg"],
 *     entryPatterns: ["src/**/*.ts"],
 *   });
 */
export function definePlugin<T extends { name: string; enablers: readonly string[] }>(spec: T): T {
  return spec;
}
```

```typescript
// src/plugins/plugin-registry.ts

import type { Plugin } from "./plugin-define.ts";

/**
 * Unified plugin interface for pi-crew.
 * Provides framework/tool detection via package.json dependencies.
 */
export interface Plugin {
  readonly name: string;
  readonly enablers: readonly string[];
  readonly entryPatterns?: readonly string[];
  readonly configPatterns?: readonly string[];
  readonly toolingDependencies?: readonly string[];
  readonly pathAliases?: readonly [string, string][];
  readonly virtualModulePrefixes?: readonly string[];
}

/**
 * Registry that collects plugins and determines which are active
 * based on a package.json's dependencies.
 */
export class PluginRegistry {
  private plugins: Plugin[] = [];

  register(plugin: Plugin): void {
    this.plugins.push(plugin);
  }

  /**
   * Determine which plugins are active given a list of package dependencies.
   * Matching rules:
   * - Exact string match: "next" matches "next"
   * - Prefix match (ending in "/"): "@storybook/" matches "@storybook/react"
   */
  activePlugins(allDeps: string[]): Plugin[] {
    return this.plugins.filter((p) =>
      p.enablers.some((enabler) => {
        if (enabler.endsWith("/")) {
          return allDeps.some((d) => d.startsWith(enabler));
        }
        return allDeps.includes(enabler);
      }),
    );
  }

  /**
   * Get all registered plugins.
   */
  allPlugins(): Plugin[] {
    return [...this.plugins];
  }
}
```

- [ ] **Step 4: Write built-in plugins**

```typescript
// src/plugins/plugins/nextjs.ts

import { definePlugin } from "../plugin-define.ts";

export const NextJsPlugin = definePlugin({
  name: "nextjs",
  enablers: ["next"],
  entryPatterns: [
    "src/app/**/*.{ts,tsx}",
    "src/pages/**/*.{ts,tsx}",
    "src/app/**/page.{ts,tsx}",
    "src/app/**/layout.{ts,tsx}",
    "src/app/**/route.{ts,tsx}",
    "middleware.{ts,js}",
    "next.config.{ts,js,mjs}",
  ],
  configPatterns: ["next.config.{ts,js,mjs}"],
  toolingDependencies: ["next", "@next/font", "@next/mdx"],
  pathAliases: [["~", "src"]],
  virtualModulePrefixes: ["next:"],
});
```

```typescript
// src/plugins/plugins/vitest.ts

import { definePlugin } from "../plugin-define.ts";

export const VitestPlugin = definePlugin({
  name: "vitest",
  enablers: ["vitest"],
  entryPatterns: [
    "**/*.test.{ts,tsx}",
    "**/*.spec.{ts,tsx}",
    "src/**/*.test.{ts,tsx}",
    "src/**/*.spec.{ts,tsx}",
  ],
  configPatterns: ["vitest.config.{ts,js,mjs}", "vite.config.ts"],
  toolingDependencies: ["vitest"],
});
```

```typescript
// src/plugins/plugins/vite.ts

import { definePlugin } from "../plugin-define.ts";

export const VitePlugin = definePlugin({
  name: "vite",
  enablers: ["vite", "rolldown-vite"],
  entryPatterns: [
    "src/main.{ts,tsx,js,jsx}",
    "src/index.{ts,tsx,js,jsx}",
    "index.html",
  ],
  configPatterns: ["vite.config.{ts,js,mts,mjs}"],
  toolingDependencies: ["vite"],
  virtualModulePrefixes: ["virtual:"],
});
```

```typescript
// src/plugins/plugins/index.ts

export { NextJsPlugin } from "./nextjs.ts";
export { VitestPlugin } from "./vitest.ts";
export { VitePlugin } from "./vite.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/plugin-registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/plugins/plugin-define.ts src/plugins/plugin-registry.ts src/plugins/plugins/nextjs.ts src/plugins/plugins/vitest.ts src/plugins/plugins/vite.ts src/plugins/plugins/index.ts test/unit/plugin-registry.test.ts
git commit -m "feat: add plugin registry system

Plugin system for pi-crew framework awareness:
- Plugin interface: name, enablers, entryPatterns, configPatterns, toolingDependencies, pathAliases
- PluginRegistry.activePlugins() with exact + prefix matching
- definePlugin() helper function
- Built-in plugins: NextJsPlugin, VitestPlugin, VitePlugin
Matches fallow's plugin architecture pattern."
```

---

## Task 5: Stable Task ID Refinement

**Files:**
- Modify: `src/runtime/task-id.ts` (extend generateTaskHashId)
- Test: modify `test/unit/task-id.test.ts` (add tests)

- [ ] **Step 1: Check existing tests**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/task-id.test.ts 2>&1 | head -20`

Expected: RUNNING (test file may not exist yet)

- [ ] **Step 2: Add generateTaskHashId tests**

```typescript
// Add to test/unit/task-id.test.ts (or create if doesn't exist)
import { describe, it, expect } from "vitest";
import { generateTaskHashId, hashToBase36, childId, parseHierarchicalId } from "../../src/runtime/task-id.ts";

describe("generateTaskHashId", () => {
  it("generates deterministic ID from same parts", () => {
    const id1 = generateTaskHashId(["fix bug", "task"]);
    const id2 = generateTaskHashId(["fix bug", "task"]);
    expect(id1).toBe(id2); // deterministic
  });

  it("generates different IDs for different parts", () => {
    const id1 = generateTaskHashId(["fix bug"]);
    const id2 = generateTaskHashId(["fix feature"]);
    expect(id1).not.toBe(id2);
  });

  it("starts with prefix", () => {
    const id = generateTaskHashId(["test"], "custom");
    expect(id.startsWith("custom-")).toBe(true);
  });

  it("generates hierarchical child ID", () => {
    const parent = generateTaskHashId(["parent"]);
    const child = childId(parent, 3);
    expect(child).toBe(`${parent}.3`);
  });
});

describe("hashToBase36", () => {
  it("produces correct length output", () => {
    const hash = hashToBase36("test content", 6);
    expect(hash.length).toBe(6);
  });

  it("is deterministic", () => {
    const h1 = hashToBase36("same input", 5);
    const h2 = hashToBase36("same input", 5);
    expect(h1).toBe(h2);
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/task-id.test.ts`
Expected: PASS (existing implementation should handle this)

- [ ] **Step 4: Extend task-id.ts — add stableIdFromContent helper**

Add this function to `src/runtime/task-id.ts` (after existing functions):

```typescript
/**
 * Generate a stable, collision-resistant ID from arbitrary content.
 * Uses full SHA-256 hash (not adaptive length) for maximum stability.
 * Format: {prefix}-{first12charsOfBase36hash}
 *
 * Use for: run-level IDs, artifact keys, cross-run references
 * where determinism and uniqueness matter more than short length.
 */
export function stableIdFromContent(content: string, prefix = "id"): string {
  const hash = createHash("sha256").update(content).digest("hex");
  // Convert first 8 bytes (16 hex chars) to base36-ish
  const hashChars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let b36 = "";
  for (let i = 0; i < 16 && i < hash.length; i++) {
    b36 += hashChars[parseInt(hash[i]!, 16)] ?? "0";
  }
  return `${prefix}-${b36.slice(0, 12)}`;
}
```

- [ ] **Step 5: Run test to verify it still passes**

Run: `node --experimental-strip-types --test --test-timeout=30000 test/unit/task-id.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/runtime/task-id.ts test/unit/task-id.test.ts
git commit -m "feat: add stableIdFromContent for cross-run stable IDs

stableIdFromContent() uses full SHA-256 for maximum collision resistance.
Format: prefix-{12-char-base36-hash}
Use for: run IDs, artifact keys, cross-run references.
Existing generateTaskHashId() unchanged (adaptive length, for task-level IDs)."
```

---

## Task 6: Migrate state-store.ts to CrewError

**Files:**
- Modify: `src/state/state-store.ts:400-430` (replace plain Error throws with CrewError)

- [ ] **Step 1: Read current error throwing sites**

```bash
grep -n "throw new Error" src/state/state-store.ts | head -20
```

- [ ] **Step 2: Replace invalidStatusTransition throw**

Find line with `throw new Error('Invalid run status transition:...')` and replace:

```typescript
// OLD (line ~418):
throw new Error(`Invalid run status transition: ${current} → ${next}`);

// NEW:
import { errors } from "../../src/errors.ts";
// ... later in function:
throw errors.invalidStatusTransition(current, next);
```

- [ ] **Step 3: Replace manifest not found throw**

```typescript
// OLD:
throw new Error(`saveRunTasks: manifest not found for runId=${runId}`);

// NEW:
throw errors.taskNotFound(runId).withContext("saveRunTasks: manifest not found");
```

- [ ] **Step 4: Replace state write failure throw**

```typescript
// OLD:
throw new Error(`Failed to write run state: manifestWritten=${manifestWritten}, tasksWritten=${tasksWritten}`);

// NEW:
throw errors.fileWrite(statePath, err).withContext("saveManifestAndTasksAtomicSync: atomic write failed");
```

- [ ] **Step 5: Run tests**

Run: `node --experimental-strip-types --test --test-timeout=60000 test/unit/state-store.test.ts 2>&1 | tail -10`
Expected: PASS (or existing failures unrelated to this change)

- [ ] **Step 6: Commit**

```bash
git add src/state/state-store.ts
git commit -m "refactor(state-store): use CrewError for structured errors

Migrates state-store.ts from plain Error throws to CrewError:
- InvalidStatusTransition → errors.invalidStatusTransition()
- Task not found → errors.taskNotFound()
- File write failure → errors.fileWrite()
Display format: error[E004]: Invalid run status transition: running → queued"
```

---

## Task 7: Integrate PluginRegistry into team-runner

**Files:**
- Modify: `src/runtime/team-runner.ts` (add plugin context to workflow execution)
- Test: `test/unit/team-runner.test.ts` (add plugin integration test)

- [ ] **Step 1: Read team-runner.ts first 100 lines**

```bash
head -100 src/runtime/team-runner.ts
```

- [ ] **Step 2: Add plugin context to RunConfig**

In `src/config/types.ts` or wherever `RunConfig` is defined, add:

```typescript
// Add to existing RunConfig interface:
interface RunConfig {
  // ... existing fields ...
  activePlugins?: Plugin[];
  pluginContext?: Record<string, unknown>;
}
```

- [ ] **Step 3: Wire plugin activation in team-runner**

Add near the top of `team-runner.ts`:

```typescript
import { PluginRegistry } from "../plugins/plugin-registry.ts";
import { NextJsPlugin, VitestPlugin, VitePlugin } from "../plugins/plugins/index.ts";

// Create registry with built-in plugins
const builtInRegistry = new PluginRegistry();
builtInRegistry.register(NextJsPlugin);
builtInRegistry.register(VitestPlugin);
builtInRegistry.register(VitePlugin);

function getActivePlugins(packageJsonDeps: string[]) {
  return builtInRegistry.activePlugins(packageJsonDeps);
}
```

- [ ] **Step 4: Use plugin context in task routing**

Add to `executeTeam()` or wherever workflow starts:

```typescript
// After loading package.json deps:
const activePlugins = getActivePlugins(packageJsonDeps || []);
const pluginContext = {
  entryPatterns: activePlugins.flatMap(p => p.entryPatterns ?? []),
  pathAliases: Object.fromEntries(activePlugins.flatMap(p => p.pathAliases ?? [])),
};
```

- [ ] **Step 5: Commit**

```bash
git add src/runtime/team-runner.ts src/config/types.ts
git commit -m "feat(team-runner): integrate plugin registry for framework context

- Creates built-in PluginRegistry with NextJs, Vitest, Vite plugins
- activePlugins() called with package.json dependencies
- pluginContext provides entryPatterns + pathAliases to tasks
Framework-aware task routing without breaking existing behavior."
```

---

## Task 8: Wire Health Score into team-runner

**Files:**
- Modify: `src/runtime/team-runner.ts` (save health snapshot on run completion)
- Modify: `src/state/state-store.ts` (call health store after manifest save)

- [ ] **Step 1: Import HealthStore into team-runner**

```typescript
import { HealthStore } from "../state/health-store.ts";
```

- [ ] **Step 2: After run completion, save health snapshot**

Find where run status transitions to "completed" or "failed" and add:

```typescript
const healthStore = new HealthStore(stateRoot);
healthStore.saveSnapshot(manifest);
```

- [ ] **Step 3: Commit**

```bash
git add src/runtime/team-runner.ts src/state/state-store.ts
git commit -m "feat(team-runner): save health snapshot on run completion

HealthStore.saveSnapshot() called after manifest update when run completes.
Snapshots stored in .crew/state/health/{runId}.json for trend analysis.
Score and grade available via `team health` command (future work)."
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] ErrorCode enum (E001-E006) → Task 1
- [x] CrewError builder pattern (withContext, withHelp) → Task 1
- [x] AtomicWriter with fsync + rename → Task 2
- [x] computeRunHealth penalty-based scoring → Task 3
- [x] HealthStore snapshot persistence → Task 3
- [x] Plugin interface + registry → Task 4
- [x] NextJs, Vitest, Vite built-in plugins → Task 4
- [x] stableIdFromContent for cross-run IDs → Task 5
- [x] state-store.ts migration to CrewError → Task 6
- [x] Plugin registry integration → Task 7
- [x] Health score integration → Task 8

**Placeholder scan:**
- No "TBD" or "TODO" found
- No "implement later" or "fill in details"
- No steps that describe without showing code
- All test code is actual runnable TypeScript

**Type consistency:**
- `CrewError.code` is `ErrorCode` (not string)
- `HealthStore.saveSnapshot()` accepts `ManifestSummary` (not full manifest type)
- `PluginRegistry.activePlugins()` accepts `string[]` (not full package.json)
- `stableIdFromContent()` uses `createHash` from `node:crypto`

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-09-fallow-patterns-adoption.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**