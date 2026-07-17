import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertResolvedAddressSafe,
	isPrivateIpAddress,
	validateEndpoint,
} from "../../src/observability/exporters/otlp-exporter.ts";

describe("OTLP SSRF endpoint validation", () => {
	it("allows valid public https URL", () => {
		assert.doesNotThrow(() => validateEndpoint("https://otlp.example.com:4318/v1/metrics"));
	});

	it("allows valid public http URL", () => {
		assert.doesNotThrow(() => validateEndpoint("http://collector.mycompany.io/v1/metrics"));
	});

	it("rejects localhost", () => {
		assert.throws(() => validateEndpoint("http://localhost:4318/v1/metrics"), /localhost/);
	});

	it("rejects .localhost subdomain", () => {
		assert.throws(() => validateEndpoint("http://app.localhost:4318"), /localhost/);
	});

	it("rejects 127.0.0.1 (loopback)", () => {
		assert.throws(() => validateEndpoint("http://127.0.0.1:4318"), /loopback/);
	});

	it("rejects 127.x.x.x (loopback range)", () => {
		assert.throws(() => validateEndpoint("http://127.0.0.2:4318"), /loopback/);
	});

	it("rejects 10.x.x.x (private class A)", () => {
		assert.throws(() => validateEndpoint("http://10.0.0.1:4318"), /private network/);
	});

	it("rejects 172.16.x.x (private class B start)", () => {
		assert.throws(() => validateEndpoint("http://172.16.0.1:4318"), /private network/);
	});

	it("rejects 172.31.x.x (private class B end)", () => {
		assert.throws(() => validateEndpoint("http://172.31.255.255:4318"), /private network/);
	});

	it("rejects 192.168.x.x (private class C)", () => {
		assert.throws(() => validateEndpoint("http://192.168.1.1:4318"), /private network/);
	});

	it("rejects 169.254.169.254 (AWS metadata)", () => {
		assert.throws(() => validateEndpoint("http://169.254.169.254/latest/meta-data/"), /link-local|metadata/);
	});

	it("rejects 169.254.x.x (link-local)", () => {
		assert.throws(() => validateEndpoint("http://169.254.1.1:4318"), /link-local|metadata/);
	});

	it("rejects 0.0.0.0 (this network)", () => {
		assert.throws(() => validateEndpoint("http://0.0.0.0:4318"), /this-network/);
	});

	it("rejects file:// protocol", () => {
		assert.throws(() => validateEndpoint("file:///etc/passwd"), /protocol/);
	});

	it("rejects javascript:// protocol", () => {
		assert.throws(() => validateEndpoint("javascript://alert(1)"), /protocol/);
	});

	it("rejects ftp:// protocol", () => {
		assert.throws(() => validateEndpoint("ftp://collector.example.com"), /protocol/);
	});

	it("rejects IPv6 loopback [::1]", () => {
		assert.throws(() => validateEndpoint("http://[::1]:4318"), /loopback/);
	});

	it("rejects IPv6 private fd00::/8", () => {
		assert.throws(() => validateEndpoint("http://[fd00::1]:4318"), /private IPv6/);
	});

	it("rejects IPv6 private fc00::/8", () => {
		assert.throws(() => validateEndpoint("http://[fc00::1]:4318"), /private IPv6/);
	});

	it("rejects IPv6 link-local fe80::/10", () => {
		assert.throws(() => validateEndpoint("http://[fe80::1]:4318"), /link-local/);
		assert.throws(() => validateEndpoint("http://[fea0::1]:4318"), /link-local/);
		assert.throws(() => validateEndpoint("http://[febf::1]:4318"), /link-local/);
	});

	it("rejects IPv6 site-local fec0::/10 (deprecated)", () => {
		assert.throws(() => validateEndpoint("http://[fec0::1]:4318"), /site-local/);
		assert.throws(() => validateEndpoint("http://[fed0::1]:4318"), /site-local/);
		assert.throws(() => validateEndpoint("http://[fef0::1]:4318"), /site-local/);
	});

	it("rejects IPv6 multicast ff00::/8", () => {
		assert.throws(() => validateEndpoint("http://[ff02::1]:4318"), /multicast/);
	});

	it("rejects IPv6 unspecified address ::", () => {
		assert.throws(() => validateEndpoint("http://[::]:4318"), /unspecified/);
	});

	it("rejects IPv4-mapped IPv6 ::ffff:x.x.x.x", () => {
		assert.throws(() => validateEndpoint("http://[::ffff:127.0.0.1]:4318"), /IPv4-mapped/);
	});

	it("allows public IPv4", () => {
		assert.doesNotThrow(() => validateEndpoint("http://8.8.8.8:4318"));
	});

	it("allows 172.15.x.x (not in private range)", () => {
		assert.doesNotThrow(() => validateEndpoint("http://172.15.0.1:4318"));
	});

	it("allows 172.32.x.x (not in private range)", () => {
		assert.doesNotThrow(() => validateEndpoint("http://172.32.0.1:4318"));
	});

	it("rejects invalid URL", () => {
		assert.throws(() => validateEndpoint("not-a-url"), /Invalid OTLP endpoint/);
	});

	// CFG-6: DNS-rebinding guard — the pure classifier.
	it("isPrivateIpAddress flags loopback IPv4", () => {
		assert.equal(isPrivateIpAddress("127.0.0.1"), true);
		assert.equal(isPrivateIpAddress("127.255.255.254"), true);
	});

	it("isPrivateIpAddress flags RFC1918 IPv4", () => {
		assert.equal(isPrivateIpAddress("10.0.0.1"), true);
		assert.equal(isPrivateIpAddress("172.16.0.1"), true);
		assert.equal(isPrivateIpAddress("172.31.255.255"), true);
		assert.equal(isPrivateIpAddress("192.168.1.1"), true);
	});

	it("isPrivateIpAddress flags link-local / metadata IPv4 (169.254.x.x)", () => {
		assert.equal(isPrivateIpAddress("169.254.169.254"), true);
		assert.equal(isPrivateIpAddress("169.254.0.1"), true);
	});

	it("isPrivateIpAddress flags loopback / private / link-local IPv6", () => {
		assert.equal(isPrivateIpAddress("::1"), true);
		assert.equal(isPrivateIpAddress("fd00::1"), true);
		assert.equal(isPrivateIpAddress("fc00::1"), true);
		assert.equal(isPrivateIpAddress("fe80::1"), true);
		assert.equal(isPrivateIpAddress("ff02::1"), true);
		assert.equal(isPrivateIpAddress("::"), true);
		assert.equal(isPrivateIpAddress("::ffff:127.0.0.1"), true);
	});

	it("isPrivateIpAddress allows public IPv4 / IPv6", () => {
		assert.equal(isPrivateIpAddress("8.8.8.8"), false);
		assert.equal(isPrivateIpAddress("172.15.0.1"), false);
		assert.equal(isPrivateIpAddress("172.32.0.1"), false);
		assert.equal(isPrivateIpAddress("2606:4700:4700::1111"), false);
	});

	// CFG-6: DNS-rebinding guard — the runtime async guard.
	it("assertResolvedAddressSafe skips hostnames already covered by validateEndpoint", async () => {
		await assert.doesNotReject(async () => {
			await assertResolvedAddressSafe("http://localhost:4318");
			await assertResolvedAddressSafe("http://127.0.0.1:4318");
			await assertResolvedAddressSafe("http://[::1]:4318");
		});
	});

	it("assertResolvedAddressSafe does not throw on unresolvable hostnames (fail open)", async () => {
		// ".invalid" is a guaranteed-unresolvable TLD (RFC 6761).
		await assert.doesNotReject(assertResolvedAddressSafe("http://nonexistent.invalid:4318"));
	});

	it("assertResolvedAddressSafe allows public hostnames", async () => {
		// example.com is owned by IANA and resolves to a public IP; the guard
		// must therefore allow it.
		await assert.doesNotReject(assertResolvedAddressSafe("https://example.com/v1/metrics"));
	});
});
