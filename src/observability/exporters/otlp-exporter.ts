import { logInternalError } from "../../utils/internal-error.ts";
import type { MetricRegistry } from "../metric-registry.ts";
import type { MetricSnapshot } from "../metrics-primitives.ts";
import type { MetricExporter } from "./adapter.ts";

export interface OTLPExporterOptions {
	endpoint: string;
	headers?: Record<string, string>;
	intervalMs?: number;
	timeoutMs?: number;
}

function pointValues(snapshot: MetricSnapshot): unknown[] {
	if (snapshot.type === "histogram") {
		return snapshot.values.map((value) => ({
			attributes: Object.entries(value.labels).map(([key, item]) => ({ key, value: { stringValue: String(item) } })),
			count: "count" in value ? value.count : undefined,
			sum: "sum" in value ? value.sum : undefined,
			bucketCounts: "counts" in value ? value.counts : undefined,
			explicitBounds: "buckets" in value ? value.buckets : undefined,
		}));
	}
	return snapshot.values.map((value) => ({ attributes: Object.entries(value.labels).map(([key, item]) => ({ key, value: { stringValue: String(item) } })), asDouble: "value" in value ? value.value : undefined, count: "count" in value ? value.count : undefined, sum: "sum" in value ? value.sum : undefined }));
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
	private readonly opts: OTLPExporterOptions;
	private readonly registry: MetricRegistry;

	constructor(opts: OTLPExporterOptions, registry: MetricRegistry) {
		this.opts = opts;
		this.registry = registry;
	}

	start(): void {
		this.dispose();
		this.timer = setInterval(() => { void this.push(this.registry.snapshot()); }, this.opts.intervalMs ?? 60_000);
		this.timer.unref();
	}

	async push(snapshots: MetricSnapshot[]): Promise<void> {
		try {
			const timeoutMs = this.opts.timeoutMs ?? 10_000;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(this.opts.endpoint, { method: "POST", headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) }, body: JSON.stringify(convertToOTLP(snapshots)), signal: controller.signal });
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

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
