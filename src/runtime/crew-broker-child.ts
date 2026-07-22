/**
 * crew-broker-child.ts — Child-side broker bootstrap.
 *
 * Runs INSIDE a child pi worker (via prompt-runtime). When the parent injected
 * broker credentials (`PI_CREW_BROKER_SOCKET` + `PI_CREW_BROKER_TOKEN` +
 * `PI_CREW_BROKER_RUN_ID` + `PI_CREW_BROKER_TASK_ID`), it constructs a
 * `CrewBrokerClient`, establishes the persistent connection, and routes
 * pushed `mailbox.message` steer frames to the caller's `onSteer` handler
 * (which sanitizes + delivers via `pi.sendMessage`).
 *
 * If any credential is absent (the default — flag off / not wired), this is a
 * no-op: the child keeps using the file-poll steering path. The broker socket
 * is a latency accelerator layered ON TOP of the durable file path, never a
 * replacement — so a connect failure is invisible to the worker.
 */

import type * as net from "node:net";
import { type BrokerEventFrame, CrewBrokerClient, type CrewBrokerClientOptions } from "./crew-broker-client.ts";

export interface ChildBrokerClientHandle {
	/** True once the client has completed the handshake. */
	readonly active: boolean;
	/** Tear down the connection. Idempotent. */
	close(): Promise<void>;
}

export interface StartChildBrokerClientOptions {
	/** Env source (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** Invoked with the raw (untrusted) steer body for every pushed
	 *  `mailbox.message` whose kind === "steer". The caller MUST sanitize
	 *  before delivering to the agent. */
	onSteer?: (message: string) => void;
	/** Optional observer for every received event frame (diagnostics/tests). */
	onEvent?: (event: BrokerEventFrame) => void;
	/** Test seam: override the net module. */
	netModule?: typeof net;
	/** Test seam: override client construction. */
	clientFactory?: (opts: CrewBrokerClientOptions) => CrewBrokerClient;
}

const NOOP_HANDLE: ChildBrokerClientHandle = {
	active: false,
	close: async () => {},
};

export function startChildBrokerClient(options: StartChildBrokerClientOptions = {}): ChildBrokerClientHandle {
	const env = options.env ?? process.env;
	const socketPath = env.PI_CREW_BROKER_SOCKET;
	const token = env.PI_CREW_BROKER_TOKEN;
	const runId = env.PI_CREW_BROKER_RUN_ID;
	const taskId = env.PI_CREW_BROKER_TASK_ID;
	if (!socketPath || !token || !runId || !taskId) {
		return NOOP_HANDLE;
	}

	const factory = options.clientFactory ?? ((o: CrewBrokerClientOptions) => new CrewBrokerClient(o));
	const client = factory({
		runId,
		taskId,
		socketPath,
		token,
		netModule: options.netModule,
		onEvent: (ev) => {
			options.onEvent?.(ev);
			if (ev.event === "mailbox.message" && options.onSteer) {
				const data = ev.data as { kind?: unknown; body?: unknown } | undefined;
				if (data && data.kind === "steer" && typeof data.body === "string") {
					options.onSteer(data.body);
				}
			}
		},
	});

	// Establish the persistent connection so the broker can push events. This
	// is fire-and-forget: on any failure the client becomes sticky-fallback and
	// the file-poll steering path remains fully functional.
	void client.reconnect().catch(() => {});

	return {
		get active() {
			return client.mode === "connected";
		},
		close: async () => {
			await client.close();
		},
	};
}
