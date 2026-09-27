/**
 * cross-platform-cmd.ts — Cross-platform shell fixtures for unit tests.
 *
 * Many tests need to spawn a sub-command that:
 *   1. Always exits 0 (the "ok" command)
 *   2. Always exits non-zero (the "fail" command)
 *   3. Echoes a fixed string to stdout (the "echo" command)
 *
 * On POSIX (Linux/macOS), `echo ok` / `exit 1` / `echo '<msg>'` are
 * universal. On Windows, the host OS does not ship `/bin/echo` or `/bin/exit`
 * outside Git for Windows — and even with Git Bash, `execFileSync("echo", …)`
 * (used by the benchmark runner for security) cannot find `echo.exe` in the
 * PATH-preserved form Node uses.
 *
 * To stay portable without changing production code (e.g. loosening the
 * benchmark command allowlist), we substitute Node for those tests that
 * don't go through the benchmark allowlist. The Node-based form always
 * produces output identical to the POSIX form (including trailing newline),
 * so any assertion that compares stdout works on both platforms.
 *
 * Usage:
 *   import { pickCmd, OK_CMD, FAIL_CMD, ECHO_CMD } from "./cross-platform-cmd.ts";
 *   const cmd = pickCmd(OK_CMD);
 *   // → "echo ok" on POSIX,  "node -e \"process.stdout.write('ok\\n')\"" on win32
 *
 * Scope: TEST FIXTURES ONLY. Production command validation is stricter than
 * this fixture (RR-021 WI-4.2: the benchmark-runner reference was removed with
 * its dead module).
 */

const IS_WIN32 = process.platform === "win32";

/**
 * Platform-keyed command shape. `posix` runs on Linux/macOS, `win32` runs on
 * Windows. Use `pickCmd(...)` to resolve the right variant at call sites so
 * tests read naturally.
 */
export interface PlatformCmd {
	posix: string;
	win32: string;
}

/**
 * "Always exits 0" fixture. POSIX uses `echo ok`; Windows uses Node so the
 * command works whether or not Git Bash is in PATH.
 *
 * NOTE: `node -e "process.stdout.write('ok\\n')"` matches `echo ok`'s trailing
 * newline so any test asserting on stdout bytes (e.g. `.trim() === "ok"`,
 * `.includes("ok")`, `.split("\\n").length === 2`) is portable unchanged.
 */
export const OK_CMD: PlatformCmd = {
	posix: "echo ok",
	win32: `node -e "process.stdout.write('ok${"\\n"}')"`,
};

/**
 * "Always exits 1" fixture. POSIX shells `exit 1`; Windows uses Node so the
 * failure is deterministic without depending on shell semantics.
 */
export const FAIL_CMD: PlatformCmd = {
	posix: "exit 1",
	win32: `node -e "process.exit(1)"`,
};

/**
 * Build an "echo <msg>" fixture for the given message. The message is treated
 * as a literal — callers must ensure it contains no single quotes (we do not
 * escape to keep the helper readable).
 *
 * To stay correct across platforms, the POSIX variant uses single quotes and
 * the Windows variant uses `process.stdout.write(...)` with `\n` appended.
 */
export function ECHO_CMD(msg: string): PlatformCmd {
	return {
		posix: `echo '${msg}'`,
		win32: `node -e "process.stdout.write('${msg}${"\\n"}')"`,
	};
}

/**
 * Build a "printenv <VAR>" fixture that writes the named environment variable
 * to stdout. Used by the verification env-sanitize suite. Equivalent
 * semantics on POSIX and Windows:
 *   - POSIX: `sh -c "printenv <VAR>"` — built-in `printenv` writes the var.
 *   - Windows: `node -e "process.stdout.write(process.env.<VAR> || '')"`.
 *
 * The Windows variant is portable because the command string contains no
 * shell metacharacters that `validateGateCommand` would block (`$` would be
 * the only risk, and there is none inside the Node source string).
 *
 * NOTE: VAR must be a POSIX env-var identifier (ASCII letters, digits, underscore;
 * must start with letter or underscore). No quoting/escaping is applied because
 * env names are tightly constrained by both shells and the Node runtime.
 */
export function PRINTENV_CMD(varname: string): PlatformCmd {
	return {
		posix: `printenv ${varname}`,
		win32: `node -e "process.stdout.write(process.env.${varname} ?? '')"`,
	};
}

/**
 * Resolve a PlatformCmd to the actual command string for this process's OS.
 * Centralizing the platform branch keeps call sites readable.
 *
 * Example:
 *   { name: "echo", command: pickCmd(OK_CMD), critical: true }
 */
export function pickCmd(cmd: PlatformCmd): string {
	return IS_WIN32 ? cmd.win32 : cmd.posix;
}

/**
 * Convenience: like `pickCmd` but for ECHO_CMD(msg) which is a function.
 * Equivalent to `pickCmd(ECHO_CMD(msg))` but spelled as a single call.
 */
export function pickEcho(msg: string): string {
	return pickCmd(ECHO_CMD(msg));
}

/**
 * Convenience: like `pickCmd` but for PRINTENV_CMD(varname).
 */
export function pickPrintenv(varname: string): string {
	return pickCmd(PRINTENV_CMD(varname));
}
