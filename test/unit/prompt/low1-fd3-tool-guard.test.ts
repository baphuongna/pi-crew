/**
 * LOW-1 guard closure (2026-10-30, live-caught by the real-test battery):
 * under the DEFAULT-ON fd3 broker-credential route the token is DELIBERATELY
 * absent from the worker env (child-pi-spawn strips it; the token rides the
 * dedicated fd3 pipe and startChildBrokerClientAsync resolves it into a heap
 * copy). The ask/delegate/message tool guards read env and mis-reported
 * "no broker connection" — the tools were dead in every default-config real
 * session since the 0.11.50 LOW-1 flip. The closure bridges the guards to
 * resolvedChildBrokerCreds() (task-identity-matched).
 *
 * Live PoC shape (real fast-fix worker, 2026-10-30): env carried
 * PI_CREW_BROKER_SOCKET/TASK_ID/RUN_ID/STATE_ROOT + PI_CREW_BROKER_STDIN=1,
 * no PI_CREW_BROKER_TOKEN — ask answered "[ask] unavailable: no broker
 * connection … absent — scaffold or mock mode".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMessageTool } from "../../../src/prompt/message-tool.ts";
import { createAskTool, createDelegateTool } from "../../../src/prompt/prompt-runtime.ts";
import { __test_setResolvedChildBrokerCreds, type ResolvedChildBrokerCreds } from "../../../src/runtime/broker/crew-broker-child.ts";

const CREDS: ResolvedChildBrokerCreds = {
	socketPath: "/run/user/1000/pi-crew-battery.sock",
	token: "fd3-compound-token-battery",
	runId: "team_battery_low1",
	taskId: "01_exec",
};

function fd3Env(): Record<string, string> {
	// The LOW-1 default-on worker env: identity present, token absent.
	return {
		PI_CREW_ASK_ENABLED: "1",
		PI_CREW_DELEGATE_ENABLED: "1",
		PI_CREW_TASK_ID: CREDS.taskId,
		PI_CREW_BROKER_TASK_ID: CREDS.taskId,
		PI_CREW_BROKER_SOCKET: CREDS.socketPath,
		PI_CREW_BROKER_RUN_ID: CREDS.runId,
		PI_CREW_BROKER_STDIN: "1",
		PI_CREW_STATE_ROOT: "/tmp/battery-state-root",
	};
}

test("LOW-1: ask bridges to fd3-resolved creds when env token is absent", async () => {
	__test_setResolvedChildBrokerCreds(CREDS);
	try {
		const seen: Array<{ token?: string; socketPath?: string; runId?: string; taskId?: string }> = [];
		const tool = createAskTool({
			env: fd3Env(),
			makeBrokerClient: (opts) => {
				seen.push(opts);
				return {
					request: async () => ({
						ok: true,
						value: {
							ok: true,
							questionId: "q-battery",
							askedAt: new Date().toISOString(),
							deadline: Date.now() + 500,
							timeoutSec: 1,
							clamped: false,
						},
					}),
					close: async () => undefined,
				} as never;
			},
		});
		const res = (await tool.execute("tc-1", { question: "code word?", timeoutSec: 1 }, undefined, undefined, undefined as never)) as {
			content: Array<{ type: string; text: string }>;
			details?: { status?: string; errorCode?: string };
		};
		assert.notEqual(res.details?.errorCode, "no-broker", "must NOT fast-fail as no-broker");
		assert.equal(seen.at(-1)?.token, CREDS.token, "client received the fd3-resolved token");
		assert.equal(seen.at(-1)?.socketPath, CREDS.socketPath);
	} finally {
		__test_setResolvedChildBrokerCreds(undefined);
	}
});

test("LOW-1: ask still fast-fails when NO resolved creds exist (scaffold/mock preserved)", async () => {
	__test_setResolvedChildBrokerCreds(undefined);
	const tool = createAskTool({
		env: fd3Env(),
		makeBrokerClient: () => {
			throw new Error("guard must fast-fail before client construction");
		},
	});
	const res = (await tool.execute("tc-1", { question: "x?", timeoutSec: 1 }, undefined, undefined, undefined as never)) as {
		details?: { errorCode?: string };
	};
	assert.equal(res.details?.errorCode, "no-broker");
});

test("LOW-1: ask does NOT adopt creds minted for a DIFFERENT task identity", async () => {
	__test_setResolvedChildBrokerCreds({ ...CREDS, taskId: "99_other" });
	try {
		const tool = createAskTool({
			env: fd3Env(),
			makeBrokerClient: () => {
				throw new Error("guard must fast-fail on identity mismatch");
			},
		});
		const res = (await tool.execute("tc-1", { question: "x?", timeoutSec: 1 }, undefined, undefined, undefined as never)) as {
			details?: { errorCode?: string };
		};
		assert.equal(res.details?.errorCode, "no-broker");
	} finally {
		__test_setResolvedChildBrokerCreds(undefined);
	}
});

test("LOW-1: delegate bridges to fd3-resolved creds when env token is absent", async () => {
	__test_setResolvedChildBrokerCreds(CREDS);
	try {
		const seen: Array<{ token?: string; taskId?: string }> = [];
		const tool = createDelegateTool({
			env: fd3Env(),
			makeBrokerClient: (opts) => {
				seen.push(opts);
				return {
					request: async () => ({ ok: true, value: { grandchildTaskRef: "gc-battery", timeoutSec: 10 } }),
					close: async () => undefined,
				} as never;
			},
		});
		const res = (await tool.execute("tc-1", { prompt: "probe", description: "d" }, undefined, undefined, undefined as never)) as {
			content: Array<{ type: string; text: string }>;
		};
		const text = res.content?.[0]?.text ?? "";
		assert.ok(!text.includes("[delegate] unavailable: no broker"), `delegate must not report no-broker (got: ${text.slice(0, 120)})`);
		assert.equal(seen.at(-1)?.token, CREDS.token, "delegate client received the fd3 token");
	} finally {
		__test_setResolvedChildBrokerCreds(undefined);
	}
});

test("LOW-1: message bridges to fd3-resolved creds when env token is absent", async () => {
	__test_setResolvedChildBrokerCreds(CREDS);
	try {
		const env = fd3Env();
		delete env.PI_CREW_ASK_ENABLED;
		delete env.PI_CREW_DELEGATE_ENABLED;
		const saved: Record<string, string | undefined> = {};
		for (const k of Object.keys(env)) {
			saved[k] = process.env[k];
			process.env[k] = env[k];
		}
		try {
			const seen: Array<{ token?: string; taskId?: string }> = [];
			const tool = createMessageTool({
				makeBrokerClient: (opts: { runId: string; taskId: string; socketPath: string; token: string }) => {
					seen.push(opts);
					return {
						request: async () => ({ ok: true as const, value: {} }),
					};
				},
			});
			const res = await tool.execute({ to: "parent", kind: "notify", body: "battery" });
			assert.equal(res.status, "sent", `message must send (got ${JSON.stringify(res).slice(0, 140)})`);
			assert.equal(seen.at(-1)?.token, CREDS.token, "message client received the fd3 token");
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	} finally {
		__test_setResolvedChildBrokerCreds(undefined);
	}
});
