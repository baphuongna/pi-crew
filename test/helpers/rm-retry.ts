/**
 * Shared test teardown helper — recursive delete with bounded retry.
 *
 * Class fix for CI teardown flakes (evidence):
 *  - 36091885921 (mac): adaptive-implementation ENOTEMPTY — a coalesced-write
 *    timer / in-flight artifact write recreates entries during rimraf.
 *  - 36096969768 (win): worktree-async EBUSY — Windows keeps child/process
 *    handles briefly locked after exit; bare rmSync aborts the test.
 *  - event-log-leak / subagent-tools-integration already carry local variants
 *    of this pattern; this module is the shared home (no busy-wait spin).
 *
 * Contract: settle briefly (let in-flight writers land), then up to
 * `attempts` rmSync tries with async backoff on EBUSY/EPERM/ENOTEMPTY.
 * Any other error code (and the final attempt) throws — never masks real
 * failures.
 */
import * as fs from "node:fs";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

export async function removeDirWithRetry(dir: string, opts: { settleMs?: number; attempts?: number } = {}): Promise<void> {
	const settleMs = opts.settleMs ?? 250;
	const attempts = opts.attempts ?? 8;
	await new Promise((resolve) => setTimeout(resolve, settleMs));
	for (let attempt = 0; ; attempt += 1) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= attempts - 1 || !RETRYABLE.has(code ?? "")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
	}
}
