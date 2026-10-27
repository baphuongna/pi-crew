/**
 * child-pi-spawn.ts — Spawn options + env filtering for child Pi worker processes.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 6). Zero behavior change.
 *
 * Responsibilities:
 *   - BASE_ALLOWLIST: env var names always passed to child workers.
 *   - buildChildPiSpawnOptions(): pure function that builds SpawnOptions from
 *     (cwd, env, model). Validates cwd, filters env via allowlist, validates
 *     NODE_PATH against safe prefixes.
 *   - assertOnlyControlEnvKeys(): runtime canary that verifies the caller only
 *     put PI_CREW (prefix) or PI_TEAMS (prefix) keys into the per-call built.env (defense in
 *     depth against accidental secret leakage).
 *   - prepareSpawnContext(): pre-spawn helper that builds the spawn command spec
 *     from buildPiWorkerArgs output, handles the pre-spawn abort check, and
 *     returns either an immediate-abort result or the spawn context.
 */

import type { SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childPiBaseAllowlist } from "../../config/env-allowlist-registry.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import { isScratchpadEnabledForRole } from "../../config/role-tools.ts";
import { buildScopedAllowList, providerEnvKeys, sanitizeEnvSecrets } from "../../utils/env-filter.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { resolveRealContainedPath } from "../../utils/safe-paths.ts";
import { buildBrokerStdinLine } from "../broker/stdin-handshake.ts";
import { buildPiWorkerArgs, createSafeTempDir, getPiTempBase } from "../model/pi-args.ts";
import { getPiSpawnCommand } from "../pi-spawn.ts";
import { findLatestScratchpadSnapshot } from "../scratchpad/snapshot-lookup.ts";
import type { ChildPiRunInput, ChildPiRunResult } from "./child-pi.ts";
import {
	getInferenceBrokerSnapshot,
	INFERENCE_TOKEN_ENV,
	inferenceWorkerKeyForAgent,
	PI_AGENT_DIR_ENV,
	registerInferenceWorker,
	requireInferenceBrokerIfEnabled,
} from "./inference-broker.ts";

// v0.11.38 W10-1 (pi-subagents lesson #10): pi platform env that selects
// short-lived prompt-cache retention for single-run worker processes
// (long-retention cache writes carry a higher per-write surcharge — wasted on
// a worker that exits after one task). Surface panes and RPC warm sessions do
// NOT set this (their sessions persist and benefit from long-lived cache).
export const PI_CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";

/** LOW-1 residual closure (2026-10-27): when the inter-pi broker credentials
 * are present, the per-task compound TOKEN travels over the spawn stdin pipe
 * (one `buildBrokerStdinLine` payload, heap → pipe → heap — same shape as the
 * F4 background-runner handshake) instead of the child env. Set
 * PI_CREW_BROKER_STDIN=0 to roll back to the legacy env route (token in
 * built.env, stdin stays "ignore"). Default ON. Only the headless JSON spawn
 * branch consumes the payload: the RPC branch (stdin is the JSONL protocol
 * channel) and the surface TUI panes keep the env route, so their env is
 * untouched. */
export function resolveBrokerStdinHandshakeEnabled(): boolean {
	return getCrewEnv("PI_CREW_BROKER_STDIN") !== "0";
}

// ── Env allowlist (base set always passed to children) ──────────────────
// Provider API keys are injected dynamically via buildScopedAllowList() only
// when a model is assigned to the task (per-task key scoping).
// GENERATED (C-1, 2026-10-11) by src/config/env-allowlist-registry.ts —
// content pinned byte-identical to the pre-registry literal by
// test/unit/config/env-allowlist-registry.test.ts.
export const BASE_ALLOWLIST: string[] = childPiBaseAllowlist();

/**
 * Build the SpawnOptions for a child Pi worker process. Pure function — does
 * not call spawn() itself; the caller does that.
 *
 * Responsibilities:
 *   1. Validate cwd (realpath + isDirectory) — fall back to lexical path on ENOENT.
 *   2. Filter env vars to the allowlist (model-aware provider key scoping).
 *   3. Validate NODE_PATH against safe prefixes (/opt, /lib, /usr, /home).
 *   4. Add PI_CREW_PARENT_PID for the child-side parent-guard (consumed by the
 *      reactive zombie-scanner + background-runner parent-guard; unused only by
 *      the pi dist binary — see note at the PI_CREW_PARENT_PID assignment below).
 *
 * R6-8 (DR-03 round-6): `modelChain` threads the task's model CANDIDATE CHAIN
 * (primary + fallbacks, e.g. modelRouting.candidates) so the allowlist is
 * scoped to the UNION of the chain's providers. Previously only the single
 * current model was passed: a bare-id primary (no "provider/" prefix)
 * resolved to ZERO provider env keys → the child failed auth with a
 * non-retryable /api key/i error → the loop broke even though qualified
 * fallbacks were queued (the env-filter.ts doc contract already promised
 * "primary + fallbacks"). Scoping is NEVER weakened by this: keys stay
 * limited to the chain's providers ONLY — never all-providers.
 */
export function buildChildPiSpawnOptions(
	cwd: string,
	env: NodeJS.ProcessEnv,
	model?: string,
	modelChain?: (string | undefined)[],
): SpawnOptions {
	// SECURITY FIX (Issue #1): Validate cwd before passing to spawn.
	// If cwd comes from an untrusted source (user input, workspace config), a malicious cwd
	// could cause the child process to operate in an attacker-controlled directory,
	// enabling path traversal attacks, unintended file access, or exposure of sensitive paths.
	// Use realpathSync to resolve any symlinks and verify the path exists and is a directory.
	let validatedCwd: string;
	try {
		validatedCwd = fs.realpathSync(cwd);
		const stats = fs.statSync(validatedCwd);
		if (!stats.isDirectory()) {
			throw new Error(`cwd is not a directory: ${cwd}`);
		}
	} catch (error) {
		// If cwd doesn't exist (ENOENT) and isn't a security concern, fall back
		// to the lexical path. The child process will create the directory if
		// needed. Throwing would break tests/callers that pass not-yet-existing
		// paths and isn't a security issue for the env-filtering behavior this
		// function is primarily about.
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && error instanceof Error && error.message.includes("ENOENT")) {
			validatedCwd = path.resolve(cwd);
		} else {
			throw new Error(`Invalid cwd: ${cwd} — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Filter out env vars whose keys match secret patterns to avoid leaking credentials to child processes.
	// IMPORTANT: preserve model provider API keys — they are needed by the child Pi to call the LLM.
	// Also preserve essential non-secret vars (PATH, HOME, USER, etc.) so the child process can function.
	// Bug #12 fix: essential env vars (PATH, HOME, etc.) are always preserved so child can find npm/node.
	//
	// PER-TASK KEY SCOPING: when a model is provided, only the env keys for that
	// provider are injected (via buildScopedAllowList). R6-8: when the caller
	// threads the model CANDIDATE CHAIN (primary + fallbacks), keys are scoped
	// to the UNION of the chain's providers so a fallback attempt on a second
	// provider does not spawn keyless. When no model is given, only
	// BASE_ALLOWLIST system vars pass through — no provider keys leak.
	const scopeModels: (string | undefined)[] = modelChain && modelChain.length > 0 ? modelChain : model !== undefined ? [model] : [];
	// v0.11.31 inference broker: when active, the child's ONLY credential is
	// its per-worker broker token — provider env keys are NEVER injected (they
	// would defeat the broker by handing the worker the real reusable key
	// again). The broker snapshot is read-only module state (no side effects —
	// the broker is started by prepareSpawnContext, never here).
	const inferenceBrokerActive = getInferenceBrokerSnapshot().active;
	const allowList = !inferenceBrokerActive && scopeModels.length > 0 ? buildScopedAllowList(BASE_ALLOWLIST, scopeModels) : BASE_ALLOWLIST;
	// R6-8: warn when the scoped models resolve to ZERO provider env keys AND at
	// least one is a truly-bare id (no "provider/" prefix) — env-key auth + bare
	// id means the child worker will very likely fail authentication (observed as
	// the R6-8 stall: bare id → zero keys → /api key/i non-retryable → chain break
	// even though qualified fallbacks were queued). NOT an error, and it never
	// widens the allowlist: users authenticating via auth.json (or custom
	// providers with non-env credentials) are unaffected — the child reads
	// auth.json credentials exactly like the parent process does. Qualified
	// unknown providers ("custom/foo") do not warn: that is a deliberate
	// custom-provider choice, not a likely misconfiguration.
	const anyProviderKeys = scopeModels.some((scoped) => providerEnvKeys(scoped).length > 0);
	const anyBareId = scopeModels.some((scoped) => typeof scoped === "string" && !scoped.includes("/"));
	if (scopeModels.length > 0 && anyBareId && !anyProviderKeys) {
		logInternalError(
			"child-pi-spawn.bare-model-no-provider-keys",
			undefined,
			`model "${model ?? scopeModels.find((scoped) => typeof scoped === "string")}" is a bare id (no provider prefix) and resolved zero provider env keys — the child worker gets no provider API key via env; env-key users should qualify the model id (e.g. "openai/<id>") or configure a fallback chain (auth.json users are unaffected)`,
			"warn",
		);
	}
	const filteredEnv = sanitizeEnvSecrets(env, { allowList });
	// FIX: Removed delete workarounds — with explicit allowlist, these vars
	// are no longer auto-leaked. The wildcard approach was fragile.

	// SECURITY FIX (Issue #1): Validate NODE_PATH to ensure it only contains standard
	// system locations or legitimate user paths (NVM). NODE_PATH can reveal user
	// environment information and could theoretically be exploited if it contains
	// untrusted entries. Only allow paths under standard system directories
	// (/opt, /lib, /usr) or NVM paths under /home/<user>/.nvm/... which are legitimate
	// for Node.js module loading in user environments.
	if (filteredEnv.NODE_PATH) {
		const validPrefixes = ["/opt/", "/lib/", "/usr/local/", "/usr/", "/home/"];
		const validPaths = filteredEnv.NODE_PATH.split(":").filter((p) => {
			return validPrefixes.some((prefix) => p.startsWith(prefix));
		});
		if (validPaths.length > 0) {
			filteredEnv.NODE_PATH = validPaths.join(":");
		} else {
			// No standard paths found — remove NODE_PATH entirely to avoid
			// passing user-specific paths that could reveal environment info.
			delete filteredEnv.NODE_PATH;
		}
	}

	return {
		cwd: validatedCwd,
		env: {
			...filteredEnv,
			// PI_CREW_PARENT_PID is set so child workers can run a parent-guard
			// (parent-guard.ts). Consumers (NOT dead):
			//   1. zombie-scanner.ts:185 — reads PI_CREW_PARENT_PID from
			//      /proc/<pid>/environ (readProcEnviron) to detect orphaned/zombie
			//      workers whose leader died.
			//   2. background-runner.ts:615 — startParentGuard(parentPid)
			//      self-terminates the orchestrator when its own parent dies.
			//   3. scratchpad-lifecycle.ts:50,166 — propagates the leader pid into
			//      scratchpad guest env for guest-zombie detection.
			// The var is unused ONLY by the external `pi` binary
			// (@earendil-works/pi-coding-agent): it does NOT read PI_CREW_PARENT_PID
			// or call startParentGuard (grep of Pi dist = 0 matches), so child-pi
			// workers cannot self-terminate on leader death — they rely on the
			// reactive zombie scanner (see docs/decisions/2026-08-14-parent-guard-reactive-scanner.md).
			// The deeper fix (wiring startParentGuard into the pi worker entry point)
			// is DEFERRED because workers are an external binary pi-crew doesn't control.
			//
			// Orphan-mitigation for this gap relies on:
			//   1. The RT-2 SIGINT fix in background-runner.ts (abort + exitCode pattern
			//      lets the finally/runCleanup block terminate child-pi processes).
			//   2. The reactive zombie-scanner.ts sweep (finds workers whose
			//      PI_CREW_PARENT_PID points at a dead PID).
			PI_CREW_PARENT_PID: String(process.pid),
		},
		stdio: ["ignore", "pipe", "pipe"], // stdin=ignore: child doesn't wait for input; task comes via CLI args
		detached: process.platform !== "win32",
		// Wave 11a (GAP-5): `setsid` is NOT a Node spawn option — it is silently
		// ignored. Group leadership comes from `detached` alone (POSIX setsid() in
		// the child). Kept verbatim instead of deleted: removing it would suggest a
		// behaviour change that never happened.
		setsid: true,
		// NOTE: setsid creates a new session; the child process becomes the session leader
		// and its parent becomes that session leader (still the team-runner in the same
		// process group). PI_CREW_PARENT_PID is set before spawn using process.pid (team-runner),
		// but see the comment above — the pi worker binary does NOT actually consume it. The
		// parent-guard model would check direct parent liveness via process.kill(pid, 0),
		// but this is only implemented in background-runner.ts, not in the worker binary.
		windowsHide: true,
	} as SpawnOptions;
}

/**
 * Throw if `built.env` contains keys outside the PI_CREW_ (prefix) / PI_TEAMS_ (prefix) namespaces.
 * Called right before spawn() as a runtime canary — protects against future
 * regressions where someone accidentally adds a secret key to built.env.
 */
export function assertOnlyControlEnvKeys(builtEnv: Record<string, string | undefined>): void {
	// Verifies built.env (the per-call env we add on top of process.env) only
	// contains PI_CREW_*/PI_TEAMS_* control keys. built.env does NOT include
	// process.env values — those are merged separately via spread and filtered
	// by the allowlist in buildChildPiSpawnOptions. This assertion guards
	// against accidental additions to built.env leaking secrets to children.
	for (const key of Object.keys(builtEnv)) {
		if (!key.startsWith("PI_CREW_") && !key.startsWith("PI_TEAMS_")) {
			throw new Error(
				`SECURITY: built.env contains unexpected key "${key}"; expected only PI_CREW_* or PI_TEAMS_* execution-control vars`,
			);
		}
	}
}

/**
 * Compose the final SpawnOptions for a child Pi worker: runs the runtime canary
 * (assertOnlyControlEnvKeys) on builtEnv, builds the allowlist-filtered base
 * SpawnOptions via buildChildPiSpawnOptions, then re-applies builtEnv on top
 * so the PI_CREW_-prefixed / PI_TEAMS_-prefixed execution-control vars actually
 * reach the child.
 *
 * Extracted from child-pi.ts (BLOCKER 2 / S5) so the spread step is testable
 * in isolation and the canary lives in one place. Guarantees:
 *   1. The canary runs FIRST — a non-control key in builtEnv throws before
 *      buildChildPiSpawnOptions (and before spawn()) is ever called.
 *   2. The spread always runs LAST on the SpawnOptions returned by
 *      buildChildPiSpawnOptions — the filtered base env cannot accidentally
 *      drop execution-control vars that the child needs (steering file, kind,
 *      role, broker credentials, etc.).
 *   3. The returned SpawnOptions.env contains BOTH the allowlist-filtered
 *      system vars (PATH, HOME, …) AND the per-call control vars.
 */
export function buildFinalChildPiSpawnOptions(
	cwd: string,
	mergedEnv: NodeJS.ProcessEnv,
	builtEnv: Record<string, string | undefined>,
	model?: string,
	modelChain?: (string | undefined)[],
	workerCacheSplit?: boolean,
	stdinBrokerPayload?: string,
): SpawnOptions {
	// (a) Canary: builtEnv must contain ONLY PI_CREW_*/PI_TEAMS_* keys.
	assertOnlyControlEnvKeys(builtEnv);
	// (b) Build the allowlist-filtered base SpawnOptions (cwd validation, env
	//     filtering, provider-key scoping when model is set, NODE_PATH guard).
	//     R6-8: modelChain threads the candidate chain for provider-key scoping.
	const spawnOptions = buildChildPiSpawnOptions(cwd, mergedEnv, model, modelChain);
	// (c) Spread builtEnv back on top — the allowlist in step (b) intentionally
	//     strips PI_CREW_*/PI_TEAMS_* keys, so without this spread the child
	//     process would never see steering file, kind, role, or broker creds.
	//     Safe because step (a) just proved builtEnv holds no secret keys.
	spawnOptions.env = { ...spawnOptions.env, ...builtEnv };
	// (c′) v0.11.31 inference broker: pi's NATIVE agent-dir override is NOT a
	//     control-namespace key, so it never travels through built.env (step (a)
	//     would reject it) — it is mapped here, at the spawn-options layer, from
	//     the broker snapshot when a per-worker token is present. The scoped dir
	//     contains ONLY models.json (no auth.json, no extensions, no skills).
	const inferenceSnapshot = getInferenceBrokerSnapshot();
	if (inferenceSnapshot.active && builtEnv[INFERENCE_TOKEN_ENV]) {
		spawnOptions.env[PI_AGENT_DIR_ENV] = inferenceSnapshot.scopedAgentDir ?? "";
	}
	// (c″) v0.11.38 W10-1 (pi-subagents lesson #10): cache TTL split. Worker
	// processes are single-run and short-lived — pi's default prompt-cache
	// retention is long (higher per-write surcharge). Only the headless worker
	// branch opts in; surface panes and RPC warm sessions keep the parent's
	// default (they persist and benefit from long-lived cache).
	if (workerCacheSplit) {
		spawnOptions.env[PI_CACHE_RETENTION_ENV] = "short";
	}
	// (d) LOW-1 closure: when the caller will hand the broker token to the child
	// over the stdin pipe (headless JSON branch — it passes the payload it got
	// from prepareSpawnContext), switch stdin from "ignore" to "pipe" and strip
	// the secret from the env as defense-in-depth (prepareSpawnContext already
	// omits it; the delete guards direct builtEnv constructions in tests/callers
	// that still carry it). RPC branch / surface workerEnv snapshots call
	// WITHOUT this param → env keeps the token and nothing else changes.
	if (stdinBrokerPayload !== undefined) {
		spawnOptions.stdio = ["pipe", "pipe", "pipe"];
		delete spawnOptions.env.PI_CREW_BROKER_TOKEN;
	}
	// (e) Return the composed SpawnOptions for spawn(...).
	return spawnOptions;
}

/** What the spawn site needs to start the child process. */
export interface SpawnContext {
	/** The command + args returned by getPiSpawnCommand. */
	spawnSpec: ReturnType<typeof getPiSpawnCommand>;
	/**
	 * RAW worker argv as produced by buildPiWorkerArgs (BEFORE any binary/script
	 * wrapping) — the surface spawn branch re-resolves the command line after
	 * stripping `--mode json -p` (spec §5.2: surface variant differs ONLY in run
	 * mode), so it needs the untouched argument list.
	 */
	builtArgs: string[];
	/** The merged env (process.env + built.env) to pass to spawn(). */
	mergedEnv: NodeJS.ProcessEnv;
	/** Temp dir created by buildPiWorkerArgs (caller must clean up after spawn). */
	tempDir: string | undefined;
	/** The per-call built.env (control vars only) — for security canary assertions. */
	builtEnv: Record<string, string | undefined>;
	/** v0.11.31: inference-broker worker key that owns this spawn's token (cleanup/revoke bookkeeping). */
	inferenceWorkerKey?: string;
	/** LOW-1 closure: one-line broker credential payload to write to the
	 * child's stdin right after spawn (headless JSON branch ONLY — the RPC
	 * branch owns stdin for its JSONL protocol and surface panes are TTY).
	 * Present ⇒ PI_CREW_BROKER_TOKEN is NOT in builtEnv (token travels
	 * heap → pipe → heap instead). Undefined ⇒ legacy env route. */
	brokerStdinPayload?: string;
}

/**
 * Build the spawn context for a child Pi run: calls buildPiWorkerArgs,
 * attaches PI_CREW_STEERING_FILE if a steering file is configured, then returns
 * the spawn command spec + merged env. Does NOT spawn.
 *
 * If the parent AbortSignal has already fired, returns an immediate-abort
 * ChildPiRunResult instead — spawn is then skipped entirely (saves resources).
 */
export function prepareSpawnContext(
	input: ChildPiRunInput,
	effectiveTask: string,
	depthEnv?: NodeJS.ProcessEnv,
): { kind: "ready"; ctx: SpawnContext } | { kind: "aborted"; result: ChildPiRunResult } {
	const built = buildPiWorkerArgs({
		task: effectiveTask,
		agent: input.agent,
		model: input.model,
		sessionEnabled: true,
		// R3-15: human-facing `--name crew-<taskId>` session label (agentId IS the
		// task id; anonymous spawns without one simply get no name — same
		// optional-shape as sessionId/sessionDir above).
		taskId: input.agentId,
		// W2 (P1-1): deterministic session identity so crash-path tail-recovery
		// can find the worker's session JSONL (see session-recovery.ts). Falls
		// back to child-pi.ts deriveSessionPaths when unset (idempotent both ways).
		sessionId: input.sessionId,
		sessionDir: input.sessionDir,
		maxDepth: input.maxDepth,
		skillPaths: input.skillPaths,
		role: input.role,
		thinkingOverride: input.thinkingOverride,
		systemPromptAppend: input.systemPromptAppend,
		hermeticWorkers: input.hermeticWorkers,
		// U9: version-gated flags (--no-mcp floor) — threaded by runChildPi's
		// single-flight probe; undefined/null = unknown → builder emits nothing.
		piVersion: input.piVersion,
		// ADR-5 §3: depthOverride is pre-encoded into depthEnv by runChildPi
		// (parent's record depth as base-env PI_CREW_DEPTH); forward it so the
		// child env gets parentDepth+1 = the true grandchild depth.
		env: depthEnv,
	});
	// v0.11.31 inference broker (opt-in PI_CREW_INFERENCE_BROKER=1): the broker
	// must already be running (child-pi.ts run() awaits maybeStartInferenceBroker()
	// first — http listen needs an event-loop turn, so the SYNC spawn path can
	// only require, never start). Issue this worker's token. Control-namespace
	// key → passes assertOnlyControlEnvKeys. FAIL-CLOSED: flag on without a
	// started broker or an upstream credential throws here (never silently
	// spawn keyless / real-key workers). Worker key: the task id when present
	// (retries REPLACE the old token — registerInferenceWorker semantics), else
	// a per-spawn unique.
	const inferenceSnapshot = requireInferenceBrokerIfEnabled();
	let inferenceWorkerKey: string | undefined;
	// LOW-1 closure: stdin handshake payload for the headless JSON branch (see
	// the brokerSpawn block below). Undefined = env route (legacy/rollback).
	let brokerStdinPayload: string | undefined;
	if (inferenceSnapshot.active) {
		// v0.11.36: the agentId derivation is SHARED with the exit-revoke wrapper
		// (runChildPi finally) via inferenceWorkerKeyForAgent — both sides must
		// compute the SAME key or revoke-on-exit silently misses.
		inferenceWorkerKey = input.agentId
			? inferenceWorkerKeyForAgent(input.agentId)
			: `inference:spawn:${process.pid}:${Date.now().toString(36)}`;
		built.env[INFERENCE_TOKEN_ENV] = registerInferenceWorker(inferenceWorkerKey);
	}
	// Pass steering file path to child for real-time steer injection
	if (input.steeringFile) built.env.PI_CREW_STEERING_FILE = input.steeringFile;
	// I5: run/task identity is threaded ALWAYS (not broker-gated) so the worker's
	// scratchpad metric events (emitScratchpadMetric) can write runId/taskId even
	// when the inter-pi broker is disabled. Control-namespace keys — pass
	// assertOnlyControlEnvKeys.
	if (input.runId) built.env.PI_CREW_BROKER_RUN_ID = input.runId;
	if (input.agentId) built.env.PI_CREW_BROKER_TASK_ID = input.agentId;
	// WP-2/R2 (ADR-0 item 2 — P0 env plumbing): UNCONDITIONAL for EVERY role,
	// read-only (reviewer/security-reviewer/explorer/…) included — the
	// worker-side `ask` tool + mailbox poll must be reachable by exactly the
	// roles that cannot write files to unblock themselves. Deliberately NOT
	// scratchpad-gated: the scratchpad gate below excludes read-only roles by
	// design (S-6), which would leave the ask tool dead-on-arrival there.
	// Control-namespace keys → pass assertOnlyControlEnvKeys.
	built.env.PI_CREW_ASK_ENABLED = "1"; // dormant gate (worker conditional registerTool)
	// D9/§15.2: the worker-side `message` tool env is UNCONDITIONAL for EVERY
	// role and depth, like ask/delegate. The env gate is UX/hygiene, NOT the
	// security boundary: the broker re-checks `from` (always the authenticated
	// taskId) + `to` (parent/sibling/group) + kind (notify|message) from the
	// connection identity, so an env flag alone cannot forge a sender.
	// Control-namespace key → assertOnlyControlEnvKeys.
	built.env.PI_CREW_MSG_ENABLED = "1"; // dormant gate (worker conditional registerTool)
	// T3/R5 (ADR-5 §1, D8): the worker-side `delegate` tool env is now
	// UNCONDITIONAL for EVERY role and depth — read-only/analyst roles get the
	// tool too. The env gate is UX/hygiene, NOT the security boundary:
	// broker admission re-checks depth + nested-slot budget from the task
	// RECORD (spawn-policy.ts), and the spawn-side checkCrewDepth cap stops
	// depth ≥ maxDepth children from even starting. Control-namespace key →
	// assertOnlyControlEnvKeys.
	built.env.PI_CREW_DELEGATE_ENABLED = "1"; // dormant gate (worker conditional registerTool)
	// stateRoot from the spawn manifest: ChildPiRunInput threads
	// manifest.eventsPath unconditionally (child-executor / background-runner)
	// and the state store pins eventsPath === <stateRoot>/events.jsonl
	// (DEFAULT_PATHS.state.eventsFile; the invariant is validated by
	// state-store.ts + manifest-cache.ts) — dirname(eventsPath) IS the manifest
	// stateRoot. Absent (non-team spawn) → var stays unset and the ask tool
	// fast-fails with a structured notice instead of hanging.
	if (input.eventsPath) built.env.PI_CREW_STATE_ROOT = path.dirname(input.eventsPath);
	// Phase 0 inter-pi broker: inject socket path + token (control-namespace keys,
	// safe under assertOnlyControlEnvKeys). Only when the parent broker issued
	// credentials for this run — i.e. the broker is enabled AND this run is
	// eligible. NEVER persisted to disk.
	// LOW-1 closure: by default the TOKEN leaves the env entirely — it rides the
	// spawn stdin pipe as a single buildBrokerStdinLine payload (ctx
	// .brokerStdinPayload; the headless JSON branch pipes stdin and writes it
	// right after spawn). SOCKET/RUN_ID/TASK_ID stay in env (non-secret, needed
	// by the worker bootstrap to bind + validate the stdin payload). Rollback
	// gate PI_CREW_BROKER_STDIN=0 (or a legacy shape without runId/taskId to
	// bind the payload to) keeps the env route bit-for-bit.
	if (input.brokerSpawn?.socketPath && input.brokerSpawn.token) {
		built.env.PI_CREW_BROKER_SOCKET = input.brokerSpawn.socketPath;
		if (resolveBrokerStdinHandshakeEnabled() && input.runId && input.agentId) {
			brokerStdinPayload = buildBrokerStdinLine(input.runId, input.brokerSpawn.socketPath, {
				[input.agentId]: input.brokerSpawn.token,
			});
		} else {
			built.env.PI_CREW_BROKER_TOKEN = input.brokerSpawn.token;
		}
		// runId/taskId are threaded unconditionally above (I5); nothing to add here.
	}
	// WP-9 (R9): the worker self-reporting channel env is UNCONDITIONAL —
	// previously scratchpad-gated, which excluded read-only roles by design
	// (S-6) and left them no reporting path. The bounded channel module
	// (worker-events-channel.ts) rate-limits + schema-tags worker.* appends.
	// Control-namespace keys → assertOnlyControlEnvKeys. PI_CREW_TASK_ID is
	// set here when absent so the channel's events carry their task (the
	// scratchpad block below sets it first when it runs — same value).
	if (input.eventsPath) {
		built.env.PI_CREW_EVENTS_PATH = input.eventsPath;
		if (input.agentId && !built.env.PI_CREW_TASK_ID) built.env.PI_CREW_TASK_ID = input.agentId;
	}
	// Phase 1 scratchpad: opt in the persistent Bun-free JS evaluator (execute
	// tool) for this worker. Gated by role/agent (S-6 read-only roles never;
	// F6 agent.scratchpad===false kills). All keys are PI_CREW_* control vars →
	// pass assertOnlyControlEnvKeys. Only set when there is a task id to bind
	// the snapshot to (always present on the child-executor path).
	if (input.agentId && isScratchpadEnabledForRole(input.role ?? input.agent.name, input.agent)) {
		built.env.PI_CREW_SCRATCHPAD = "1"; // dormant gate (worker conditional registerTool)
		built.env.PI_CREW_TASK_ID = input.agentId; // snapshot relativePath provenance
		built.env.PI_CREW_ATTEMPT = String(input.attempt ?? 0); // C3 per-attempt suffix
		if (input.artifactsRoot) {
			// N2-1: worker reads this DIRECTLY as writeArtifact's artifactsRoot — do
			// NOT derive from the snapshot path (snapshot is in tempDir, not under
			// artifactsRoot after F4/S-1).
			built.env.PI_CREW_ARTIFACTS_ROOT = input.artifactsRoot;
		}
		// F4/S-1: the RAW (unredacted) snapshot must NEVER land in artifactsRoot —
		// point it at a temp dir; the worker reads it then writeArtifact()
		// (redact+atomic) is the ONLY writer into artifactsRoot.
		// R3-1: since G3 (spill-always) buildPiWorkerArgs creates a tempDir for
		// EVERY spawn (task.md) — the `??` guard stays as pure defense against
		// future call shapes (resolveRealContainedPath(undefined) would
		// TypeError and crash spawn). createSafeTempDir auto-tracks the dir for
		// cleanupAllTrackedTempDirs.
		const scratchTempDir = built.tempDir ?? createSafeTempDir(getPiTempBase(), "pi-crew-scratchpad-");
		built.env.PI_CREW_SCRATCHPAD_SNAPSHOT = resolveRealContainedPath(scratchTempDir, `${input.agentId}.snapshot.json`);
		// Phase 2 crash-resume (D1/D1b/D2): locate the latest snapshot artifact of a
		// PREVIOUS attempt (retry round / crash-recovery re-queue / manual re-run)
		// and hand its path to the worker via PI_CREW_SCRATCHPAD_RESTORE. The worker
		// re-validates at READ time (D10) — this env is a hint, not a trust anchor.
		// Latest-mtime wins (model-fallback i resets each retry round); RESTORE_MTIME
		// lets the worker detect a swap between spawn and first execute (MINOR-S1).
		const restoreHit = input.artifactsRoot ? findLatestScratchpadSnapshot(input.artifactsRoot, input.agentId) : null;
		if (restoreHit) {
			built.env.PI_CREW_SCRATCHPAD_RESTORE = restoreHit.path;
			// NIT-CA-1: mtime pin is a SWAP-DETECTION HINT (defense-in-depth), never
			// an integrity/authn control — any same-uid actor can utimesSync it.
			built.env.PI_CREW_SCRATCHPAD_RESTORE_MTIME = String(restoreHit.mtimeMs);
		}
	}
	// B5: if the parent already aborted before we spawn, do not start the child
	// at all. Spawning a doomed process wastes resources, and the abort listener
	// registered below will not re-fire for an already-aborted signal (so the
	// child would only be killed later by the response-timeout path). Return a
	// cancelled-style result immediately.
	if (input.signal?.aborted) {
		return {
			kind: "aborted",
			result: {
				exitCode: null,
				stdout: "",
				stderr: "",
				error: "Aborted before spawn (parent AbortSignal already aborted)",
				aborted: true,
			},
		};
	}
	const spawnSpec = getPiSpawnCommand(built.args);
	return {
		kind: "ready",
		ctx: {
			spawnSpec,
			builtArgs: built.args,
			mergedEnv: { ...process.env, ...built.env },
			tempDir: built.tempDir,
			builtEnv: built.env,
			inferenceWorkerKey,
			...(brokerStdinPayload !== undefined ? { brokerStdinPayload } : {}),
		},
	};
}
