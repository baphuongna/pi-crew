/**
 * pi-version.ts — host `pi` binary version probe + hand-rolled comparison
 * (U9, pi 1.0.4 adoption wave).
 *
 * WHY HAND-ROLLED (no `semver` dependency): pi-crew's package policy is ZERO
 * new runtime dependencies (AGENTS.md / wave constraint). The comparison
 * surface pi-crew actually needs is major.minor.patch + simple pre-release
 * ordering + conservative null on malformed input — pulling in `semver` for
 * that costs a dependency (plus its transitive tree) that every install pays
 * for a decision made at most once per process. If a richer need appears
 * (ranges, build-metadata ordering), REVISIT this decision explicitly — do
 * not silently grow this file into a partial semver implementation.
 *
 * PROBE CONTRACT (probePiVersion):
 *   - Execs the SAME binary the stdio transport spawns: getPiSpawnCommand
 *     (PI_TEAMS_PI_BIN aware) with `--version` — probing a different install
 *     than the one we spawn would gate flags on the wrong version.
 *   - The exec is INJECTABLE (ExecPiVersionFn seam) so unit tests never spawn
 *     a real child; the default seam wraps node:child_process execFile with a
 *     5s timeout (utf8).
 *   - Single-flight memoized per process: the FIRST call creates the promise;
 *     every later call (any args) returns the same one. Failures memoize too
 *     (null = unknown) — a missing/old pi binary does not re-probe per spawn.
 *   - NEVER rejects: spawn error / nonzero exit / timeout / unparseable
 *     stdout all resolve null. The result is a hint, never a failure channel.
 *
 * COMPARISON CONTRACT (comparePiVersion):
 *   - Strict `major.minor.patch[-prerelease][+build]` (official semver shape;
 *     leading zeros rejected). Build metadata is IGNORED per semver §10.
 *   - Malformed input (either side, incl. null/undefined) → null — callers
 *     treat null as "unknown" and conservatively emit NO version-gated flag.
 *   - Pre-release ordering (semver §11, simplified): release > pre-release;
 *     identifiers compared pairwise (numeric identifiers numerically and
 *     LOWER than alphanumeric; alphanumeric lexically); a shorter identifier
 *     list is lower when all preceding identifiers are equal.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPiSpawnCommand } from "../pi-spawn.ts";

/** Probe timeout (ms). `pi --version` is a fast print; 5s absorbs slow cold starts. */
export const PI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Injectable exec seam for {@link probePiVersion}. Mirrors the
 * promisify(execFile) shape: resolves {stdout, stderr} on exit 0, REJECTS on
 * spawn error / nonzero exit / timeout. Tests pass a fake — the default
 * seam would spawn a real child (forbidden in unit tests).
 */
export type ExecPiVersionFn = (
	file: string,
	args: string[],
	options: { timeout: number; encoding: "utf8" },
) => Promise<{ stdout?: string; stderr?: string }>;

const execFileAsync = promisify(execFile);

const defaultExec: ExecPiVersionFn = (file, args, options) => execFileAsync(file, args, options);

/**
 * ── Version-floor registry (U9) ─────────────────────────────────────────────
 * Every argv flag pi-crew gates on the HOST pi binary's version is listed
 * here so "which pi needs which flag" is greppable in ONE place. The emit
 * sites live in src/runtime/model/pi-args.ts (parity non-hermetic block).
 *
 *   - `1.0.4` → `--no-mcp`: disconnects ambient MCP servers outright ("no
 *     servers connect, no MCP tools or /mcp" — cli.md:198), strictly stronger
 *     than the U2-lite `mcp__*` --exclude-tools tool-cut. Emitted ONLY on
 *     parity (non-hermetic) spawns whose probed piVersion >= this floor.
 *
 * Future candidates: none yet. When adding one, append the floor constant
 * here + the gate at the emit site — pre-floor hosts must NEVER see the flag
 * (pi's strict parser rejects unknown options with a nonzero exit).
 */
export const PI_NO_MCP_FLOOR = "1.0.4";

// Probe-side extraction is LENIENT (tolerates "pi 1.0.4" / banners); the
// strict validation lives in parseVersion below. First version-shaped token
// in stdout wins.
const VERSION_TOKEN_RE = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/;

// Strict semver shape (official regex, numeric identifiers without leading
// zeros). Anything else is "unknown" — never a guess.
const STRICT_SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	/** null = release (no pre-release). Build metadata is dropped at parse. */
	prerelease: string[] | null;
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
	if (typeof value !== "string") return null;
	const match = STRICT_SEMVER_RE.exec(value.trim());
	if (!match) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	const prerelease = match[4] === undefined ? null : match[4].split(".");
	return { major, minor, patch, prerelease };
}

/** Semver §11 identifier compare: numeric < alphanumeric; numeric numeric-ly, alphanumeric lexically. */
function comparePrereleaseIdentifiers(a: string, b: string): -1 | 0 | 1 {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) {
		const delta = Number(a) - Number(b);
		return delta < 0 ? -1 : delta > 0 ? 1 : 0;
	}
	if (aNumeric) return -1; // numeric identifiers have LOWER precedence
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare two pi version strings. Returns -1 | 0 | 1, or null when EITHER
 * side is malformed/unknown (conservative — callers must treat null as
 * "emit nothing version-gated"). Build metadata is ignored (semver §10).
 */
export function comparePiVersion(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return null;
	for (const key of ["major", "minor", "patch"] as const) {
		if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
	}
	if (pa.prerelease === null && pb.prerelease === null) return 0;
	if (pa.prerelease === null) return 1; // release > pre-release
	if (pb.prerelease === null) return -1;
	const ids = pa.prerelease;
	const other = pb.prerelease;
	for (let i = 0; i < Math.min(ids.length, other.length); i++) {
		const cmp = comparePrereleaseIdentifiers(ids[i] as string, other[i] as string);
		if (cmp !== 0) return cmp;
	}
	if (ids.length !== other.length) return ids.length < other.length ? -1 : 1; // larger set wins
	return 0;
}

/**
 * Floor gate: true ONLY when `version` parses and is >= `floor`. Unknown
 * (null/undefined) or malformed versions are BELOW every floor — the
 * conservative "never emit a flag the host may reject" posture.
 */
export function piVersionAtLeast(version: string | null | undefined, floor: string): boolean {
	const cmp = comparePiVersion(version, floor);
	return cmp !== null && cmp >= 0;
}

/** Memoized single-flight probe promise (null = unknown, failures included). */
let memoizedProbe: Promise<string | null> | null = null;

async function runPiVersionProbe(exec: ExecPiVersionFn): Promise<string | null> {
	const { command, args } = getPiSpawnCommand(["--version"]);
	const { stdout } = await exec(command, args, { timeout: PI_VERSION_PROBE_TIMEOUT_MS, encoding: "utf8" });
	const text = typeof stdout === "string" ? stdout : "";
	const hit = VERSION_TOKEN_RE.exec(text);
	return hit ? hit[0] : null;
}

/**
 * Resolve the host pi binary's version (`pi --version`), single-flight
 * memoized per process. The `exec` seam is consumed only by the call that
 * actually creates the memo — later calls reuse the settled promise no
 * matter what they pass. NEVER rejects; unknown resolves null.
 */
export function probePiVersion(exec: ExecPiVersionFn = defaultExec): Promise<string | null> {
	if (!memoizedProbe) memoizedProbe = runPiVersionProbe(exec).catch(() => null);
	return memoizedProbe;
}

/** @internal Test-only: drop the memoized probe so the next call re-probes with a fresh seam. */
export function __test_resetPiVersionMemo(): void {
	memoizedProbe = null;
}

/** @internal Test-only: is a probe memoized? (null = no probe has run yet —
 *  lets tests prove a code path never TOUCHED the probe, which the call
 *  counter alone cannot show once single-flight kicks in). */
export function __test_peekPiVersionMemo(): Promise<string | null> | null {
	return memoizedProbe;
}
