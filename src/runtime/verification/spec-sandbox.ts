/**
 * spec-sandbox.ts — hardened re-run sandbox for strict-mode spec checks
 * (ADR-6 §4, WP-6 step 4).
 *
 * Executes ONLY snapshot-frozen acceptance commands (never the live
 * state/specs/<id>.json) under layered isolation:
 *   - env: BASE_ALLOWLIST pattern minus credential-carrying keys — NO
 *     provider API keys, NO PI_CREW_BROKER_*, NO session tokens (asserted by
 *     capturing the child env in tests);
 *   - cwd: pinned to the run's workspace root;
 *   - resources: `sh -c 'ulimit -v 262144; ulimit -t 30; exec …'`
 *     (256 MiB address space, 30 CPU-seconds);
 *   - wall-clock: 60s — SIGTERM → 200ms → SIGKILL escalation;
 *   - network: `unshare -rn` wrapper on Linux (user-namespace + map-root;
 *     plain -n needs CAP_SYS_ADMIN and fails EPERM unprivileged, which would
 *     brick every strict re-run).
 *
 * FAIL-CLOSED: wrapper-launch failure fails that acceptance closed — NEVER
 * silently degrades to pass or to running without isolation. macOS has no
 * unshare equivalent → launch-failed there too (platform honesty: the gate
 * emits a loud platform warning; strict re-runs are Linux-only in v1).
 *
 * LEAK DISCIPLINE: results are DIGEST-ONLY. stdout/stderr text never leaves
 * this module — events, logs, and artifacts see exit code / signal / digest /
 * stderr-LENGTH only (error paths included: timeouts, signals, launch
 * failures).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { sanitizeEnvSecrets } from "../../utils/env-filter.ts";
import { BASE_ALLOWLIST } from "../child-pi/child-pi-spawn.ts";

/** Config-capped ceilings (ADR-6 §4) — NOT user-facing knobs in v1. The
 *  `limits` override on runSpecCheck is an internal test seam. */
export interface SpecSandboxLimits {
	addressSpaceKb: number; // ulimit -v (256 MiB)
	cpuSeconds: number; // ulimit -t
	wallClockMs: number; // 60s hard wall clock
	sigkillGraceMs: number; // SIGTERM → 200ms → SIGKILL
	maxOutputBytes: number; // stdout buffer cap (digest still computed over capped buffer)
}

export const SPEC_SANDBOX_LIMITS: SpecSandboxLimits = {
	addressSpaceKb: 262_144,
	cpuSeconds: 30,
	wallClockMs: 60_000,
	sigkillGraceMs: 200,
	maxOutputBytes: 4 * 1024 * 1024,
};

/** Credential-shaped keys are scrubbed EVEN IF an allowlist entry matches —
 *  belt-and-suspenders against future BASE_ALLOWLIST additions. */
const CREDENTIAL_KEY_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_BEARER|^PI_CREW_BROKER)/i;

/** Sandbox env: BASE_ALLOWLIST pattern minus credential-carrying keys. */
export function buildSpecSandboxEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const base: Record<string, string> = {};
	for (const key of BASE_ALLOWLIST) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) continue;
		const value = env[key];
		if (value !== undefined) base[key] = value;
	}
	// Second pass: the generic secret scrubber (env-filter, deny-list mode)
	// over the selected set — defense in depth against secret-shaped keys
	// smuggled into future BASE_ALLOWLIST additions.
	const scrubbed = sanitizeEnvSecrets(base);
	for (const key of Object.keys(scrubbed)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) continue;
		base[key] = scrubbed[key] ?? base[key];
	}
	base.FORCE_COLOR = "0";
	return base;
}

export type SpecCheckOutcomeKind =
	| "passed"
	| "digest-mismatch"
	| "exit-mismatch"
	| "output-capped"
	| "timeout"
	| "launch-failed"
	| "network-blocked";

/** Digest-only result — raw command output NEVER persists (leak discipline). */
export interface SpecCheckOutcome {
	outcome: SpecCheckOutcomeKind;
	actualDigest?: string;
	exitCode?: number | null;
	signal?: string;
	durationMs: number;
	stderrLength?: number;
	/** stdout exceeded maxOutputBytes — digest comparison invalid (the authored
	 *  expectedDigest is over FULL stdout); surfaced so the failure is
	 *  distinguishable from real tampering (round-1 review). */
	stdoutCapped?: boolean;
}

export interface SpecCheckCommand {
	command: string;
	/** sha-256 hex of raw stdout. Optional — exit-code-only checks omit it. */
	expectedDigest?: string;
	/** Default 0 when neither digest nor exit code is declared. */
	expectedExitCode?: number;
}

/** `unshare -rn` is Linux-only; strict re-runs fail closed elsewhere. */
export function isSpecSandboxSupported(): boolean {
	return process.platform === "linux";
}

export async function runSpecCheck(
	check: SpecCheckCommand,
	options: { cwd: string; limits?: Partial<SpecSandboxLimits>; wrapperOverride?: string },
): Promise<SpecCheckOutcome> {
	const limits = { ...SPEC_SANDBOX_LIMITS, ...options.limits };
	const wrapper = options.wrapperOverride ?? "unshare";
	const start = Date.now();
	if (!isSpecSandboxSupported()) {
		// Platform honesty: macOS/Windows have no unshare equivalent → fail
		// closed, never silently run without isolation.
		return { outcome: "launch-failed", durationMs: Date.now() - start, stderrLength: 0 };
	}
	// `exec` so ulimits apply to the command's own process. The user command
	// rides as $0 (argv, never string-interpolated — arbitrary quoting is safe
	// and compound commands like `a && b` keep their shell semantics).
	const inner = `ulimit -v ${limits.addressSpaceKb}; ulimit -t ${limits.cpuSeconds}; exec sh -c "$0"`;
	return await new Promise<SpecCheckOutcome>((resolve) => {
		const child = spawn(wrapper, ["-rn", "sh", "-c", inner, check.command], {
			cwd: options.cwd,
			env: buildSpecSandboxEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true, // own process group — group-wide kill reaches grandchildren holding the stdio pipes (CORE-10 pattern)
		});
		let stdout = "";
		let stderrLen = 0;
		let stdoutCapped = false;
		let settled = false;
		let termTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const finish = (outcome: SpecCheckOutcome): void => {
			if (settled) return;
			settled = true;
			if (termTimer) clearTimeout(termTimer);
			if (killTimer) clearTimeout(killTimer);
			resolve(outcome);
		};
		termTimer = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		}, limits.wallClockMs);
		termTimer.unref();
		killTimer = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, limits.wallClockMs + limits.sigkillGraceMs);
		killTimer.unref();
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length >= limits.maxOutputBytes) {
				stdoutCapped = true;
				return;
			}
			stdout += chunk.toString("utf8");
			if (stdout.length > limits.maxOutputBytes) {
				stdout = stdout.slice(0, limits.maxOutputBytes);
				stdoutCapped = true;
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrLen += chunk.length;
		});
		child.on("error", (err) => {
			// Wrapper-launch failure (unshare missing/EACCES/EPERM) — fail closed.
			const outcome: SpecCheckOutcome =
				(err as NodeJS.ErrnoException).code === "ENOENT"
					? { outcome: "launch-failed", durationMs: Date.now() - start, stderrLength: stderrLen }
					: { outcome: "launch-failed", durationMs: Date.now() - start, stderrLength: stderrLen };
			finish(outcome);
		});
		child.on("exit", () => {
			// Survivor kill (round-1): a passing command can background a process
			// that outlives the check. Must run on EXIT, not CLOSE — a survivor
			// holding the stdout pipe delays `close` until it dies, which would
			// make this kill a no-op by construction.
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				/* group already reaped — fine */
			}
		});
		child.on("close", (code, signal) => {
			const durationMs = Date.now() - start;
			if (signal === "SIGTERM" || signal === "SIGKILL") {
				finish({ outcome: "timeout", signal: signal ?? undefined, durationMs, stderrLength: stderrLen });
				return;
			}
			const actualDigest = createHash("sha256").update(stdout, "utf8").digest("hex");
			const expectedExit = check.expectedExitCode ?? 0;
			if (stdoutCapped && check.expectedDigest !== undefined) {
				// The authored expectedDigest is over FULL stdout — comparing the
				// capped prefix is invalid. Fail with the distinct honest outcome.
				finish({
					outcome: "output-capped",
					actualDigest,
					exitCode: code,
					signal: signal ?? undefined,
					durationMs,
					stderrLength: stderrLen,
					stdoutCapped: true,
				});
				return;
			}
			const exitOk = code === expectedExit;
			const digestOk = check.expectedDigest === undefined || actualDigest === check.expectedDigest;
			if (!exitOk) {
				finish({
					outcome: "exit-mismatch",
					actualDigest: check.expectedDigest !== undefined ? actualDigest : undefined,
					exitCode: code,
					signal: signal ?? undefined,
					durationMs,
					stderrLength: stderrLen,
				});
				return;
			}
			if (!digestOk) {
				finish({
					outcome: "digest-mismatch",
					actualDigest,
					exitCode: code,
					signal: signal ?? undefined,
					durationMs,
					stderrLength: stderrLen,
				});
				return;
			}
			finish({
				outcome: "passed",
				actualDigest: check.expectedDigest !== undefined || stdoutCapped ? actualDigest : undefined,
				exitCode: code,
				signal: signal ?? undefined,
				durationMs,
				stderrLength: stderrLen,
				...(stdoutCapped ? { stdoutCapped: true } : {}),
			});
		});
	});
}
