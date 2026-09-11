import * as fs from "node:fs";
import { sleepSync } from "../../src/utils/sleep.ts";

/**
 * macOS-CI teardown hardening — shared form of the retry pattern previously
 * duplicated inline in resume-cancel.test.ts (8197f054) and
 * role-tools-integration.test.ts (6a271822).
 *
 * The last artifact writes of a finished worker/test run can race the
 * recursive rmSync: Node's rimrafSync throws ENOTEMPTY (NOT swallowed by
 * force:true) when a file lands between its unlink pass and a directory
 * rmdir. Caught on macOS CI runs 34557602253 (resume-checkpoint) and
 * 34558219451 (wait-request-broker) — different files, same signature:
 * ENOTEMPTY rmdir inside the fixture's `.crew` / `artifacts` / `team_*`
 * subtree under a `pi-crew-*` tmpdir.
 *
 * Retry briefly — the async writer has usually settled by the next attempt.
 * Best-effort by design: a persistent ENOTEMPTY is NOT a test failure —
 * assertions already passed and the OS sweeps /tmp.
 */
export function teardownCwd(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`teardownCwd: unable to remove ${cwd}: ${String(error)}`);
				return;
			}
			sleepSync(200);
		}
	}
}
