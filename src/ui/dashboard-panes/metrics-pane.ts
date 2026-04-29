import type { MetricRegistry } from "../../observability/metric-registry.ts";
import type { HistogramPoint, MetricLabels, MetricPoint } from "../../observability/metrics-primitives.ts";
import type { RunUiSnapshot } from "../snapshot-types.ts";

export interface MetricsPaneOptions {
	registry?: MetricRegistry;
	maxCounters?: number;
}

function labelsText(labels: MetricLabels): string {
	const entries = Object.entries(labels);
	return entries.length ? `{${entries.map(([key, value]) => `${key}=${value}`).join(",")}}` : "";
}

function isHistogramPoint(point: MetricPoint | HistogramPoint): point is HistogramPoint {
	return "quantiles" in point;
}

export function renderMetricsPane(_snapshot: RunUiSnapshot | undefined, opts: MetricsPaneOptions = {}): string[] {
	if (!opts.registry) return ["Metrics pane: registry unavailable"];
	const snapshots = opts.registry.snapshot();
	if (!snapshots.length) return ["Metrics pane: no metrics recorded"];
	const lines = ["Metrics pane: top metrics"];
	for (const snapshot of snapshots.slice(0, opts.maxCounters ?? 10)) {
		const first = snapshot.values[0];
		if (!first) {
			lines.push(`${snapshot.name}: empty`);
			continue;
		}
		if (isHistogramPoint(first)) lines.push(`${snapshot.name}${labelsText(first.labels)} count=${first.count} p95=${Number.isFinite(first.quantiles.p95) ? Math.round(first.quantiles.p95) : "n/a"}`);
		else lines.push(`${snapshot.name}${labelsText(first.labels)} ${first.value}`);
	}
	return lines;
}
