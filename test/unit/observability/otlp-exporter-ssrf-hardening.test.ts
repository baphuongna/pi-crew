import assert from "node:assert/strict";
import test from "node:test";
import { assertResolvedAddressSafe, OTLPExporter, validateEndpoint } from "../../../src/observability/exporters/otlp-exporter.ts";
import { createMetricRegistry } from "../../../src/observability/metric-registry.ts";

/**
 * W7B regression tests:
 *  - otlp-exporter.fetch-redirect-follow-ssrf-guard-bypass: push() must pin
 *    redirect:"manual" and refuse 3xx without ever contacting the Location
 *    target (hop-2+ is never re-validated by the SSRF guards).
 *  - otlp-exporter.userinfo-endpoint-in-error-logs: credential-bearing
 *    endpoints are refused with an origin-only message, and no error/log text
 *    ever echoes userinfo, path, or query.
 */

interface FetchCall {
	url: string;
	redirect?: string;
}

function recordFetchCall(input: RequestInfo | URL, init?: RequestInit): FetchCall {
	return {
		url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
		redirect: init?.redirect,
	};
}

/** Public-IP endpoint (validateEndpoint allows it; assertResolvedAddressSafe short-circuits literals — no DNS round-trip; the stubbed fetch never touches the network). */
const SAFE_PUBLIC_ENDPOINT = "http://8.8.8.8:4318/v1/metrics";
const METADATA_TARGET = "http://169.254.169.254/latest/meta-data/";

function stubRedirectingFetch(status: number, calls: FetchCall[]): void {
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		calls.push(recordFetchCall(input, init));
		return new Response(null, { status, headers: { location: METADATA_TARGET } });
	};
}

for (const status of [301, 302, 303, 307, 308]) {
	test(`push pins redirect:"manual" and refuses HTTP ${status} without fetching the redirect target`, async () => {
		const registry = createMetricRegistry();
		registry.counter("crew.run.count", "runs").inc();
		const calls: FetchCall[] = [];
		const previous = globalThis.fetch;
		stubRedirectingFetch(status, calls);
		try {
			const exporter = new OTLPExporter({ endpoint: SAFE_PUBLIC_ENDPOINT }, registry);
			// A refused redirect is a failed push, not an exception.
			await assert.doesNotReject(() => exporter.push(registry.snapshot()));
		} finally {
			globalThis.fetch = previous;
		}
		assert.equal(calls.length, 1, "exactly one fetch (the configured endpoint) must occur");
		assert.equal(calls[0].url, SAFE_PUBLIC_ENDPOINT);
		// THE regression signal: without redirect:"manual" undici follows up to
		// 20 attacker-directed hops without re-running the SSRF guards.
		assert.equal(calls[0].redirect, "manual", "fetch must pin redirect:'manual'");
		assert.ok(
			!calls.some((call) => call.url.includes("169.254.169.254")),
			"the redirect target (cloud metadata) must never be fetched",
		);
	});
}

test("validateEndpoint refuses embedded userinfo with an origin-only message", () => {
	assert.throws(
		() => validateEndpoint("http://user:sekret@otlp.example.com/v1/metrics"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /credentials|userinfo/i);
			assert.ok(!error.message.includes("sekret"), "message must not echo the password");
			assert.ok(!error.message.includes("user:"), "message must not echo the userinfo");
			assert.ok(!error.message.includes("/v1/metrics"), "message must be origin-only");
			return true;
		},
	);
});

test("userinfo refusal precedes hostname classification (no credential echo via classification errors)", () => {
	// A credential-bearing metadata endpoint must trip the userinfo refusal —
	// never the link-local error, which would have echoed the raw endpoint.
	assert.throws(
		() => validateEndpoint("http://user:sekret@169.254.169.254/latest/meta-data/"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /credentials|userinfo/i);
			assert.ok(!error.message.includes("sekret"));
			assert.ok(!error.message.includes("user:"));
			return true;
		},
	);
	assert.throws(
		() => validateEndpoint("http://user:sekret@localhost:4318/v1/metrics"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /credentials|userinfo/i);
			assert.ok(!error.message.includes("sekret"));
			return true;
		},
	);
});

test("unparseable credential-bearing endpoints are still userinfo-redacted in error text", () => {
	assert.throws(
		() => validateEndpoint("http://u:sekret@bad host with spaces"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Invalid OTLP endpoint/);
			assert.ok(!error.message.includes("sekret"), "message must not echo the password");
			assert.ok(error.message.includes("[redacted]"), "unparseable URLs must still redact userinfo");
			return true;
		},
	);
});

test("OTLPExporter constructor refuses credential-bearing endpoints", () => {
	const registry = createMetricRegistry();
	assert.throws(
		() => new OTLPExporter({ endpoint: "http://user:sekret@collector.example.com:4318/v1/metrics" }, registry),
		/credentials|userinfo/i,
	);
});

test("assertResolvedAddressSafe renders origin-only endpoint in literal rejections", async () => {
	await assert.rejects(
		() => assertResolvedAddressSafe("http://user:sekret@[fd00::1]/v1/metrics"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /private\/reserved IPv6 literal/);
			assert.ok(!error.message.includes("sekret"), "message must not echo the password");
			assert.ok(!error.message.includes("user:"), "message must not echo the userinfo");
			assert.ok(!error.message.includes("/v1/metrics"), "message must be origin-only");
			return true;
		},
	);
});

test("push logs the origin-only endpoint form on non-OK responses (no path/userinfo)", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc();
	const previousFetch = globalThis.fetch;
	const previousConsoleError = console.error;
	const previousDebug = process.env.PI_TEAMS_DEBUG;
	const lines: string[] = [];
	globalThis.fetch = async (): Promise<Response> => new Response("boom", { status: 500 });
	console.error = (...data: unknown[]) => {
		for (const line of data) if (typeof line === "string") lines.push(line);
	};
	// logInternalError emits only when PI_TEAMS_DEBUG is set (default gate).
	process.env.PI_TEAMS_DEBUG = "1";
	try {
		const exporter = new OTLPExporter({ endpoint: "http://collector.example.com:4318/v1/metrics" }, registry);
		await exporter.push(registry.snapshot());
	} finally {
		globalThis.fetch = previousFetch;
		console.error = previousConsoleError;
		if (previousDebug === undefined) delete process.env.PI_TEAMS_DEBUG;
		else process.env.PI_TEAMS_DEBUG = previousDebug;
	}
	const line = lines.find((candidate) => candidate.startsWith("[pi-crew:otlp-export-http]"));
	assert.ok(line, "expected the otlp-export-http log line");
	assert.ok(line.includes("HTTP 500"), "non-OK response must be logged");
	assert.ok(line.includes("endpoint=http://collector.example.com:4318"), "endpoint must render origin-only");
	assert.ok(!line.includes("/v1/metrics"), "log must not include the endpoint path");
	assert.ok(!line.includes("@"), "log must not include userinfo");
});

test("push logs the origin-only endpoint form when refusing a redirect", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc();
	const calls: FetchCall[] = [];
	const previousFetch = globalThis.fetch;
	const previousConsoleError = console.error;
	const previousDebug = process.env.PI_TEAMS_DEBUG;
	const lines: string[] = [];
	stubRedirectingFetch(302, calls);
	console.error = (...data: unknown[]) => {
		for (const line of data) if (typeof line === "string") lines.push(line);
	};
	process.env.PI_TEAMS_DEBUG = "1";
	try {
		const exporter = new OTLPExporter({ endpoint: SAFE_PUBLIC_ENDPOINT }, registry);
		await exporter.push(registry.snapshot());
	} finally {
		globalThis.fetch = previousFetch;
		console.error = previousConsoleError;
		if (previousDebug === undefined) delete process.env.PI_TEAMS_DEBUG;
		else process.env.PI_TEAMS_DEBUG = previousDebug;
	}
	assert.equal(calls.length, 1, "only the configured endpoint may be fetched");
	const line = lines.find((candidate) => candidate.startsWith("[pi-crew:otlp-export-http]"));
	assert.ok(line, "expected the redirect-refusal log line");
	assert.match(line, /refused redirect HTTP 302/);
	assert.ok(!line.includes("/v1/metrics"), "refusal log must be origin-only");
});
