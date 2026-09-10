/**
 * connection-state.ts — Type definitions for crew-broker connection state
 * and broker options.
 *
 * Moved from crew-broker.ts (M4 / WI-4.1) — pure move, no behavior change.
 * These are pure types/interfaces used by the CrewBroker class but they
 * contribute ~80 lines to the file's line count. Splitting them out
 * contributes to the ≤2000-line gate (spec §5 M4 acceptance).
 */

import type * as net from "node:net";
import type { NdjsonDecoder } from "../../../utils/ndjson.ts";
import type { GrandchildSpawnInput, GrandchildSpawnResult } from "../../delegate-spawn.ts";
import type { WaitStatusCache } from "../wait-status-cache.ts";

export interface CrewBrokerOptions {
	/** Root session ID used to derive the socket path. */
	sessionId: string;
	/** Pre-resolved socket path (skips re-derivation; useful for tests). */
	socketPath?: string;
	/** Frame cap in UTF-8 bytes. Default 256 KiB. */
	maxFrameBytes?: number;
	/** Per-connection outbound queue cap. Default 256. */
	outboundQueueCap?: number;
	/** Required: when false, start() is a no-op and the server never binds.
	 *  Lets the lifecycle controller install the broker unconditionally and
	 *  have a single kill switch. */
	enabled: boolean;
	/** CWD for `loadRunManifestById` (Phase 1 msg.send / msg.inbox resolution).
	 *  When omitted, manifest-touching methods return no-manifest errors. */
	cwd?: string;
	/** Optional test seam: override the `net` module (allows fake-server tests). */
	netModule?: typeof net;
	/** Optional test seam: inject a pre-configured WaitStatusCache (e.g. one
	 *  wrapping a loader spy). Production uses a plain cache — see
	 *  wait-status-cache.ts (R10-3). */
	waitStatusCache?: WaitStatusCache;
	/** WP-2/R2 (ADR-0 2026-08-17-waiting-producer-ask item 7): capability
	 *  gate for the `wait.*` methods. DEFAULT FALSE — fail-closed. When not
	 *  explicitly true, wait.request/wait.resolve are rejected with a
	 *  `policy-disabled` error AND a `policy.action` event is appended to the
	 *  run's events.jsonl (never silent). The production wiring threads
	 *  `config.broker.waitMethodsEnabled` here; tests pass it explicitly. */
	waitMethodsEnabled?: boolean;
	/** T3/R5 (ADR-5 §10): capability gate for the `delegate` surface. DEFAULT
	 *  TRUE since D8 (spec v0.7) — nested spawning is open out of the box; the
	 *  broker still fail-closes when the flag is anything but true. The
	 *  production wiring threads `config.nesting.enabled` (loadConfig layers
	 *  DEFAULT_NESTING.enabled=true; a user `false` closes the surface); tests
	 *  pass it explicitly. Rejections are NEVER silent (delegate.rejected). */
	nestingEnabled?: boolean;
	/** Optional override for the nested-slot budget size (config nesting.maxSlots). */
	nestingMaxSlots?: number;
	nestingMaxDepth?: number;
	nestingTrustedEscalation?: boolean;
	/** Global worker semaphore size, used to size the nested-slot budget. */
	globalWorkerSemaphore?: number;
	/** Test seam / alternative spawner for delegate grandchildren. Production
	 *  uses spawnDelegateGrandchild (direct runChildPi call-site, ADR-5 §2). */
	grandchildSpawner?: (input: GrandchildSpawnInput) => Promise<GrandchildSpawnResult>;
	/** Resolved model catalog (canonical provider/id strings) for admission-time
	 *  model validation (ADR-5 §7). When omitted, model validation is skipped
	 *  (documented gap — the production wiring must always supply it). */
	modelCatalog?: () => string[] | undefined;
	/** ADR-5 §9: mirrors config limits.serializeOnPathOverlap for the workspace
	 *  admission gate. Default false. */
	serializeOnPathOverlap?: boolean;
}

/** Per-connection server-side state. */
export interface ServerConnection {
	socket: net.Socket;
	decoder: NdjsonDecoder;
	/** Whether the connection has completed `hello` successfully. */
	authed: boolean;
	/** Run id bound by hello. */
	runId?: string;
	/** Task id bound by hello. */
	taskId?: string;
	/** Role bound by hello: orchestrator can steer/msg-send; workers default. */
	role?: "orchestrator" | "worker";
	/** How the hello token matched the registry (ADR-0 item 6). Derived,
	 *  non-secret metadata recorded at hello time so `wait.*` can reject a
	 *  legacy bare-runId fallback match WITHOUT keeping the raw token on the
	 *  connection (tokens stay confined to the heap-only registry). */
	authMatchKind?: "compound" | "runId-fallback";
	/** Task 10 fix round 2 (BUG #3): sha256 of the secret this connection
	 *  authenticated with. Derived, one-way — never the plaintext token. The
	 *  post-hello revocation check evaluates THIS digest so a revoke →
	 *  re-issue window cannot let an old connection ride the freshly issued
	 *  token for the same key. */
	authedSecretHash?: string;
	/** Outbound queue of encoded frames awaiting drain. */
	outbound: Buffer[];
	/** Set when the queue has hit the cap and a frame was dropped. */
	needsResync: boolean;
	/** Set when the connection is closing (idempotent). */
	closed: boolean;
	/** Timer for the hello deadline. */
	helloTimer: NodeJS.Timeout | null;
	/** Monotonic seq counter for outbound events (diagnostic). */
	outboundSeq: number;
}
