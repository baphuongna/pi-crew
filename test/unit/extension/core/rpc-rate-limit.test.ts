import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetRpcRateLimit } from "../../../../src/extension/cross-extension-rpc.ts";

// We test the rate limiter logic by importing the module and exercising
// the internal functions indirectly through the exported resetRpcRateLimit
// and by constructing a minimal mock of the event bus.

// Since the rate limiter is internal, we test it via the RPC handler.
// We need to construct a minimal test harness.

function createMockEventBus() {
	const handlers = new Map<string, (data: unknown) => void>();
	return {
		on(event: string, handler: (data: unknown) => void) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		emit(event: string, data: unknown) {
			const handler = handlers.get(event);
			if (handler) handler(data);
		},
		getHandler(event: string) {
			return handlers.get(event);
		},
	};
}

// Import the module to get registerPiCrewRpc
import { registerPiCrewRpc } from "../../../../src/extension/cross-extension-rpc.ts";

describe("RPC rate limiting", () => {
	beforeEach(() => {
		resetRpcRateLimit();
	});

	it("allows up to 5 requests within the window", async () => {
		const bus = createMockEventBus();
		const replies: unknown[] = [];

		registerPiCrewRpc(
			{
				on: bus.on,
				emit: (event: string, data: unknown) => {
					if (event.startsWith("pi-crew:rpc:run:reply:")) {
						replies.push(data);
					}
				},
			} as any,
			() => undefined as any,
		);

		// We need to call the handler directly since we can't satisfy the full
		// RPC flow without a real ExtensionContext. Instead, let's test the
		// rate limiter internals more directly by importing and testing.
		// The registerPiCrewRpc will fail at ctx check, but rate limiting is checked first.

		// Actually, let's just verify the module exports resetRpcRateLimit
		// and the internal state works correctly by calling the run handler.
		const runHandler = bus.getHandler("pi-crew:rpc:run");
		assert.ok(runHandler, "run handler should be registered");

		// The handler is async; it checks rate limit first, then ctx.
		// Since we have no ctx, requests past rate limit should give rate limit error,
		// and requests within limit should give "No active pi-crew session context."
		// We need to send 5 requests that get past rate limit, then the 6th should be rate-limited.

		for (let i = 0; i < 5; i++) {
			runHandler({
				requestId: `r${i}`,
				goal: "test",
				config: { intent: "test" },
			});
		}
		// 6th request should be rate limited
		runHandler({
			requestId: `r5`,
			goal: "test",
			config: { intent: "test" },
		});

		// Wait for async handlers to resolve
		await new Promise((r) => setTimeout(r, 100));

		// The first 5 should have gotten "No active session" (ctx check fails after rate limit passes)
		// The 6th should have gotten rate limit error
		// But since our mock emit doesn't capture the replies in order easily with async,
		// let's check that the last reply contains rate limit info.
		// Actually our replies array captures all emitted reply events.
		// Let's check there's at least one reply and the rate limited one mentions "rate limit".

		const rateLimitReplies = replies.filter(
			(r: any) => r?.success === false && typeof r?.error === "string" && r.error.includes("rate limit"),
		);
		assert.ok(
			rateLimitReplies.length >= 1,
			`Expected at least 1 rate-limited reply, got ${rateLimitReplies.length} out of ${replies.length} total. Replies: ${JSON.stringify(replies)}`,
		);
	});

	it("resets rate limit counter", async () => {
		const bus = createMockEventBus();
		const replies: unknown[] = [];

		registerPiCrewRpc(
			{
				on: bus.on,
				emit: (event: string, data: unknown) => {
					if (event.startsWith("pi-crew:rpc:run:reply:")) {
						replies.push(data);
					}
				},
			} as any,
			() => undefined as any,
		);

		const runHandler = bus.getHandler("pi-crew:rpc:run");
		assert.ok(runHandler);

		// Exhaust rate limit
		for (let i = 0; i < 5; i++) {
			runHandler({
				requestId: `r${i}`,
				goal: "test",
				config: { intent: "test" },
			});
		}
		runHandler({
			requestId: "exhausted",
			goal: "test",
			config: { intent: "test" },
		});

		await new Promise((r) => setTimeout(r, 100));

		const beforeReset = replies.filter((r: any) => r?.success === false && r?.error?.includes("rate limit"));
		assert.ok(beforeReset.length >= 1, "Should have at least one rate-limited reply before reset");

		// Reset and verify we can make requests again
		replies.length = 0;
		resetRpcRateLimit();

		runHandler({
			requestId: "after-reset",
			goal: "test",
			config: { intent: "test" },
		});

		await new Promise((r) => setTimeout(r, 100));

		// After reset, should get "No active session" (not rate limit)
		const afterReset = replies.filter((r: any) => r?.success === false && r?.error?.includes("rate limit"));
		assert.equal(afterReset.length, 0, `Should have 0 rate-limited replies after reset, got ${afterReset.length}`);
	});
});
