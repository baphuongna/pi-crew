import test from "node:test";
import assert from "node:assert/strict";
import { classifyStartupFailure, createStartupEvidence, detectTrustPrompt } from "../../src/runtime/worker-startup.ts";

test("worker startup evidence detects trust prompt and classifies failures", () => {
	assert.equal(detectTrustPrompt("Do you trust this workspace?"), true);
	const evidence = createStartupEvidence({ command: "pi", startedAt: new Date(0), finishedAt: new Date(1000), promptSentAt: new Date(0), promptAccepted: false, stderr: "Do you trust this workspace?", exitCode: 1 });
	assert.equal(evidence.trustPromptDetected, true);
	assert.equal(evidence.classification, "trust_required");
});

test("worker startup classifier distinguishes transport and acceptance timeout", () => {
	assert.equal(classifyStartupFailure({ lastLifecycleState: "spawning", command: "pi", promptAccepted: false, trustPromptDetected: false, transportHealthy: false, childProcessAlive: false, elapsedMs: 1 }), "transport_dead");
	assert.equal(classifyStartupFailure({ lastLifecycleState: "running", command: "pi", promptSentAt: new Date(0).toISOString(), promptAccepted: false, trustPromptDetected: false, transportHealthy: true, childProcessAlive: true, elapsedMs: 1 }), "prompt_acceptance_timeout");
});
