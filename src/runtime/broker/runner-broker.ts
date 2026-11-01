/**
 * runner-broker.ts — FINDING D (2026-11-01): async runs previously pointed
 * every worker at the DISPATCHER's broker socket (stdin payload
 * `payload.socketPath`). A `pi -p` dispatcher exits seconds after async
 * dispatch; session_shutdown stops that broker and unlinks its socket — every
 * later broker op from the still-running run (ask parks, msg.notify, respond
 * RPC, delegate nesting) then hit connect ENOENT. Live probes (8/9) caught
 * the vanish via the manifest stamp: stamped path served the park, then
 * vanished while the runner kept heartbeating — the broker host was never the
 * runner, it was the departed dispatcher.
 *
 * The detached runner is the only process guaranteed to outlive the run, so
 * IT hosts the run's broker from now on:
 *  - fresh `runner-${runId}` sessionId → fresh socket (no collision with any
 *    live session; a leftover from a crashed runner is stale-removed at bind)
 *  - per-task COMPOUND tokens minted in the runner heap — the same trust
 *    domain as the stdin-payload pre-mints they replace (creds crossed one
 *    pipe either way); fail-closed on missing taskId (w1a
 *    broker-bare-run-token-forged-task-identity, mirroring both prior issuers)
 *  - `dispatcherVerifyKey` from the stdin payload stays the respond.append CR
 *    trust anchor: signatures still verify against the DISPATCHER's keypair,
 *    so the alive-dispatcher path is unchanged; respond.force keeps its
 *    token-less one-shot for a live park
 *  - construction mirrors the lifecycle host (lifecycle-handlers.ts getOrStart
 *    Broker) config-for-config — waitMethods/nesting/limits/catalog — so the
 *    capability surface is identical on either host
 *  - the runner's finally → runCleanup() stops it → ownership-gated unlink
 *
 * Failure to start fails SOFT and returns undefined: the caller keeps the
 * legacy payload issuer (dispatcher socket + pre-minted tokens), which is
 * exactly the pre-Finding-D behavior (correct while the dispatcher lives).
 */

import { CrewBroker } from "./crew-broker.ts";
import { getBrokerSocketPath } from "../../utils/socket-path.ts";
import { getActiveDispatcherVerifyKey, setActiveDispatcherVerifyKey } from "./dispatcher-key-registry.ts";
import { ensureCoordinationPublicVerifyKey } from "../../state/coordination/mailbox.ts";
import type { BrokerSpawnCredentials } from "./broker-issuer.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import { loadConfig } from "../../config/config.ts";
import { configuredModelInfosFromPiConfig } from "../model/model-fallback.ts";
import { logInternalError } from "../../utils/internal-error.ts";

/** Handle on the runner-hosted broker handed back to background-runner. */
export interface RunnerHostedBrokerHandle {
	/** The live broker (already started). */
	broker: CrewBroker;
	/** Resolved listening socket path (safe to stamp into the manifest). */
	socketPath: string;
	/** BrokerSpawnCredentials issuer — SAME contract as the stdin-payload
	 * issuer it replaces (fail-closed on missing taskId, depth-capped). */
	issueForChild: (runId: string, taskId?: string, childDepth?: number) => Promise<BrokerSpawnCredentials | undefined>;
	/** Ownership-gated stop (idempotent). */
	stop: () => Promise<void>;
}

/** Mirror of the lifecycle host's effectiveEnabled gate (env wins, config
 *  default-on since v0.9.47). Never throws. */
function brokerEnabled(cwd: string): boolean {
	const envOverride = getCrewEnv("PI_CREW_BROKER");
	if (envOverride === "0") return false;
	try {
		const cfg = loadConfig(cwd).config.broker;
		if (envOverride === "1") return cfg !== undefined ? cfg.enabled !== false : true;
		return cfg?.enabled !== false;
	} catch {
		// Fail-safe: config load failed → keep the broker off (legacy issuer).
		return false;
	}
}

/**
 * Start a broker hosted by THIS detached-runner process for `runId`.
 * Returns undefined (soft-fail) when the broker is disabled or fails to
 * start — callers must then keep the legacy stdin-payload issuer.
 */
export async function startRunnerHostedBroker(input: {
	runId: string;
	cwd: string;
	/** Optional socket-path override (test seam / explicit placement). */
	socketPath?: string;
	/** The DISPATCHER's public verify key from the stdin payload (CR anchor).
	 *  Falls back to this process's own keypair so a manifest-stamped
	 *  responder always has SOME binding (same fallback as the lifecycle
	 *  host; public material only — w1a-safe). */
	dispatcherVerifyKey?: string;
	/** Depth-cap resolver (PI_CREW_MAX_DEPTH semantics) — injected so this
	 *  module stays free of the model-registry import chain at load time. */
	resolveMaxDepth: () => number;
}): Promise<RunnerHostedBrokerHandle | undefined> {
	const { runId, cwd } = input;
	if (typeof runId !== "string" || runId.length === 0) return undefined;
	if (!brokerEnabled(cwd)) return undefined;

	// Config reads mirror lifecycle-handlers.ts getOrStartBroker (same cwd
	// discipline — B1 battery 2026-08-18: loadConfig WITHOUT cwd silently
	// drops the workspace layer where broker.waitMethodsEnabled lives).
	const cfg = (() => {
		try {
			return loadConfig(cwd).config.broker;
		} catch {
			return undefined;
		}
	})();
	const nestingCfg = (() => {
		try {
			const c = loadConfig(cwd).config;
			return { nesting: c.nesting, limits: c.limits };
		} catch {
			return undefined;
		}
	})();

	const sessionId = `runner-${runId}`;
	const socketPath = input.socketPath ?? getBrokerSocketPath(sessionId);

	// HƯỚNG A CR anchor: the payload key wins (the true dispatcher); a run
	// dispatched without one still gets a self-consistent binding. Bind it in
	// the registry too so broker-side CR verification and any in-process
	// responders agree on ONE anchor.
	const verifyKey = input.dispatcherVerifyKey ?? getActiveDispatcherVerifyKey() ?? ensureCoordinationPublicVerifyKey();
	setActiveDispatcherVerifyKey(verifyKey);

	const broker = new CrewBroker({
		sessionId,
		socketPath,
		maxFrameBytes: cfg?.maxFrameBytes ?? 262144,
		outboundQueueCap: cfg?.outboundQueueCap ?? 256,
		waitMethodsEnabled: cfg?.waitMethodsEnabled ?? false,
		nestingEnabled: nestingCfg?.nesting?.enabled ?? false,
		...(nestingCfg?.nesting?.maxSlots !== undefined ? { nestingMaxSlots: nestingCfg.nesting.maxSlots } : {}),
		...(nestingCfg?.nesting?.maxDepth !== undefined ? { nestingMaxDepth: nestingCfg.nesting.maxDepth } : {}),
		nestingTrustedEscalation: nestingCfg?.nesting?.enabled === true,
		...(nestingCfg?.limits?.maxConcurrentWorkers !== undefined
			? { globalWorkerSemaphore: nestingCfg.limits.maxConcurrentWorkers }
			: {}),
		serializeOnPathOverlap: nestingCfg?.limits?.serializeOnPathOverlap ?? false,
		dispatcherVerifyKey: verifyKey,
		modelCatalog: () => {
			try {
				return configuredModelInfosFromPiConfig(cwd).map((info) => info.fullId);
			} catch {
				return undefined;
			}
		},
		enabled: true,
		cwd,
	});

	try {
		await broker.start();
	} catch (error) {
		logInternalError(
			"runner-broker.start.failed",
			error instanceof Error ? error : new Error(String(error)),
			`runId=${runId} socket=${socketPath}`,
		);
		// Soft-fail: best-effort stop to release anything partially bound.
		await broker.stop().catch(() => {});
		return undefined;
	}

	// Payload-parity token cache: repeated spawns of the SAME task reuse the
	// SAME compound token (the stdin issuer served one pre-mint per task). A
	// revokeTaskToken (surface-degrade T10) + re-ask cycle mints a fresh one.
	const mintedTokens = new Map<string, string>();

	const issueForChild = async (rid: string, taskId?: string, childDepth?: number): Promise<BrokerSpawnCredentials | undefined> => {
		if (rid !== runId) return undefined;
		if (childDepth !== undefined && childDepth >= input.resolveMaxDepth()) return undefined;
		// w1a fail-closed: no taskId → no creds (mirrors both prior issuers).
		if (!taskId) return undefined;
		const cached = mintedTokens.get(taskId);
		if (cached !== undefined) return { socketPath, token: cached };
		const token = broker.issueRunToken(rid, taskId);
		mintedTokens.set(taskId, token);
		return { socketPath, token };
	};

	return {
		broker,
		socketPath,
		issueForChild,
		stop: async () => {
			mintedTokens.clear();
			await broker.stop();
		},
	};
}
