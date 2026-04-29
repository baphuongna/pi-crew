import type { HistogramPoint, MetricLabels, MetricPoint, MetricSnapshot } from "../metrics-primitives.ts";

function prometheusName(name: string): string {
	return name.replace(/\./g, "_");
}

function escapeLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function labelsText(labels: MetricLabels): string {
	const entries = Object.entries(labels);
	if (!entries.length) return "";
	return `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(",")}}`;
}

function metricType(type: MetricSnapshot["type"]): string {
	return type === "histogram" ? "histogram" : type === "gauge" ? "gauge" : "counter";
}

function isHistogramPoint(value: MetricPoint | HistogramPoint): value is HistogramPoint {
	return "buckets" in value && "counts" in value;
}

export function formatPrometheus(snapshots: MetricSnapshot[]): string {
	const lines: string[] = [];
	for (const snapshot of snapshots) {
		const name = prometheusName(snapshot.name);
		lines.push(`# HELP ${name} ${snapshot.description}`);
		lines.push(`# TYPE ${name} ${metricType(snapshot.type)}`);
		for (const value of snapshot.values) {
			if (isHistogramPoint(value)) {
				let cumulative = 0;
				for (let index = 0; index < value.buckets.length; index += 1) {
					cumulative += value.counts[index] ?? 0;
					const le = Number.isFinite(value.buckets[index]) ? String(value.buckets[index]) : "+Inf";
					lines.push(`${name}_bucket${labelsText({ ...value.labels, le })} ${cumulative}`);
				}
				lines.push(`${name}_sum${labelsText(value.labels)} ${value.sum}`);
				lines.push(`${name}_count${labelsText(value.labels)} ${value.count}`);
			} else {
				lines.push(`${name}${labelsText(value.labels)} ${value.value}`);
			}
		}
	}
	return `${lines.join("\n")}\n`;
}
