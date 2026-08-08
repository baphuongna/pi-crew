/**
 * Scratchpad spike — pi-rlm engine ported to Node.
 *
 * Barrel re-exporting the host engine and the shared transform/protocol
 * surface. The spike proves patterns 01 (namespace), 04 (transform), 05
 * (incremental bindings), 08 (snapshot) and 09 (revive) run on Node without
 * Bun. See README.md in this directory for how to run and what was proven.
 */

export type {
	EngineExecuteError,
	EngineOptions,
	ExecuteOptions,
	ExecuteResult,
	RestoreResult,
	SnapshotResult,
} from "./engine.ts";
export { EngineManager } from "./engine.ts";
export type { GuestToHostMessage, HostToGuestMessage } from "./protocol.ts";
export { decodeMessage, ENVELOPE_KEY, encodeMessage, NONCE_ENV, PROTOCOL_FD } from "./protocol.ts";
export type { TransformedCell, TransformOptions } from "./transform.ts";
export { transformCell } from "./transform.ts";
