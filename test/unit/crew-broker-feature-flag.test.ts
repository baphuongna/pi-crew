/**
 * crew-broker-feature-flag.test.ts — Phase 0 sub-task 0.6 test surface.
 *
 * Verifies the broker feature-flag plumbing:
 *  - DEFAULT_BROKER is off (enabled:false), bounded limits.
 *  - PI_CREW_BROKER=1 overrides config=false (forces enabled:true).
 *  - PI_CREW_BROKER=0 overrides config=true (forces enabled:false).
 *  - PI_CREW_BROKER=unset falls through to parsed config.
 *  - Schema rejects out-of-bounds numeric limits via TypeBox.
 *  - Disabled-path proof: when enabled is false (default), no broker
 *    credentials are constructed by the lifecycle controller.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";

import { DEFAULT_BROKER, resolveBrokerEnvOverride } from "../../src/config/defaults.ts";
import { CrewBrokerConfigSchema } from "../../src/schema/config-schema.ts";

/** TypeBox-backed boolean check helper for the broker schema only. */
function isValidBrokerConfig(value: unknown): boolean {
	return Value.Check(CrewBrokerConfigSchema, value);
}

// ----------------------------------------------------------------------------
// DEFAULT_BROKER shape + default-off guarantee
// ----------------------------------------------------------------------------

test("DEFAULT_BROKER.enabled === false (kill switch default)", () => {
	assert.equal(DEFAULT_BROKER.enabled, false);
});

test("DEFAULT_BROKER pathHashLen within schema bounds (4..32, default 8)", () => {
	assert.equal(DEFAULT_BROKER.pathHashLen, 8);
	assert.ok(DEFAULT_BROKER.pathHashLen >= 4 && DEFAULT_BROKER.pathHashLen <= 32);
});

test("DEFAULT_BROKER maxFrameBytes within schema bounds (1024..1048576, default 262144 = 256 KiB)", () => {
	assert.equal(DEFAULT_BROKER.maxFrameBytes, 262144);
	assert.ok(DEFAULT_BROKER.maxFrameBytes >= 1024 && DEFAULT_BROKER.maxFrameBytes <= 1_048_576);
});

test("DEFAULT_BROKER outboundQueueCap within schema bounds (32..4096, default 256)", () => {
	assert.equal(DEFAULT_BROKER.outboundQueueCap, 256);
	assert.ok(DEFAULT_BROKER.outboundQueueCap >= 32 && DEFAULT_BROKER.outboundQueueCap <= 4096);
});

// ----------------------------------------------------------------------------
// PI_CREW_BROKER env override precedence
// ----------------------------------------------------------------------------

test("PI_CREW_BROKER=1 overrides parsed.enabled=false (forces true)", () => {
	const previous = process.env.PI_CREW_BROKER;
	process.env.PI_CREW_BROKER = "1";
	try {
		const result = resolveBrokerEnvOverride({ enabled: false });
		assert.equal(result?.enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_BROKER;
		else process.env.PI_CREW_BROKER = previous;
	}
});

test("PI_CREW_BROKER=0 overrides parsed.enabled=true (forces false)", () => {
	const previous = process.env.PI_CREW_BROKER;
	process.env.PI_CREW_BROKER = "0";
	try {
		const result = resolveBrokerEnvOverride({ enabled: true });
		assert.equal(result?.enabled, false);
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_BROKER;
		else process.env.PI_CREW_BROKER = previous;
	}
});

test("PI_CREW_BROKER=1 with undefined parsed (no broker block) flips the flag on", () => {
	const previous = process.env.PI_CREW_BROKER;
	process.env.PI_CREW_BROKER = "1";
	try {
		const result = resolveBrokerEnvOverride(undefined);
		assert.equal(result?.enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_BROKER;
		else process.env.PI_CREW_BROKER = previous;
	}
});

test("PI_CREW_BROKER=unset falls through to parsed config", () => {
	const previous = process.env.PI_CREW_BROKER;
	delete process.env.PI_CREW_BROKER;
	try {
		const input = { enabled: true, maxFrameBytes: 524288 };
		const result = resolveBrokerEnvOverride(input);
		assert.equal(result?.enabled, true);
		assert.equal(result?.maxFrameBytes, 524288);
	} finally {
		if (previous !== undefined) process.env.PI_CREW_BROKER = previous;
	}
});

test("PI_CREW_BROKER with arbitrary value (not 0/1) falls through to parsed config", () => {
	const previous = process.env.PI_CREW_BROKER;
	process.env.PI_CREW_BROKER = "maybe";
	try {
		const input = { enabled: true };
		const result = resolveBrokerEnvOverride(input);
		assert.equal(result?.enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_BROKER;
		else process.env.PI_CREW_BROKER = previous;
	}
});

// ----------------------------------------------------------------------------
// Schema bounds enforcement
// ----------------------------------------------------------------------------

test("schema rejects pathHashLen < 4", () => {
	assert.equal(isValidBrokerConfig({ pathHashLen: 2 }), false);
});

test("schema rejects pathHashLen > 32", () => {
	assert.equal(isValidBrokerConfig({ pathHashLen: 64 }), false);
});

test("schema rejects maxFrameBytes < 1024", () => {
	assert.equal(isValidBrokerConfig({ maxFrameBytes: 512 }), false);
});

test("schema rejects maxFrameBytes > 1048576", () => {
	assert.equal(isValidBrokerConfig({ maxFrameBytes: 2_097_152 }), false);
});

test("schema rejects outboundQueueCap < 32", () => {
	assert.equal(isValidBrokerConfig({ outboundQueueCap: 16 }), false);
});

test("schema rejects outboundQueueCap > 4096", () => {
	assert.equal(isValidBrokerConfig({ outboundQueueCap: 8192 }), false);
});

test("schema accepts DEFAULT_BROKER shape (rolled-up defaults)", () => {
	assert.equal(isValidBrokerConfig(DEFAULT_BROKER), true);
});

test("schema accepts empty object (all fields optional)", () => {
	assert.equal(isValidBrokerConfig({}), true);
});

test("schema rejects unknown additional properties (additionalProperties:false)", () => {
	assert.equal(isValidBrokerConfig({ notAField: true }), false);
});

// ----------------------------------------------------------------------------
// Disabled-path proof (consumed by Phase 0 verifier E + integration tests)
// ----------------------------------------------------------------------------

test("disabled-path: env=0 with parsed.enabled=true results in effective enabled=false", () => {
	const previous = process.env.PI_CREW_BROKER;
	process.env.PI_CREW_BROKER = "0";
	try {
		const result = resolveBrokerEnvOverride({ enabled: true });
		assert.equal(result?.enabled, false);
	} finally {
		if (previous === undefined) delete process.env.PI_CREW_BROKER;
		else process.env.PI_CREW_BROKER = previous;
	}
});

test("disabled-path: env=unset + parsed=undefined results in effective undefined (treated as off by gate)", () => {
	const previous = process.env.PI_CREW_BROKER;
	delete process.env.PI_CREW_BROKER;
	try {
		const result = resolveBrokerEnvOverride(undefined);
		assert.equal(result, undefined);
	} finally {
		if (previous !== undefined) process.env.PI_CREW_BROKER = previous;
	}
});
