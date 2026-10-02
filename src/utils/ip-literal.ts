/**
 * IPv6 literal parsing / normalization helpers (RFC 3986 §3.2.2 host ABNF +
 * RFC 4291 address forms). Shared by the OTLP exporter and webhook notifier
 * SSRF guards so both classify EVERY literal form (bracketed, compressed,
 * expanded, embedded-IPv4, zone-id) through ONE parser.
 *
 * G6 fix rationale: each guard previously matched only a subset of textual
 * forms, so the bracketed IPv4-compatible spelling `::a.b.c.d` (e.g.
 * `[::127.0.0.1]` — kernel-routed loopback) bypassed both layers, and
 * `new URL("http://::1:4318")` threw before any classification ran.
 */

/** Strip RFC 3986 `[...]` brackets from a URL hostname. Idempotent. */
export function unbracketHost(host: string): string {
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True for a dotted-quad IPv4 string with octets in 0..255 and no leading
 * zeros ("01" is rejected — getaddrinfo reads it as octal, we must not). */
function ipv4Octets(address: string): number[] | undefined {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!match) return undefined;
	const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
	if (octets.some((octet) => octet > 255)) return undefined;
	if (match.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) return undefined;
	return octets;
}

/** IPv4 octets → two 16-bit groups (network order). */
function octetsToGroups(octets: number[]): number[] {
	return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
}

/**
 * Parse an IPv6 literal (WITHOUT brackets — call `unbracketHost` first)
 * into its 8 16-bit groups. Accepts `::`-compressed forms, fully expanded
 * forms, and a trailing embedded IPv4 (`::ffff:1.2.3.4`). Zone-ids
 * (`fe80::1%eth0`, RFC 6874) are stripped before parsing. Returns undefined
 * for anything that is not a syntactically valid IPv6 literal (hostnames,
 * plain IPv4, junk) — callers treat "unparseable" as not-an-IPv6-literal.
 */
export function parseIpv6Literal(host: string): number[] | undefined {
	let literal = host.toLowerCase();
	const zone = literal.indexOf("%");
	if (zone !== -1) literal = literal.slice(0, zone);
	if (!literal.includes(":")) return undefined;
	const halves = literal.split("::");
	if (halves.length > 2) return undefined;
	const parseGroups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const segments = part.split(":");
		const groups: number[] = [];
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			if (segment.includes(".")) {
				// Embedded IPv4 is only valid as the LAST segment.
				if (index !== segments.length - 1) return undefined;
				const octets = ipv4Octets(segment);
				if (!octets) return undefined;
				groups.push(...octetsToGroups(octets));
			} else {
				if (!/^[0-9a-f]{1,4}$/.test(segment)) return undefined;
				groups.push(Number.parseInt(segment, 16));
			}
		}
		return groups;
	};
	if (halves.length === 2) {
		// An embedded IPv4 is only valid as the LAST 32 bits of the address —
		// reject it in the pre-`::` half (e.g. `1.2.3.4::`).
		if (halves[0].includes(".")) return undefined;
		const head = parseGroups(halves[0]);
		const tail = parseGroups(halves[1]);
		if (!head || !tail) return undefined;
		// `::` must expand to at least one zero group.
		if (head.length + tail.length > 7) return undefined;
		const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
		return [...head, ...zeros, ...tail];
	}
	const groups = parseGroups(literal);
	if (groups?.length !== 8) return undefined;
	return groups;
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped
 * (`::ffff:a.b.c.d` — groups[5] == 0xffff) or IPv4-compatible
 * (`::a.b.c.d` — groups[0..5] all zero) literal, as dotted quad. Both
 * spellings are kernel-routed to the embedded IPv4 destination, so SSRF
 * guards must apply their IPv4 predicate to the extracted quad.
 */
export function embeddedIpv4FromGroups(groups: number[]): string | undefined {
	if (groups.length !== 8) return undefined;
	const quad = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
	// IPv4-mapped ::ffff:a.b.c.d — groups[0..4] zero, groups[5] == 0xffff.
	if (groups[5] === 0xffff && groups.slice(0, 5).every((group) => group === 0)) return quad;
	// IPv4-compatible ::a.b.c.d — groups[0..5] zero.
	if (groups.slice(0, 6).every((group) => group === 0)) return quad;
	return undefined;
}

/**
 * Bracket a bare IPv6 literal host (`::1` → `[::1]`) per RFC 3986 §3.2.2 —
 * `new URL` throws on unbracketed IPv6 hosts. Already-bracketed hosts and
 * non-IPv6 hosts (fewer than 2 colons — a URL host with one colon is
 * `host:port`) are returned unchanged.
 */
export function bracketIpv6Host(host: string): string {
	if (host.startsWith("[")) return host;
	if ((host.match(/:/g) ?? []).length < 2) return host;
	return `[${host}]`;
}

/**
 * Normalize an http(s) URL whose authority carries a BARE IPv6 literal
 * (`http://::1:4318` — unparseable by `new URL`) into bracketed form
 * (`http://[::1]:4318`). The authority is isolated lexically (no URL
 * parsing). Everything else — userinfo URLs, already-bracketed hosts,
 * normal hostnames — is returned unchanged.
 */
export function bracketIpv6InUrl(url: string): string {
	const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(url);
	if (!schemeMatch) return url;
	const scheme = schemeMatch[0];
	const rest = url.slice(scheme.length);
	const authorityEnd = /[/?#]/.exec(rest);
	const authority = authorityEnd ? rest.slice(0, authorityEnd.index) : rest;
	const tail = authorityEnd ? rest.slice(authorityEnd.index) : "";
	if (authority.includes("@") || authority.startsWith("[")) return url;
	// Split a trailing `:port` only when what remains is still a plausible
	// bare IPv6 literal (>= 2 colons): `::1:4318` → host `::1` + port
	// `4318`, while `::1` stays whole (stripping `:1` would leave `:`).
	let host = authority;
	let port = "";
	const portMatch = /:(\d{1,5})$/.exec(authority);
	if (portMatch) {
		const candidate = authority.slice(0, portMatch.index);
		if ((candidate.match(/:/g) ?? []).length >= 2) {
			host = candidate;
			port = portMatch[0];
		}
	}
	if ((host.match(/:/g) ?? []).length < 2) return url;
	return `${scheme}[${host}]${port}${tail}`;
}
