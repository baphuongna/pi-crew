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
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  writeSync(targetPath: string, content: string): void {
    this.ensureParentDir(targetPath);
    const tmpPath = this.tmpPath(targetPath);
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, content, undefined, "utf8");
      try { fs.fsyncSync(fd); } catch { /* best-effort */ }
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
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
    try {
      await fs.promises.rename(tmpPath, targetPath);
    } catch (err) {
      try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
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