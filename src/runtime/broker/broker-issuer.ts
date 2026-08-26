/**
 * broker-issuer.ts — Process-local registry for the active broker credential
 * issuer.
 *
 * The broker lifecycle controller (parent/root session) registers its
 * `issueForChild` function here on start and clears it on stop. `runChildPi`
 * reads it as the default `brokerIssuer` so the spawn path does not need the
 * registration context threaded through every runner call site.
 *
 * This mirrors the existing module-level singletons in the codebase
 * (`runEventBus`, the mailbox append observers). It lives ONLY in the parent
 * process — children never register an issuer (they receive credentials via
 * env). The value is a function reference, never a token; nothing here is
 * persisted or logged.
 */

/** Credentials handed to a child worker so it can authenticate to the broker. */
export interface BrokerSpawnCredentials {
	socketPath: string;
	token: string;
}

/** Issuer signature: given a runId (+optional taskId for per-task tokens),
 *  return credentials or undefined when the broker is disabled / this process
 *  is not the root session. taskId is optional for backward compat — callers
 *  that still pass only runId receive the legacy per-run token.
 *
 *  ADR-5 §4 (governed nesting): `childDepth` carries the DEPTH-2+ grandchild's
 *  depth when the root-side delegate handler spawns it. The issuer mints only
 *  for children that may themselves delegate (childDepth < resolved
 *  PI_CREW_MAX_DEPTH) — at the default maxDepth=4 a depth-4 grandchild gets NO
 *  credentials (env containment AC: no PI_CREW_BROKER_SOCKET/TOKEN at the cap
 *  depth).
 *  Undefined childDepth = legacy worker spawn (depth 1) — unchanged behavior. */
export type BrokerIssuer = (runId: string, taskId?: string, childDepth?: number) => Promise<BrokerSpawnCredentials | undefined>;

let activeIssuer: BrokerIssuer | undefined;

/** Register the active issuer (called by the lifecycle controller on start). */
export function setActiveBrokerIssuer(issuer: BrokerIssuer | undefined): void {
	activeIssuer = issuer;
}

/** Read the active issuer, if any. Returns undefined when no broker is wired. */
export function getActiveBrokerIssuer(): BrokerIssuer | undefined {
	return activeIssuer;
}

/**
 * MuxSurface A1 (spec §7 D3 step 2): process-local revoker for per-task tokens.
 * The team-runner's surface-degrade controller calls it when a pane is lost so
 * the zombie worker left in that pane can no longer authenticate to the broker;
 * the headless respawn mints a FRESH token (T10 re-issue).
 *
 * Same registration model as the issuer: the lifecycle controller publishes a
 * closure on start and clears it on stop, so the degrade path needs no wiring
 * through every runner layer. A function reference only — never a token.
 */
export type BrokerRevoker = (taskId: string) => void;

let activeRevoker: BrokerRevoker | undefined;

/** Register the active revoker (called by the lifecycle controller on start). */
export function setActiveBrokerRevoker(revoker: BrokerRevoker | undefined): void {
	activeRevoker = revoker;
}

/** Read the active revoker, if any. Returns undefined when no broker is wired. */
export function getActiveBrokerRevoker(): BrokerRevoker | undefined {
	return activeRevoker;
}
