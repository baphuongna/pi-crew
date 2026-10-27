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
import { getCrewEnv } from "../../config/env-vars.ts";
import { type BrokerEventFrame, CrewBrokerClient, type CrewBrokerClientOptions } from "./crew-broker-client.ts";
import { parseStdinBrokerPayload, readStdinFirstLine } from "./stdin-handshake.ts";

export interface ChildBrokerClientHandle {
	/** True once the client has completed the handshake. */
	readonly active: boolean;
	/** Tear down the connection. Idempotent. */
	close(): Promise<void>;
}

export interface StartChildBrokerClientOptions {
	/** Env source (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/** Invoked with the raw (untrusted) steer body and optional message id for
	 *  every pushed `mailbox.message` whose kind === "steer". The caller MUST
	 *  sanitize before delivering to the agent and may use `id` for dedup. */
	onSteer?: (message: string, id?: string) => void;
	/** Optional observer for every received event frame (diagnostics/tests). */
	onEvent?: (event: BrokerEventFrame) => void;
	/** Test seam: override the net module. */
	netModule?: typeof net;
	/** Test seam: override client construction. */
	clientFactory?: (opts: CrewBrokerClientOptions) => CrewBrokerClient;
	/** Test seam: override the stdin first-line read for the LOW-1 fallback
	 *  (defaults to stdin-handshake.readStdinFirstLine on real process.stdin). */
	readStdinLine?: () => Promise<string | undefined>;
}

const NOOP_HANDLE: ChildBrokerClientHandle = {
	active: false,
	close: async () => undefined,
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
				const data = ev.data as { id?: unknown; kind?: unknown; body?: unknown } | undefined;
				if (data && data.kind === "steer" && typeof data.body === "string") {
					options.onSteer(data.body, typeof data.id === "string" ? data.id : undefined);
				}
			}
		},
	});

	// Establish the persistent connection so the broker can push events. This
	// is fire-and-forget: on any failure the client becomes sticky-fallback and
	// the file-poll steering path remains fully functional.
	void client.reconnect().catch(() => undefined);

	return {
		get active() {
			return client.mode === "connected";
		},
		close: async () => {
			await client.close();
		},
	};
}

/** True when this process was booted as an RPC-mode worker (pi --mode rpc):
 * its stdin IS the JSONL protocol channel and must never be consumed by the
 * credential handshake. Those spawns keep the token in env (the RPC branch of
 * child-pi.ts never strips it), so the fallback below is unreachable there
 * anyway — this guard is defense-in-depth against hybrid/old-parent skew. */
function argvIndicatesRpcMode(): boolean {
	return process.argv.includes("--mode") && process.argv.includes("rpc");
}

/** LOW-1 residual closure (2026-10-27): async wrapper used by the worker
 * bootstrap (prompt-runtime Feature 2b). Identical contract to
 * {@link startChildBrokerClient}, plus: when the env token is ABSENT but the
 * socket/run/task identity env IS present (new parent on the stdin-handshake
 * default), read the single buildBrokerStdinLine payload off stdin (bounded,
 * never throws) and merge the per-task token into a COPY of the env before
 * connecting. Ordering matrix:
 *   - new parent + new worker → token via stdin (env stays secret-free);
 *   - old parent → new worker → env token present → env route, stdin untouched;
 *   - new parent + PI_CREW_BROKER_STDIN=0 → env token present → env route;
 *   - payload missing/invalid/wrong-run/socket-mismatch → creds-less no-op
 *     handle (same as today), never a throw.
 * The sync {@link startChildBrokerClient} stays untouched (env-only) so every
 * existing caller/test keeps its exact behavior. */
export async function startChildBrokerClientAsync(options: StartChildBrokerClientOptions = {}): Promise<ChildBrokerClientHandle> {
	let env = options.env ?? process.env;
	const socketPath = env.PI_CREW_BROKER_SOCKET;
	const runId = env.PI_CREW_BROKER_RUN_ID;
	const taskId = env.PI_CREW_BROKER_TASK_ID;
	if (socketPath && runId && taskId && !env.PI_CREW_BROKER_TOKEN && resolveBrokerStdinFallbackEnabled() && !argvIndicatesRpcMode()) {
		try {
			const raw = await (options.readStdinLine ?? readStdinFirstLine)();
			const payload = raw ? parseStdinBrokerPayload(raw, runId) : undefined;
			// socketPath cross-check: the payload must describe the SAME socket the
			// parent announced via env (both are parent-controlled, but a mismatch
			// means skew/garbage — refuse rather than connect with mixed creds).
			const token = payload?.socketPath === socketPath ? payload.tasks[taskId] : undefined;
			if (token) {
				env = { ...env, PI_CREW_BROKER_TOKEN: token };
			}
		} catch {
			/* best-effort: fall through creds-less (previous behavior) */
		}
	}
	return startChildBrokerClient({ ...options, env });
}

/** Worker-side mirror of the parent gate (child-pi-spawn
 * .resolveBrokerStdinHandshakeEnabled). **OPT-IN since v0.11.48** (live
 * battery caught the reader path killing real headless workers — see the
 * parent gate's doc block): the default is now OFF, so a new parent that set
 * the env token travels the legacy env route. PI_CREW_BROKER_STDIN=1 opts
 * BOTH sides into the stdin route. */
function resolveBrokerStdinFallbackEnabled(): boolean {
	return getCrewEnv("PI_CREW_BROKER_STDIN") === "1";
}
