import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withSessionId } from "../../src/extension/team-tool/context.ts";

function baseContext(sessionId: string) {
	return {
		cwd: process.cwd(),
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
	};
}

test("withSessionId injects the active Pi session id", () => {
	const ctx = withSessionId(baseContext("session-123") as unknown as Pick<ExtensionContext, "sessionManager"> & { cwd: string });
	assert.equal(ctx.sessionId, "session-123");
	assert.equal(ctx.cwd, process.cwd());
});
