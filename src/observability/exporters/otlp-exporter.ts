import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import type { MetricRegistry } from "../metric-registry.ts";
import type { MetricSnapshot } from "../metrics-primitives.ts";
import type { MetricExporter } from "./adapter.ts";

const gzipAsync = promisify(gzip);

/**
 * SSRF protection: validate that an OTLP endpoint URL does not target
 * private/reserved networks or dangerous protocols.
 * Rejects: localhost, loopback, private IPs, link-local, cloud metadata,
 * IPv6 private, file:// and javascript:// protocols.
 * Only http:// and https:// to public hostnames are allowed.
 */
export function validateEndpoint(endpoint: string): void {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`Invalid OTLP endpoint URL: ${endpoint}`);
	}

	// Only allow http and https protocols
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`OTLP endpoint must use http:// or https:// protocol, got: ${url.protocol}`);
	}

	const hostname = url.hostname.toLowerCase();

	// Reject known localhost names
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error(`OTLP endpoint must not target localhost: ${endpoint}`);
	}

	// Reject IPv6 loopback and private
	if (hostname.startsWith("[")) {
		const bare = hostname.replace(/^\[|\]$/g, "");
		const lower = bare.toLowerCase();
		if (lower === "::1") {
			throw new Error(`OTLP endpoint must not target loopback address: ${endpoint}`);
		}
		// Unique Local Addresses (fc00::/7) — fd and fc prefixes
		if (lower.startsWith("fd") || lower.startsWith("fc")) {
			throw new Error(`OTLP endpoint must not target private IPv6 address: ${endpoint}`);
		}
		// Link-Local (fe80::/10) — fe8x, fe9x, feax, febx prefixes
		if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
			throw new Error(`OTLP endpoint must not target IPv6 link-local address: ${endpoint}`);
		}
		// Site-Local (fec0::/10) — deprecated but still routable on misconfigured networks
		if (lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) {
			throw new Error(`OTLP endpoint must not target IPv6 site-local address: ${endpoint}`);
		}
		// Multicast (ff00::/8) — prefix ff
		if (lower.startsWith("ff")) {
			throw new Error(`OTLP endpoint must not target IPv6 multicast address: ${endpoint}`);
		}
		// Unspecified address ::
		if (lower === "::") {
			throw new Error(`OTLP endpoint must not target IPv6 unspecified address: ${endpoint}`);
		}
		// IPv4-mapped IPv6 (::ffff:x.x.x.x)
		if (lower.startsWith("::ffff:")) {
			throw new Error(`OTLP endpoint must not target IPv4-mapped IPv6 address: ${endpoint}`);
		}
	}

	// Reject IPv4 private/reserved ranges
	// Match plain IPv4 addresses (not hostnames that look like IPs)
	const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4Match) {
		const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3]), Number(ipv4Match[4])];
		// 127.x.x.x - loopback
		if (octets[0] === 127) {
			throw new Error(`OTLP endpoint must not target loopback address: ${endpoint}`);
		}
		// 10.x.x.x - private class A
		if (octets[0] === 10) {
			throw new Error(`OTLP endpoint must not target private network (10.0.0.0/8): ${endpoint}`);
		}
		// 172.16.x.x - 172.31.x.x - private class B
		if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
			throw new Error(`OTLP endpoint must not target private network (172.16.0.0/12): ${endpoint}`);
		}
		// 192.168.x.x - private class C
		if (octets[0] === 192 && octets[1] === 168) {
			throw new Error(`OTLP endpoint must not target private network (192.168.0.0/16): ${endpoint}`);
		}
		// 169.254.x.x - link-local / cloud metadata
		if (octets[0] === 169 && octets[1] === 254) {
			throw new Error(`OTLP endpoint must not target link-local/metadata endpoint (169.254.0.0/16): ${endpoint}`);
		}
		// 0.x.x.x - this network
		if (octets[0] === 0) {
			throw new Error(`OTLP endpoint must not target this-network address (0.0.0.0/8): ${endpoint}`);
		}
	}
}

/**
 * CFG-6: classify a single IP address (IPv4 or IPv6) as private / reserved /
 * loopback / link-local. Used by the runtime DNS-rebinding guard below to
 * verify the addresses the endpoint hostname resolves to. Returns true for
 * addresses that must never receive a metrics push. The full literal checks
 * in `validateEndpoint` use the same predicates for direct IP targets.
 */
export function isPrivateIpAddress(address: string): boolean {
	const lower = address.toLowerCase();
	// IPv4 literal
	const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const o0 = Number(ipv4[1]);
		const o1 = Number(ipv4[2]);
		if (o0 === 127 || o0 === 0) return true;
		if (o0 === 10) return true;
		if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;
		if (o0 === 192 && o1 === 168) return true;
		if (o0 === 169 && o1 === 254) return true;
		return false;
	}
	// IPv6 (without surrounding brackets, as `dns.lookup` returns them)
	if (lower === "::1" || lower === "::") return true;
	if (lower.startsWith("fd") || lower.startsWith("fc")) return true;
	if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
	if (lower.startsWith("fec") || lower.startsWith("fed") || lower.startsWith("fee") || lower.startsWith("fef")) return true;
	if (lower.startsWith("ff")) return true;
	if (lower.startsWith("::ffff:")) return true;
	return false;
}

/**
 * CFG-6: DNS-rebinding guard. `validateEndpoint` runs once at exporter
 * construction and only inspects the literal hostname; an attacker who
 * controls the DNS for a public hostname can rebind it to a private IP
 * (e.g. 169.254.169.254 cloud metadata) between construction and the actual
 * fetch. Re-resolve the hostname at push time and reject if any returned
 * address falls into a private/reserved range. Resolution failures are
 * allowed to fall through so the underlying `fetch` surfaces the error.
 */
export async function assertResolvedAddressSafe(endpoint: string): Promise<void> {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return;
	const hostname = url.hostname.toLowerCase();
	if (!hostname) return;
	// Locals and literal IPs are covered by `validateEndpoint`; skip the DNS
	// round-trip so we don't double-report errors the sync check already
	// produces.
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return;
	if (hostname.startsWith("[")) return;
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return;
	let addresses: { address: string }[];
	try {
		addresses = await lookup(hostname, { all: true, verbatim: true });
	} catch {
		// Let the fetch fail with a clearer error from the network layer.
		return;
	}
	for (const { address } of addresses) {
		if (isPrivateIpAddress(address)) {
			throw new Error(`OTLP endpoint resolves to private/reserved address ${address} (DNS rebinding blocked): ${endpoint}`);
		}
	}
}

// FIX (Round 15): Cap the number of snapshots per push to prevent OOM when
// the metric registry has grown large. The OTLP HTTP spec allows many metrics
// in one payload, but a single push > 10_000 metrics would balloon the
// request body (gzipped or not) and likely exceed the collector's request
// size limit.
const MAX_SNAPSHOTS_PER_PUSH = 5_000;

export interface OTLPExporterOptions {
	endpoint: string;
	headers?: Record<string, string>;
	intervalMs?: number;
	timeoutMs?: number;
}

function pointValues(snapshot: MetricSnapshot): unknown[] {
	const MAX_LABEL_LENGTH = 256;
	if (snapshot.type === "histogram") {
		return snapshot.values.map((value) => ({
			attributes: Object.entries(value.labels).map(([key, item]) => {
				const redacted = redactSecrets({ [key]: item }) as Record<string, string>;
				const val = String(redacted[key] ?? item);
				return {
					key,
					value: {
						stringValue: val.length > MAX_LABEL_LENGTH ? val.slice(0, MAX_LABEL_LENGTH) : val,
					},
				};
			}),
			count: "count" in value ? value.count : undefined,
			sum: "sum" in value ? value.sum : undefined,
			bucketCounts: "counts" in value ? value.counts : undefined,
			explicitBounds: "buckets" in value ? value.buckets : undefined,
		}));
	}
	return snapshot.values.map((value) => ({
		attributes: Object.entries(value.labels).map(([key, item]) => {
			const redacted = redactSecrets({ [key]: item }) as Record<string, string>;
			const val = String(redacted[key] ?? item);
			return {
				key,
				value: {
					stringValue: val.length > MAX_LABEL_LENGTH ? val.slice(0, MAX_LABEL_LENGTH) : val,
				},
			};
		}),
		asDouble: "value" in value ? value.value : undefined,
		count: "count" in value ? value.count : undefined,
		sum: "sum" in value ? value.sum : undefined,
	}));
}

export function convertToOTLP(snapshots: MetricSnapshot[]): unknown {
	return {
		resourceMetrics: [
			{
				resource: {
					attributes: [
						{
							key: "service.name",
							value: { stringValue: "pi-crew" },
						},
					],
				},
				scopeMetrics: [
					{
						scope: { name: "pi-crew" },
						metrics: snapshots.map((snapshot) => ({
							name: snapshot.name,
							description: snapshot.description,
							[snapshot.type === "histogram" ? "histogram" : snapshot.type === "gauge" ? "gauge" : "sum"]: {
								dataPoints: pointValues(snapshot),
							},
						})),
					},
				],
			},
		],
	};
}

export class OTLPExporter implements MetricExporter {
	name = "otlp";
	private timer?: ReturnType<typeof setInterval>;
	// FIX (Round 15): Track in-flight pushes so a slow network cannot cause
	// the setInterval to overlap and pile up concurrent requests.
	private inFlight: Promise<void> | null = null;
	private readonly opts: OTLPExporterOptions;
	private readonly registry: MetricRegistry;

	constructor(opts: OTLPExporterOptions, registry: MetricRegistry) {
		validateEndpoint(opts.endpoint);
		this.opts = opts;
		this.registry = registry;
	}

	start(): void {
		this.dispose();
		this.timer = setInterval(() => {
			// Skip if a previous push is still running; the next tick will retry.
			if (this.inFlight) return;
			const snap = this.registry.snapshot();
			this.inFlight = this.push(snap).finally(() => {
				this.inFlight = null;
			});
		}, this.opts.intervalMs ?? 60_000);
		this.timer.unref();
	}

	async push(snapshots: MetricSnapshot[]): Promise<void> {
		try {
			// CFG-6: re-validate the endpoint after DNS resolution to block
			// rebinding from a public hostname to a private/metadata IP
			// between construction time and the actual fetch. Failures are
			// logged and the push is skipped — no metrics reach the bad host.
			try {
				await assertResolvedAddressSafe(this.opts.endpoint);
			} catch (error) {
				logInternalError("otlp-export-ssrf", error);
				return;
			}
			// FIX (Round 15): Cap snapshots to a safe size to avoid OOM and
			// oversized HTTP payloads. Log a warning if we are truncating.
			let toSend = snapshots;
			if (snapshots.length > MAX_SNAPSHOTS_PER_PUSH) {
				logInternalError(
					"otlp-export-cap",
					new Error(`Snapshot count ${snapshots.length} exceeds cap ${MAX_SNAPSHOTS_PER_PUSH}; truncating`),
				);
				toSend = snapshots.slice(0, MAX_SNAPSHOTS_PER_PUSH);
			}
			const timeoutMs = this.opts.timeoutMs ?? 10_000;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				// 4.2: gzip body. OTLP HTTP exporters of every flavour accept
				// `content-encoding: gzip`; collectors expect uncompressed JSON
				// otherwise. Saves bandwidth on metric-heavy runs (often 3-5x).
				const json = JSON.stringify(convertToOTLP(toSend));
				const body = await gzipAsync(Buffer.from(json));
				const response = await fetch(this.opts.endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-encoding": "gzip",
						...(this.opts.headers ?? {}),
					},
					body,
					signal: controller.signal,
				});
				if (!response.ok) {
					logInternalError(
						"otlp-export-http",
						new Error(`HTTP ${response.status}: ${response.statusText}`),
						`endpoint=${this.opts.endpoint}`,
					);
				}
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			logInternalError("otlp-export", error);
		}
	}

	/**
	 * FIX (Round 23, resource cleanup): Make dispose() async and await the
	 * in-flight push so it completes (or aborts) before we return. The push
	 * itself is bounded by the 10s fetch timeout, so this won't hang
	 * indefinitely. Without this, dispose() would orphan an in-flight
	 * network request whose result is then discarded.
	 */
	async dispose(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.inFlight) {
			try {
				await this.inFlight;
			} catch {
				/* swallow — push() already logs errors */
			}
		}
	}
}
