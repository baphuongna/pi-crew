import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageTool, type MessageToolDeps, shouldRegisterMessageTool } from "../../../src/prompt/message-tool.ts";

type MessageClient = ReturnType<NonNullable<MessageToolDeps["makeBrokerClient"]>>;

function harness() {
	const sent: { method: string; params: Record<string, unknown> }[] = [];
	const tool = createMessageTool({
		makeBrokerClient: () => {
			const client: MessageClient = {
				request: async (method: string, params: Record<string, unknown>) => {
					sent.push({ method, params });
					return { ok: true as const, value: {} };
				},
			};
			return client;
		},
	});
	return { tool, sent };
}

/** harness + injectable clock (rate-limit / sliding-window tests). */
function harness2(now: () => number) {
	const sent: { method: string; params: Record<string, unknown> }[] = [];
	const tool = createMessageTool({
		now,
		makeBrokerClient: () => {
			const client: MessageClient = {
				request: async (method: string, params: Record<string, unknown>) => {
					sent.push({ method, params });
					return { ok: true as const, value: {} };
				},
			};
			return client;
		},
	});
	return { tool, sent };
}

test("message notify parent goes through broker msg.send", async () => {
	const { tool, sent } = harness();
	const r = await tool.execute({ to: "parent", kind: "notify", body: "milestone: parser done" });
	assert.equal(r.status, "sent");
	assert.equal(sent[0]!.method, "msg.send");
	assert.equal(sent[0]!.params.kind, "notify");
});

test("message DM targets a sibling taskId", async () => {
	const { tool, sent } = harness();
	await tool.execute({ to: "03_execute", kind: "message", subject: "api shape", body: "use parseArgs(cmd) not argv" });
	assert.equal(sent[0]!.params.to, "03_execute");
});

test("rate limit: 11th message within window warns instead of sending", async () => {
	// Injectable now() — forces all 11 calls inside the 60s sliding window.
	let clock = 1_000_000;
	const { tool, sent } = harness2(() => clock);
	for (let i = 0; i < 11; i++) {
		const r = await tool.execute({ to: "parent", kind: "notify", body: `n${i}` });
		if (i === 10) {
			assert.equal(r.status, "rate-limited", "11th message is rate-limited");
			assert.match(r.text, /rate-limited/);
		}
	}
	assert.equal(sent.length, 10, "first 10 sent");
	// A message outside the window is allowed again.
	clock = 1_000_000 + 61_000;
	const after = await tool.execute({ to: "parent", kind: "notify", body: "late" });
	assert.equal(after.status, "sent");
	assert.equal(sent.length, 11, "window expiry frees a slot");
});

test("dormant gate: shouldRegisterMessageTool honors PI_CREW_MSG_ENABLED", () => {
	assert.equal(shouldRegisterMessageTool({}), false);
	assert.equal(shouldRegisterMessageTool({ PI_CREW_MSG_ENABLED: "0" }), false);
	assert.equal(shouldRegisterMessageTool({ PI_CREW_MSG_ENABLED: "1" }), true);
});

test("dormant without env + production-like no broker env → structured notice, no hang", async () => {
	// Dormant: env off, no injected client.
	const dormant = await createMessageTool().execute({ to: "parent", kind: "notify", body: "x" });
	assert.equal(dormant.status, "unavailable");
	assert.match(dormant.text, /dormant/);
	// Env on but broker creds absent (scaffold/mock worker) → broker unavailable,
	// immediate structured notice — never a hang.
	const clientless = createMessageTool({ env: { PI_CREW_MSG_ENABLED: "1" } });
	const r = await clientless.execute({ to: "parent", kind: "notify", body: "x" });
	assert.equal(r.status, "unavailable");
	assert.match(r.text, /broker unavailable/);
});
