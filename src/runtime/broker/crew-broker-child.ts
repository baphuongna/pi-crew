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
import { BROKER_HANDSHAKE_FD, parseStdinBrokerPayload, readFirstLineFromFd } from "./stdin-handshake.ts";

export interface ChildBrokerClientHandle {
	/** True once the client has completed the handshake. */
	readonly active: boolean;
	/** Tear down the connection. Idempotent. */
	close(): Promise<void>;
}

/** LOW-1 guard closure (2026-10-30, live-caught by the real-test battery):
 * credentials resolved from the fd3 handshake pipe, for the worker-side
 * tool guards (ask/delegate/message in prompt-runtime + message-tool). Under
 * the DEFAULT-ON fd3 route the token is DELIBERATELY absent from env
 * (sanitizeEnvSecrets posture) — the tools must not treat env-token absence
 * as "no broker" when the bootstrap already resolved a token off fd3. */
export interface ResolvedChildBrokerCreds {
	socketPath: string;
	token: string;
	runId: string;
	taskId: string;
}

let resolvedCreds: Promise<ResolvedChildBrokerCreds | undefined> = Promise.resolve(undefined);

/** The fd3-resolved credentials, or undefined when the bootstrap never
 *  resolved any (scaffold/mock runs, opt-out env route — env-route runs keep
 *  their token in env and never need this). Settles with the bootstrap's own
 *  bounded (≤2s) fd3 read; never rejects. */
export function resolvedChildBrokerCreds(): Promise<ResolvedChildBrokerCreds | undefined> {
	return resolvedCreds;
}

/** @internal Test seam: install a settled resolved-creds value. */
export function __test_setResolvedChildBrokerCreds(creds: ResolvedChildBrokerCreds | undefined): void {
	resolvedCreds = Promise.resolve(creds);
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
	/** Test seam: override the handshake first-line read for the LOW-1 fd3
	 *  fallback (defaults to stdin-handshake.readFirstLineFromFd(3) on the
	 *  dedicated spawn stdio pipe — NOT fd0, which pi owns for its prompt). */
	readHandshakeLine?: () => Promise<string | undefined>;
}

const NOOP_HANDLE: ChildBrokerClientHandle = {
	active: false,
	close: async () => undefined,
};

export function startChildBrokerClient(options: StartChildBrokerClientOptions = {}): ChildBrokerClientHandle {
	const env = options.env ?? process.env;
	const socketPath = getCrewEnv("PI_CREW_BROKER_SOCKET", env);
	const token = getCrewEnv("PI_CREW_BROKER_TOKEN", env);
	const runId = getCrewEnv("PI_CREW_BROKER_RUN_ID", env);
	const taskId = getCrewEnv("PI_CREW_BROKER_TASK_ID", env);
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
 * anyway — this guard is defense-in-depth against hybrid/old-parent skew.
 * FIX-2 (2026-10-28): match BOTH argv spellings — the pi-args builder emits
 * the two-argv form ("--mode rpc"), but wrappers/users can pass the equals
 * form ("--mode=rpc"); a spelling miss here would let the fallback eat a
 * protocol line off the RPC JSONL channel. */
function argvIndicatesRpcMode(): boolean {
	return process.argv.includes("--mode=rpc") || (process.argv.includes("--mode") && process.argv.includes("rpc"));
}

/** LOW-1 residual closure (2026-10-27): async wrapper used by the worker
 * bootstrap (prompt-runtime Feature 2b). Identical contract to
 * {@link startChildBrokerClient}, plus: when the env token is ABSENT but the
 * socket/run/task identity env IS present (gate-ON parent on the fd3 route —
 * FIX-1 re-writes the flag into the child's built.env, without which this
 * fallback was dead-wired), read the single buildBrokerStdinLine payload off
 * the DEDICATED fd3 handshake pipe (bounded, never throws) and merge the
 * per-task token into a COPY of the env before connecting. FD-3
 * (2026-10-28, root-cause fix): pi@1.0.4 readPipedStdin consumes ALL piped
 * fd0 bytes as PROMPT CONTENT in every mode except --mode rpc — the old
 * fd0 handshake raced it three ways (token JSON leaked into the worker
 * prompt; creds-less silence; pause() deadlock → SIGTERM exit 0 with ~0
 * stdout — the 0.11.46/47 live incident), so the spawner now writes the
 * payload to a dedicated stdio[3] pipe and this reader reads fd 3, never
 * fd0. Ordering matrix (post FIX-1, 2026-10-28; DEFAULT-ON flip same day —
 * the gate is ON unless the exact value '0' opts out, and the spawner writes
 * flag + token into built.env for every brokered spawn; only the headless
 * JSON compose strips the token):
 *   - default parent (gate ON — unset/'1'/any non-'0') + headless JSON worker
 *     → flag set, token ABSENT from env → token via fd3 (env stays secret-free);
 *   - gate-ON parent + RPC / surface worker → flag set, token PRESENT in env
 *     → env route, fd3 untouched (their stdin is the protocol channel/TTY);
 *   - opt-out parent (PI_CREW_BROKER_STDIN=0) → no flag write, env token
 *     present → env route (and even if the token were missing, the mirror
 *     gate's '0' check disarms the fd3 read);
 *   - payload missing/invalid/wrong-run/socket-mismatch/unreadable fd3 →
 *     creds-less no-op handle (same as today), never a throw.
 * The sync {@link startChildBrokerClient} stays untouched (env-only) so every
 * existing caller/test keeps its exact behavior. */
export async function startChildBrokerClientAsync(options: StartChildBrokerClientOptions = {}): Promise<ChildBrokerClientHandle> {
	let env = options.env ?? process.env;
	const socketPath = getCrewEnv("PI_CREW_BROKER_SOCKET", env);
	const runId = getCrewEnv("PI_CREW_BROKER_RUN_ID", env);
	const taskId = getCrewEnv("PI_CREW_BROKER_TASK_ID", env);
	if (
		socketPath &&
		runId &&
		taskId &&
		!getCrewEnv("PI_CREW_BROKER_TOKEN", env) &&
		resolveBrokerStdinFallbackEnabled(env) &&
		!argvIndicatesRpcMode()
	) {
		try {
			const raw = await (options.readHandshakeLine ?? (() => readFirstLineFromFd(BROKER_HANDSHAKE_FD)))();
			const payload = raw ? parseStdinBrokerPayload(raw, runId) : undefined;
			// socketPath cross-check: the payload must describe the SAME socket the
			// parent announced via env (both are parent-controlled, but a mismatch
			// means skew/garbage — refuse rather than connect with mixed creds).
			const token = payload?.socketPath === socketPath ? payload.tasks[taskId] : undefined;
			if (token) {
				env = { ...env, PI_CREW_BROKER_TOKEN: token };
				// LOW-1 guard closure: publish the resolved creds so the ask/delegate/
				// message tool guards (which read env) can bridge to the fd3 token
				// instead of mis-reporting "no broker" under the default-on route.
				resolvedCreds = Promise.resolve({ socketPath, token, runId, taskId });
			}
		} catch {
			/* best-effort: fall through creds-less (previous behavior) */
		}
	}
	return startChildBrokerClient({ ...options, env });
}

/** Worker-side mirror of the parent gate (child-pi-spawn
 * .resolveBrokerStdinHandshakeEnabled). **DEFAULT-ON since 2026-10-28** (was
 * OPT-IN v0.11.48–0.11.49, after the live battery caught the original fd0
 * reader path killing real headless workers — see the parent gate's doc
 * block; the v0.11.49 fd3 transport removed that race): the default is ON,
 * so an unset flag arms the fd3 fallback whenever the identity env is
 * present and the env token is absent. PI_CREW_BROKER_STDIN=0 opts BOTH
 * sides out (the spawner then writes the env token instead — legacy env
 * route). FIX-1 (2026-10-28): the spawner re-writes the flag "1" into the
 * child's built.env ("child-write" registry kind), so a gate-ON parent
 * reaches pre-flip workers too (their mirror still reads === "1") and the
 * child route is pinned deterministically.
 * Seam (2026-10-28): the gate reads the RESOLVED env — the same source as
 * the identity vars above (`options.env ?? process.env`, threaded through
 * getCrewEnv's env param) — so spawn-env delivery (FIX-1 writes the flag
 * into the child's built.env) is pinnable in tests via options.env without
 * mutating process.env. */
function resolveBrokerStdinFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return getCrewEnv("PI_CREW_BROKER_STDIN", env) !== "0";
}
