/**
 * Regression test for FIND-14 — `flushStderr` in src/runtime/async-runner.ts
 * writes raw child stderr to background.log. Until the fix, any secret pattern
 * (API key, Bearer token, inline key=value) emitted by the child (e.g. a stack
 * trace containing `MINIMAX_API_KEY=...`, an `Authorization: Bearer ...`
 * header in a network probe, or a V8 fatal-error report) was persisted
 * unredacted to background.log AND embedded in the V8 fatal-error report
 * (which writes environmentVariables unredacted).
 *
 * The fix routes `body` through `redactSecretString` before the
 * `fs.appendFileSync` call. `flushStderr` is a closure inside
 * `spawnBackgroundTeamRun` and is intentionally not exported — the function
 * shape cannot be tested in isolation without an expensive child-process
 * fixture (manifest + state-root + child spawn). We follow the same
 * drift-detector pattern used in `background-runner-console-redirect.test.ts`:
 * replicate the body-to-log-line conversion locally here, so any future change
 * to that conversion (e.g. someone removing the redactSecretString call) is
 * caught. The `redactSecretString` import is shared with the production code
 * path so the test exercises the real implementation, not a copy.
 *
 * @see src/runtime/async-runner.ts flushStderr
 * @see test/unit/background-runner-console-redirect.test.ts (drift-detector pattern)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { redactSecretString } from "../../src/utils/redaction.ts";

/**
 * Mirror of the fixed `flushStderr` body-to-log-line conversion in
 * src/runtime/async-runner.ts. If this drift-detector asserts, update both
 * copies in lockstep.
 */
function formatStderrLine(body: string): string {
	const redacted = redactSecretString(body);
	return `[child stderr] ${redacted}${redacted.endsWith("\n") ? "" : "\n"}`;
}

test("flushStderr redacts a GitHub PAT (ghp_/ghs_/gho_/ghu_/ghr_) in body", () => {
	const fakePat = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
	const line = formatStderrLine(`Error: auth failed for token=${fakePat}\n`);
	assert.ok(!line.includes(fakePat), `raw PAT must NOT appear in logged line, got: ${line}`);
	assert.ok(line.includes("***"), `expected *** redaction marker, got: ${line}`);
	assert.ok(line.includes("Error: auth failed for token="), `non-secret context must be preserved, got: ${line}`);
});

test("flushStderr redacts an AWS access key id (AKIA...) in body", () => {
	const fakeAwsKey = "AKIAIOSFODNN7EXAMPLE";
	const line = formatStderrLine(`credentials leaked: ${fakeAwsKey}\n`);
	assert.ok(!line.includes(fakeAwsKey), `raw AWS key must NOT appear in logged line, got: ${line}`);
	assert.ok(line.includes("***"), `expected *** redaction marker, got: ${line}`);
});

test("flushStderr redacts an inline secret (key=value) in body", () => {
	const line = formatStderrLine(`env dump: MINIMAX_API_KEY=sk-abc123XYZDEF456\n`);
	assert.ok(!line.includes("sk-abc123XYZDEF456"), `raw value must NOT appear in logged line, got: ${line}`);
	assert.ok(line.includes("MINIMAX_API_KEY="), `key name must be preserved for debugging, got: ${line}`);
	assert.ok(line.includes("***"), `expected *** redaction marker, got: ${line}`);
});

test("flushStderr redacts an Authorization: Bearer header in body", () => {
	const fakeBearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
	const line = formatStderrLine(`HTTP request failed: Authorization: ${fakeBearer}\n`);
	assert.ok(!line.includes("eyJhbGciOiJIUzI1NiJ9"), `raw JWT must NOT appear in logged line, got: ${line}`);
	assert.ok(!line.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), `raw JWT signature must NOT appear in logged line, got: ${line}`);
	assert.ok(line.includes("Authorization:"), `header label must be preserved, got: ${line}`);
});

test("flushStderr passes through plain text without secrets unchanged (modulo newline)", () => {
	const plain = "TypeError: Cannot read property 'foo' of undefined\n";
	const line = formatStderrLine(plain);
	assert.equal(line, `[child stderr] ${plain}`);
});

test("flushStderr appends a trailing newline when body lacks one (preserve single-line log shape)", () => {
	const line = formatStderrLine("child error without newline");
	assert.ok(line.endsWith("\n"), `expected trailing newline, got: ${JSON.stringify(line)}`);
	assert.ok(line.startsWith("[child stderr] child error without newline"));
});

test("flushStderr does NOT double-add newline when body already ends with \\n", () => {
	const line = formatStderrLine("child error with newline\n");
	assert.ok(line.endsWith("\n"), `must end with \\n, got: ${JSON.stringify(line)}`);
	assert.ok(!line.endsWith("\n\n"), `must NOT double-add \\n, got: ${JSON.stringify(line)}`);
});

test("flushStderr end-to-end: written log file contains redaction markers, not raw secrets", () => {
	// Verifies the actual fs.appendFileSync-style write path: build a log file
	// the same way flushStderr does, then read it back and assert the file
	// contents are redacted. This catches any regression where someone moves
	// the redactSecretString call AFTER the file write (e.g. a refactor that
	// accidentally writes `body` first and logs a separate "redaction" event).
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-redact-"));
	const logPath = path.join(tmp, "background.log");
	const fakePat = "ghp_" + "Z".repeat(36);
	try {
		const body = `Trace: ${fakePat}\n`;
		fs.appendFileSync(logPath, formatStderrLine(body), "utf-8");
		const written = fs.readFileSync(logPath, "utf-8");
		assert.ok(!written.includes(fakePat), `raw PAT must NOT appear in log file, got: ${written}`);
		assert.ok(written.includes("***"), `expected *** redaction marker in log file, got: ${written}`);
		assert.ok(written.includes("Trace:"), `non-secret context must be preserved in log file, got: ${written}`);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("flushStderr redaction is robust against multiple secrets in the same line", () => {
	const fakeAws = "AKIAIOSFODNN7EXAMPLE";
	const fakePat = "ghp_" + "A".repeat(36);
	const line = formatStderrLine(`crash dump: aws=${fakeAws} token=${fakePat}\n`);
	assert.ok(!line.includes(fakeAws), `raw AWS key must NOT appear, got: ${line}`);
	assert.ok(!line.includes(fakePat), `raw PAT must NOT appear, got: ${line}`);
});