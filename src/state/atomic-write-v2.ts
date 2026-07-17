import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { renameWithLinkAsync, renameWithLinkSync } from "./atomic-write.ts";

/**
 * Fallow-inspired atomic writer: write-to-.tmp → fsync → rename.
 *
 * Status: DEPRECATED / EXPERIMENTAL — NOT USED IN PRODUCTION.
 *
 * `grep -rn "atomic-write-v2" src/` returns 0 importers; production code
 * routes through `src/state/atomic-write.ts` (`atomicWriteFile` /
 * `atomicWriteFileAsync` / `atomicWriteJson*`). Retained for the planned
 * v1→v2 migration (`docs/migration/atomic-write-v2-migration.md`).
 *
 * ST-8 fix: replaced `fs.renameSync(tmpPath, targetPath)` (symlink-following)
 * and `fs.promises.rename(tmpPath, targetPath)` (also symlink-following)
 * with the canonical symlink-safe helpers `renameWithLinkSync` /
 * `renameWithLinkAsync` exported from `atomic-write.ts`. The two
 * implementations now share identical rename semantics:
 * - On POSIX: `unlink(target)` then `link(temp, target)` then `unlink(temp)`
 *   (link does NOT follow symlinks at the destination path, so a symlink
 *   planted mid-write cannot be replaced with attacker content).
 * - On Windows: a single `fs.rename` (MoveFileEx with MOVEFILE_REPLACE_EXISTING).
 *
 * Existing tests in `test/unit/atomic-write-v2.test.ts` continue to pass —
 * they verify atomic-replace + .gitignore + UUID tmp behavior, none of which
 * depend on the rename implementation choice.
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
			try {
				fs.fsyncSync(fd);
			} catch {
				/* best-effort */
			}
		} finally {
			fs.closeSync(fd);
		}
		try {
			// ST-8: use the shared symlink-safe rename helper from atomic-write.ts
			// instead of fs.renameSync (which follows symlinks at the destination).
			renameWithLinkSync(tmpPath, targetPath);
		} catch (err) {
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* best-effort cleanup */
			}
			throw err;
		}
	}

	async writeAsync(targetPath: string, content: string): Promise<void> {
		await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
		const tmpPath = this.tmpPath(targetPath);
		const fd = await fs.promises.open(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			await fd.writeFile(content, "utf8");
			try {
				await fd.sync();
			} catch {
				/* best-effort */
			}
		} finally {
			await fd.close();
		}
		try {
			// ST-8: use the shared symlink-safe async rename helper from
			// atomic-write.ts instead of fs.promises.rename (which follows
			// symlinks at the destination).
			await renameWithLinkAsync(tmpPath, targetPath);
		} catch (err) {
			try {
				await fs.promises.unlink(tmpPath);
			} catch {
				/* best-effort cleanup */
			}
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
		try {
			fs.accessSync(gitignorePath);
		} catch {
			try {
				fs.writeFileSync(gitignorePath, "*\n", "utf8");
			} catch {
				/* best-effort */
			}
		}
	}
}
