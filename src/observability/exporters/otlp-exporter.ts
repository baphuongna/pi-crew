import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import type { MetricRegistry } from "../metric-registry.ts";
import type { MetricSnapshot } from "../metrics-primitives.ts";
import type { MetricExporter } from "./adapter.ts";

const gzipAsync = promisify(gzip);

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
				return { key, value: { stringValue: val.length > MAX_LABEL_LENGTH ? val.slice(0, MAX_LABEL_LENGTH) : val } };
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
			return { key, value: { stringValue: val.length > MAX_LABEL_LENGTH ? val.slice(0, MAX_LABEL_LENGTH) : val } };
		}),
		asDouble: "value" in value ? value.value : undefined,
		count: "count" in value ? value.count : undefined,
		sum: "sum" in value ? value.sum : undefined,
	}));
}

export function convertToOTLP(snapshots: MetricSnapshot[]): unknown {
	return {
		resourceMetrics: [{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "pi-crew" } }] },
			scopeMetrics: [{
				scope: { name: "pi-crew" },
				metrics: snapshots.map((snapshot) => ({ name: snapshot.name, description: snapshot.description, [snapshot.type === "histogram" ? "histogram" : snapshot.type === "gauge" ? "gauge" : "sum"]: { dataPoints: pointValues(snapshot) } })),
			}],
		}],
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
		this.opts = opts;
		this.registry = registry;
	}

	start(): void {
		this.dispose();
		this.timer = setInterval(() => {
			// Skip if a previous push is still running; the next tick will retry.
			if (this.inFlight) return;
			const snap = this.registry.snapshot();
			this.inFlight = this.push(snap).finally(() => { this.inFlight = null; });
		}, this.opts.intervalMs ?? 60_000);
		this.timer.unref();
	}

	async push(snapshots: MetricSnapshot[]): Promise<void> {
		try {
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
					headers: { "content-type": "application/json", "content-encoding": "gzip", ...(this.opts.headers ?? {}) },
					body,
					signal: controller.signal,
				});
				if (!response.ok) {
					logInternalError("otlp-export-http", new Error(`HTTP ${response.status}: ${response.statusText}`), `endpoint=${this.opts.endpoint}`);
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
			try { await this.inFlight; } catch { /* swallow — push() already logs errors */ }
		}
	}
}
