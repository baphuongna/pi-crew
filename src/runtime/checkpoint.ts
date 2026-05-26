import * as fs from "node:fs";
import * as path from "node:path";

export interface Checkpoint {
  runId: string;
  taskId: string;
  step: number;
  context: string;
  progress: string;
  savedAt: number;
  agentId: string;
  agentModel?: string;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): void;
  load(runId: string, taskId: string): Checkpoint | null;
  delete(runId: string, taskId: string): void;
  list(runId: string): Checkpoint[];
  hasCheckpoint(runId: string, taskId: string): boolean;
}

interface CheckpointEntry {
  checkpoints: Record<string, Checkpoint>;
}

/**
 * File-based checkpoint store.
 * Saves checkpoints as JSON files in .crew/state/runs/<runId>/checkpoints/
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly stateRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
  }

  private checkpointDir(): string {
    return path.join(this.stateRoot, "checkpoints");
  }

  private checkpointPath(taskId: string): string {
    return path.join(this.checkpointDir(), `${taskId}.json`);
  }

  private ensureDir(): void {
    const dir = this.checkpointDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  save(checkpoint: Checkpoint): void {
    this.ensureDir();
    const p = this.checkpointPath(checkpoint.taskId);
    fs.writeFileSync(p, JSON.stringify(checkpoint, null, 2), "utf-8");
  }

  load(runId: string, taskId: string): Checkpoint | null {
    const p = this.checkpointPath(taskId);
    if (!fs.existsSync(p)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Checkpoint;
      // Verify it's for the correct run
      if (data.runId !== runId) return null;
      return data;
    } catch {
      return null;
    }
  }

  delete(runId: string, taskId: string): void {
    const p = this.checkpointPath(taskId);
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Checkpoint;
        if (data.runId === runId) {
          fs.unlinkSync(p);
        }
      } catch {
        // File existed but couldn't read — delete it anyway
        try {
          fs.unlinkSync(p);
        } catch { /* ignore */ }
      }
    }
  }

  list(runId: string): Checkpoint[] {
    const dir = this.checkpointDir();
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Checkpoint;
        } catch {
          return null;
        }
      })
      .filter((c): c is Checkpoint => c !== null && c.runId === runId);
  }

  hasCheckpoint(runId: string, taskId: string): boolean {
    return this.load(runId, taskId) !== null;
  }
}

const _stores = new Map<string, FileCheckpointStore>();

/**
 * Get checkpoint store for a run's state root.
 */
export function getCheckpointStore(stateRoot: string): CheckpointStore {
  if (!_stores.has(stateRoot)) {
    _stores.set(stateRoot, new FileCheckpointStore(stateRoot));
  }
  return _stores.get(stateRoot)!;
}

/**
 * Clear all checkpoint stores (for testing).
 */
export function clearCheckpointStores(): void {
  _stores.clear();
}

/**
 * Save a checkpoint during agent execution.
 */
export function saveCheckpoint(
  runId: string,
  taskId: string,
  step: number,
  context: string,
  progress: string,
  agentId: string,
  agentModel?: string,
): void {
  const checkpoint: Checkpoint = {
    runId,
    taskId,
    step,
    context,
    progress,
    savedAt: Date.now(),
    agentId,
    agentModel,
  };

  // State root is parent of checkpoints dir
  const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
  const store = getCheckpointStore(stateRoot);
  store.save(checkpoint);
}

/**
 * Load a checkpoint for resuming.
 */
export function loadCheckpoint(runId: string, taskId: string): Checkpoint | null {
  const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
  const store = getCheckpointStore(stateRoot);
  return store.load(runId, taskId);
}

/**
 * Delete a checkpoint after successful completion.
 */
export function clearCheckpoint(runId: string, taskId: string): void {
  const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
  const store = getCheckpointStore(stateRoot);
  store.delete(runId, taskId);
}

/**
 * Check if a checkpoint exists for a task.
 */
export function hasCheckpoint(runId: string, taskId: string): boolean {
  const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
  const store = getCheckpointStore(stateRoot);
  return store.hasCheckpoint(runId, taskId);
}

/**
 * List all checkpoints for a run.
 */
export function listCheckpoints(runId: string): Checkpoint[] {
  const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
  const store = getCheckpointStore(stateRoot);
  return store.list(runId);
}

/**
 * Format a checkpoint for display.
 */
export function formatCheckpoint(checkpoint: Checkpoint): string {
  return [
    `## Checkpoint: ${checkpoint.taskId}`,
    "",
    `**Agent:** ${checkpoint.agentId}`,
    checkpoint.agentModel ? `**Model:** ${checkpoint.agentModel}` : "",
    "",
    `**Progress:** ${checkpoint.progress}`,
    "",
    `**Step:** ${checkpoint.step}`,
    `**Saved:** ${new Date(checkpoint.savedAt).toISOString()}`,
    "",
    `**Context:** ${checkpoint.context.slice(0, 300)}${checkpoint.context.length > 300 ? "..." : ""}`,
  ].filter(Boolean).join("\n");
}

/**
 * Format all checkpoints for a run.
 */
export function formatAllCheckpoints(runId: string): string {
  const checkpoints = listCheckpoints(runId);
  if (checkpoints.length === 0) {
    return `No checkpoints found for run ${runId}`;
  }

  return [
    `# Checkpoints: ${runId}`,
    "",
    ...checkpoints.map((cp, i) =>
      `${i + 1}. **${cp.taskId}** — ${cp.progress} (${new Date(cp.savedAt).toLocaleString()})`,
    ),
    "",
    `Use \`team action='resume' runId=${runId} taskId=<taskId>\` to resume.`,
  ].join("\n");
}
