import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionGuard } from "../../../../src/extension/registration/compaction-guard.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeHarness(options: { tokens?: number; idle?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const compactCalls: Array<{ onComplete?: () => void }> = [];
	let sendUserMessageCalls = 0;
	let tokens = options.tokens ?? 160_000;
	let idle = options.idle ?? false;
	const pi = {
		on: (event: string, handler: Handler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		appendEntry: () => undefined,
		sendUserMessage: () => {
			sendUserMessageCalls += 1;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: createTrackedTempDir("pi-crew-compaction-lifecycle-"),
		model: { contextWindow: 200_000 },
		getContextUsage: () => ({ tokens }),
		isIdle: () => idle,
		compact: (compactOptions: { onComplete?: () => void }) => {
			compactCalls.push(compactOptions);
		},
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
	registerCompactionGuard(pi, {
		foregroundControllers: new Map(),
		foregroundTeamRunControllers: new Map(),
	});
	return {
		compactCalls,
		fire(event: string) {
			for (const handler of handlers.get(event) ?? []) handler({}, ctx);
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setTokens(value: number) {
			tokens = value;
		},
		get sendUserMessageCalls() {
			return sendUserMessageCalls;
		},
	};
}

describe("compaction lifecycle", () => {
	it("does not call ctx.compact during a busy turn", () => {
		const harness = makeHarness({ idle: false, tokens: 195_000 });

		harness.fire("turn_end");

		assert.equal(harness.compactCalls.length, 0);
	});

	it("runs a deferred proactive compaction once at agent_settled", () => {
		const harness = makeHarness({ idle: false, tokens: 160_000 });
		harness.fire("turn_end");
		assert.equal(harness.compactCalls.length, 0, "busy turn must not be aborted");

		harness.setIdle(true);
		harness.fire("agent_settled");
		assert.equal(harness.compactCalls.length, 1, "idle settlement consumes the deferred request");

		harness.compactCalls[0]?.onComplete?.();
		harness.fire("agent_settled");
		assert.equal(harness.compactCalls.length, 1, "deferred request is consumed exactly once");
	});

	it("does not send a synthetic user message after session_compact", () => {
		const harness = makeHarness({ idle: true });

		harness.fire("session_compact");

		assert.equal(harness.sendUserMessageCalls, 0);
	});

	it("drops a deferred request when usage falls below the threshold before settlement", () => {
		const harness = makeHarness({ idle: false, tokens: 160_000 });
		harness.fire("turn_end");
		harness.setTokens(100_000);
		harness.setIdle(true);

		harness.fire("agent_settled");

		assert.equal(harness.compactCalls.length, 0);
	});
});
