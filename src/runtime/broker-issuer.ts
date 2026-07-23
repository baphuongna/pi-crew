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

/** Issuer signature: given a runId, return credentials or undefined when the
 *  broker is disabled / this process is not the root session. */
export type BrokerIssuer = (runId: string) => Promise<BrokerSpawnCredentials | undefined>;

let activeIssuer: BrokerIssuer | undefined;

/** Register the active issuer (called by the lifecycle controller on start). */
export function setActiveBrokerIssuer(issuer: BrokerIssuer | undefined): void {
	activeIssuer = issuer;
}

/** Read the active issuer, if any. Returns undefined when no broker is wired. */
export function getActiveBrokerIssuer(): BrokerIssuer | undefined {
	return activeIssuer;
}
