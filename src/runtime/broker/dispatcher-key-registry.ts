/**
 * dispatcher-key-registry.ts — HƯỚNG A (ADR Option 3, 2026-11-01): process-local
 * registry holding the DISPATCHER's PUBLIC coordination verify key for
 * broker-side `respond.append` challenge-response auth.
 *
 * Who writes:
 *   - The detached background runner bootstrap (background-runner.ts) when the
 *     spawning (dispatcher) process threaded its public key over the stdin
 *     start-options handshake (async-runner.ts → buildBrokerStdinLine). The key
 *     is derived in the SPAWNER's heap via ensureCoordinationPublicVerifyKey()
 *     — it is NEVER sourced from the manifest file (unauthenticated,
 *     worker-writable; w1a NO-GO) and never from env.
 *   - Nothing else. No broker method can write it.
 *
 * Who reads:
 *   - The broker lifecycle controller (lifecycle-handlers.ts) at CrewBroker
 *     CONSTRUCT time, binding the value heap-only on the broker instance
 *     (CrewBrokerOptions.dispatcherVerifyKey). When no value is registered the
 *     constructing process IS the dispatcher (broker host == dispatcher in
 *     both sync and async dispatch today) and binds its own public key.
 *
 * Mirrors broker-issuer.ts: module-level singleton, PUBLIC material only (a
 * base64 SPKI DER Ed25519 verify key — non-secret, but its AUTHORITY is the
 * trust anchor for respond.append, so it still never touches disk/env/logs).
 * Cleared only by process exit (binding is lifetime-of-process by design).
 */

let activeDispatcherVerifyKey: string | undefined;

/** Register the dispatcher public verify key (base64 SPKI DER). Undefined clears. */
export function setActiveDispatcherVerifyKey(key: string | undefined): void {
	activeDispatcherVerifyKey = typeof key === "string" && key.length > 0 ? key : undefined;
}

/** Read the registered dispatcher public verify key, if any. Returns undefined
 *  when this process was never handed one (root dispatcher host — bind own key). */
export function getActiveDispatcherVerifyKey(): string | undefined {
	return activeDispatcherVerifyKey;
}
