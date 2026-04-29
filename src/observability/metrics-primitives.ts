export type MetricLabelValue = string | number;
export type MetricLabels = Record<string, MetricLabelValue>;

export interface MetricPoint {
	labels: MetricLabels;
	value: number;
}

export interface HistogramPoint {
	labels: MetricLabels;
	buckets: number[];
	counts: number[];
	sum: number;
	count: number;
	quantiles: Record<string, number>;
}

export interface MetricSnapshot {
	type: "counter" | "gauge" | "histogram";
	name: string;
	description: string;
	values: MetricPoint[] | HistogramPoint[];
}

interface StoredValue {
	labels: MetricLabels;
	value: number;
}

interface StoredHistogram {
	labels: MetricLabels;
	counts: number[];
	sum: number;
	count: number;
}

export const DEFAULT_HISTOGRAM_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;

function normalizeLabels(labels: MetricLabels = {}): MetricLabels {
	const normalized: MetricLabels = {};
	for (const [key, value] of Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))) normalized[key] = value;
	return normalized;
}

export function labelKey(labels: MetricLabels = {}): string {
	return JSON.stringify(normalizeLabels(labels));
}

function cloneLabels(labels: MetricLabels): MetricLabels {
	return { ...labels };
}

export abstract class Metric {
	readonly name: string;
	readonly description: string;

	constructor(name: string, description: string) {
		this.name = name;
		this.description = description;
	}

	abstract snapshot(): MetricSnapshot;
}

export class Counter extends Metric {
	private values = new Map<string, StoredValue>();

	inc(labels: MetricLabels = {}, delta = 1): void {
		if (!Number.isFinite(delta)) return;
		const key = labelKey(labels);
		const current = this.values.get(key) ?? { labels: normalizeLabels(labels), value: 0 };
		this.values.set(key, { labels: current.labels, value: current.value + delta });
	}

	value(labels: MetricLabels = {}): number {
		return this.values.get(labelKey(labels))?.value ?? 0;
	}

	snapshot(): MetricSnapshot {
		return { type: "counter", name: this.name, description: this.description, values: [...this.values.values()].map((entry) => ({ labels: cloneLabels(entry.labels), value: entry.value })) };
	}
}

export class Gauge extends Metric {
	private values = new Map<string, StoredValue>();

	set(labels: MetricLabels = {}, value: number): void {
		if (!Number.isFinite(value)) return;
		this.values.set(labelKey(labels), { labels: normalizeLabels(labels), value });
	}

	add(labels: MetricLabels = {}, delta: number): void {
		if (!Number.isFinite(delta)) return;
		this.set(labels, this.value(labels) + delta);
	}

	value(labels: MetricLabels = {}): number {
		return this.values.get(labelKey(labels))?.value ?? 0;
	}

	snapshot(): MetricSnapshot {
		return { type: "gauge", name: this.name, description: this.description, values: [...this.values.values()].map((entry) => ({ labels: cloneLabels(entry.labels), value: entry.value })) };
	}
}

export class Histogram extends Metric {
	private readonly buckets: number[];
	private observations = new Map<string, StoredHistogram>();

	constructor(name: string, description: string, buckets?: number[]) {
		super(name, description);
		const source = buckets?.length ? buckets : [...DEFAULT_HISTOGRAM_BUCKETS];
		this.buckets = [...new Set(source.filter((bucket) => Number.isFinite(bucket)).sort((left, right) => left - right))];
	}

	observe(labels: MetricLabels = {}, value: number): void {
		if (!Number.isFinite(value)) return;
		const key = labelKey(labels);
		const current = this.observations.get(key) ?? { labels: normalizeLabels(labels), counts: new Array(this.buckets.length + 1).fill(0) as number[], sum: 0, count: 0 };
		const bucketIndex = this.buckets.findIndex((bucket) => value <= bucket);
		current.counts[bucketIndex === -1 ? this.buckets.length : bucketIndex] = (current.counts[bucketIndex === -1 ? this.buckets.length : bucketIndex] ?? 0) + 1;
		current.sum += value;
		current.count += 1;
		this.observations.set(key, current);
	}

	quantile(labels: MetricLabels = {}, q: number): number {
		const obs = this.observations.get(labelKey(labels));
		if (!obs || obs.count === 0 || !Number.isFinite(q)) return Number.NaN;
		const bounded = Math.min(1, Math.max(0, q));
		const target = Math.max(1, bounded * obs.count);
		let cumulative = 0;
		for (let index = 0; index < obs.counts.length; index += 1) {
			const count = obs.counts[index] ?? 0;
			cumulative += count;
			if (cumulative >= target) {
				const previous = cumulative - count;
				const lower = index === 0 ? 0 : this.buckets[index - 1] ?? this.buckets.at(-1) ?? 0;
				const upper = index < this.buckets.length ? this.buckets[index] ?? lower : Math.max(lower, obs.sum / Math.max(1, obs.count));
				const fraction = count === 0 ? 0 : (target - previous) / Math.max(1, count);
				return lower + fraction * (upper - lower);
			}
		}
		return this.buckets.at(-1) ?? Number.NaN;
	}

	count(labels: MetricLabels = {}): number {
		return this.observations.get(labelKey(labels))?.count ?? 0;
	}

	snapshot(): MetricSnapshot {
		return {
			type: "histogram",
			name: this.name,
			description: this.description,
			values: [...this.observations.values()].map((entry) => ({
				labels: cloneLabels(entry.labels),
				buckets: [...this.buckets, Number.POSITIVE_INFINITY],
				counts: [...entry.counts],
				sum: entry.sum,
				count: entry.count,
				quantiles: { p50: this.quantile(entry.labels, 0.5), p95: this.quantile(entry.labels, 0.95), p99: this.quantile(entry.labels, 0.99) },
			})),
		};
	}
}
