import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bracketIpv6Host, bracketIpv6InUrl, embeddedIpv4FromGroups, parseIpv6Literal, unbracketHost } from "../../src/utils/ip-literal.ts";

describe("ip-literal: unbracketHost", () => {
	it("strips brackets and is idempotent", () => {
		assert.equal(unbracketHost("[::1]"), "::1");
		assert.equal(unbracketHost("::1"), "::1");
		assert.equal(unbracketHost("[::ffff:127.0.0.1]"), "::ffff:127.0.0.1");
	});
});

describe("ip-literal: parseIpv6Literal", () => {
	it("parses compressed forms into 8 groups", () => {
		assert.deepEqual(parseIpv6Literal("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
		assert.deepEqual(parseIpv6Literal("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
		assert.deepEqual(parseIpv6Literal("fd00::1"), [0xfd00, 0, 0, 0, 0, 0, 0, 1]);
		assert.deepEqual(parseIpv6Literal("fe80::"), [0xfe80, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("parses fully-expanded forms (the spellings prefix checks miss)", () => {
		assert.deepEqual(parseIpv6Literal("0:0:0:0:0:0:0:1"), [0, 0, 0, 0, 0, 0, 0, 1]);
		assert.deepEqual(parseIpv6Literal("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("parses embedded IPv4 tails (mapped + compatible)", () => {
		assert.deepEqual(parseIpv6Literal("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
		assert.deepEqual(parseIpv6Literal("::127.0.0.1"), [0, 0, 0, 0, 0, 0, 0x7f00, 0x0001]);
		assert.deepEqual(parseIpv6Literal("0:0:0:0:0:ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
	});

	it("strips zone-ids (RFC 6874) before parsing", () => {
		assert.deepEqual(parseIpv6Literal("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
		assert.deepEqual(parseIpv6Literal("fe80::1%25eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
	});

	it("is case-insensitive", () => {
		assert.deepEqual(parseIpv6Literal("FD00::AB"), [0xfd00, 0, 0, 0, 0, 0, 0, 0xab]);
	});

	it("returns undefined for non-IPv6 input", () => {
		assert.equal(parseIpv6Literal("example.com"), undefined);
		assert.equal(parseIpv6Literal("8.8.8.8"), undefined, "plain IPv4 is not an IPv6 literal");
		assert.equal(parseIpv6Literal("not-a-host"), undefined);
	});

	it("returns undefined for malformed literals", () => {
		assert.equal(parseIpv6Literal(":"), undefined);
		assert.equal(parseIpv6Literal(":::1"), undefined, "double ::");
		assert.equal(parseIpv6Literal("12345::"), undefined, "hextet > 4 hex digits");
		assert.equal(parseIpv6Literal("1:2:3:4:5:6:7:8:9"), undefined, "too many groups");
		assert.equal(parseIpv6Literal("::1:2:3:4:5:6:7:8"), undefined, ":: must expand to >= 1 group");
		assert.equal(parseIpv6Literal("::ffff:999.1.1.1"), undefined, "octet > 255");
		assert.equal(parseIpv6Literal("::ffff:0177.0.0.1"), undefined, "leading-zero octet (octal ambiguity)");
		assert.equal(parseIpv6Literal("1.2.3.4::"), undefined, "embedded IPv4 not at the end");
	});
});

describe("ip-literal: embeddedIpv4FromGroups", () => {
	it("extracts the quad from mapped and compatible forms", () => {
		assert.equal(embeddedIpv4FromGroups([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe]), "169.254.169.254");
		assert.equal(embeddedIpv4FromGroups([0, 0, 0, 0, 0, 0, 0x7f00, 0x0001]), "127.0.0.1");
		assert.equal(embeddedIpv4FromGroups([0, 0, 0, 0, 0, 0, 0x0808, 0x0808]), "8.8.8.8", "compatible with public quad");
	});

	it("returns undefined for non-embedded addresses", () => {
		assert.equal(embeddedIpv4FromGroups([0xfd00, 0, 0, 0, 0, 0, 0, 1]), undefined);
		assert.equal(embeddedIpv4FromGroups([0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111]), undefined);
		assert.equal(embeddedIpv4FromGroups([0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe]), undefined, "NAT64 is not mapped/compatible");
		assert.equal(embeddedIpv4FromGroups([1, 2, 3, 4, 5, 6, 7]), undefined, "not 8 groups");
	});
});

describe("ip-literal: bracketIpv6Host / bracketIpv6InUrl", () => {
	it("brackets bare IPv6 hosts (RFC 3986 §3.2.2)", () => {
		assert.equal(bracketIpv6Host("::1"), "[::1]");
		assert.equal(bracketIpv6Host("2606:4700:4700::1111"), "[2606:4700:4700::1111]");
		assert.equal(bracketIpv6Host("[::1]"), "[::1]", "already bracketed unchanged");
		assert.equal(bracketIpv6Host("localhost"), "localhost", "hostname unchanged");
		assert.equal(bracketIpv6Host("localhost:4318"), "localhost:4318", "host:port unchanged");
	});

	it("brackets bare IPv6 authorities in URLs, splitting the port correctly", () => {
		assert.ok(bracketIpv6InUrl("http://::1:4318").includes("[::1]"));
		assert.equal(bracketIpv6InUrl("http://::1:4318/v1/metrics"), "http://[::1]:4318/v1/metrics");
		assert.equal(bracketIpv6InUrl("http://::1"), "http://[::1]", "no port — the whole authority is the literal");
		assert.equal(bracketIpv6InUrl("http://2606:4700:4700::1111:4318"), "http://[2606:4700:4700::1111]:4318");
	});

	it("leaves non-IPv6 and already-bracketed URLs untouched", () => {
		assert.equal(bracketIpv6InUrl("https://otlp.example.com:4318/v1/metrics"), "https://otlp.example.com:4318/v1/metrics");
		assert.equal(bracketIpv6InUrl("http://[::1]:4318"), "http://[::1]:4318");
		assert.equal(bracketIpv6InUrl("http://user:pass@::1:4318"), "http://user:pass@::1:4318", "userinfo left for new URL to reject");
		assert.equal(bracketIpv6InUrl("not-a-url"), "not-a-url");
	});
});
