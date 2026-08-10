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

/**
 * Maximum number of unique label combinations per metric.
 *
 * When this cap is reached, the oldest label combination is silently
 * evicted (FIFO by insertion order, with MRU promotion on use). Read
 * {@link getCardinalityEvictions} to detect when aggregation has become
 * unreliable for high-cardinality labels.
 */
const MAX_LABEL_COMBINATIONS = 10_000;

/**
 * Cumulative count of label-combination evictions across all metrics in
 * this process. Incremented every time {@link enforceLabelCap} drops an
 * entry. Exported so observability wiring and OTLP/Prometheus exporters
 * can surface `crew.metrics.cardinality_evicted` without risking the
 * recursion of routing this signal through a `Counter` (a Counter itself
 * consumes a label slot and could self-evict).
 */
let cardinalityEvictions = 0;

/**
 * Returns the cumulative number of metric label-combination evictions
 * that have occurred in this process. A non-zero value means at least
 * one metric exceeded {@link MAX_LABEL_COMBINATIONS} and silently dropped
 * the oldest label combination — aggregation for high-cardinality labels
 * is unreliable.
 */
export function getCardinalityEvictions(): number {
	return cardinalityEvictions;
}

/** Reset the eviction counter. Intended for tests only. */
export function _resetCardinalityEvictionsForTests(): void {
	cardinalityEvictions = 0;
}

function enforceLabelCap(map: Map<string, unknown>, _metricName: string): void {
	while (map.size > MAX_LABEL_COMBINATIONS) {
		const firstKey = map.keys().next().value;
		if (firstKey !== undefined) {
			map.delete(firstKey);
			cardinalityEvictions++;
		} else {
			break;
		}
	}
}

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
		if (!Number.isFinite(delta) || delta < 0) return;
		const key = labelKey(labels);
		const current = this.values.get(key) ?? {
			labels: normalizeLabels(labels),
			value: 0,
		};
		// Delete before set to move key to end of insertion order (MRU).
		// Without this, enforceLabelCap could evict an actively-used entry.
		this.values.delete(key);
		this.values.set(key, {
			labels: current.labels,
			value: current.value + delta,
		});
		enforceLabelCap(this.values, this.name);
	}

	value(labels: MetricLabels = {}): number {
		return this.values.get(labelKey(labels))?.value ?? 0;
	}

	snapshot(): MetricSnapshot {
		return {
			type: "counter",
			name: this.name,
			description: this.description,
			values: [...this.values.values()].map((entry) => ({
				labels: cloneLabels(entry.labels),
				value: entry.value,
			})),
		};
	}
}

export class Gauge extends Metric {
	private values = new Map<string, StoredValue>();

	set(labels: MetricLabels = {}, value: number): void {
		if (!Number.isFinite(value)) return;
		const key = labelKey(labels);
		// Delete before set to move key to end of insertion order (MRU).
		this.values.delete(key);
		this.values.set(key, { labels: normalizeLabels(labels), value });
		enforceLabelCap(this.values, this.name);
	}

	add(labels: MetricLabels = {}, delta: number): void {
		if (!Number.isFinite(delta)) return;
		this.set(labels, this.value(labels) + delta);
	}

	value(labels: MetricLabels = {}): number {
		return this.values.get(labelKey(labels))?.value ?? 0;
	}

	snapshot(): MetricSnapshot {
		return {
			type: "gauge",
			name: this.name,
			description: this.description,
			values: [...this.values.values()].map((entry) => ({
				labels: cloneLabels(entry.labels),
				value: entry.value,
			})),
		};
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
		const existing = this.observations.get(key);
		const current = existing ?? {
			labels: normalizeLabels(labels),
			counts: new Array(this.buckets.length + 1).fill(0) as number[],
			sum: 0,
			count: 0,
		};
		const bucketIndex = this.buckets.findIndex((bucket) => value <= bucket);
		current.counts[bucketIndex === -1 ? this.buckets.length : bucketIndex] =
			(current.counts[bucketIndex === -1 ? this.buckets.length : bucketIndex] ?? 0) + 1;
		current.sum += value;
		current.count += 1;
		if (!existing) this.observations.set(key, current);
		enforceLabelCap(this.observations, this.name);
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
				const lower = index === 0 ? 0 : (this.buckets[index - 1] ?? this.buckets.at(-1) ?? 0);
				const upper =
					index < this.buckets.length ? (this.buckets[index] ?? lower) : Math.max(lower, obs.sum / Math.max(1, obs.count));
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
				quantiles: {
					p50: this.quantile(entry.labels, 0.5),
					p95: this.quantile(entry.labels, 0.95),
					p99: this.quantile(entry.labels, 0.99),
				},
			})),
		};
	}
}
