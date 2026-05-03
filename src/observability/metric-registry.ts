import { Counter, Gauge, Histogram, type Metric, type MetricSnapshot } from "./metrics-primitives.ts";

const METRIC_NAME_PATTERN = /^crew\.[a-z]+\.[a-z][a-z_]*$/;

function assertMetricName(name: string): void {
	if (!METRIC_NAME_PATTERN.test(name)) throw new Error(`Invalid metric name '${name}'. Expected crew.<domain>.<measure>.`);
}

export class MetricRegistry {
	private metrics = new Map<string, Metric>();

	registerCounter(name: string, description: string): Counter {
		assertMetricName(name);
		if (this.metrics.has(name)) throw new Error(`Metric '${name}' is already registered.`);
		const metric = new Counter(name, description);
		this.metrics.set(name, metric);
		return metric;
	}

	registerGauge(name: string, description: string): Gauge {
		assertMetricName(name);
		if (this.metrics.has(name)) throw new Error(`Metric '${name}' is already registered.`);
		const metric = new Gauge(name, description);
		this.metrics.set(name, metric);
		return metric;
	}

	registerHistogram(name: string, description: string, buckets?: number[]): Histogram {
		assertMetricName(name);
		if (this.metrics.has(name)) throw new Error(`Metric '${name}' is already registered.`);
		const metric = new Histogram(name, description, buckets);
		this.metrics.set(name, metric);
		return metric;
	}

	counter(name: string, description: string): Counter {
		const existing = this.metrics.get(name);
		if (existing instanceof Counter) {
			if (existing.description !== description) {
				process.stderr.write(`[pi-crew] metric-registry: counter '${name}' description changed; using original: '${existing.description}'\n`);
			}
			return existing;
		}
		if (existing) throw new Error(`Metric '${name}' is not a counter.`);
		return this.registerCounter(name, description);
	}

	gauge(name: string, description: string): Gauge {
		const existing = this.metrics.get(name);
		if (existing instanceof Gauge) {
			if (existing.description !== description) {
				process.stderr.write(`[pi-crew] metric-registry: gauge '${name}' description changed; using original: '${existing.description}'\n`);
			}
			return existing;
		}
		if (existing) throw new Error(`Metric '${name}' is not a gauge.`);
		return this.registerGauge(name, description);
	}

	histogram(name: string, description: string, buckets?: number[]): Histogram {
		const existing = this.metrics.get(name);
		if (existing instanceof Histogram) {
			if (existing.description !== description) {
				process.stderr.write(`[pi-crew] metric-registry: histogram '${name}' description changed; using original: '${existing.description}'\n`);
			}
			return existing;
		}
		if (existing) throw new Error(`Metric '${name}' is not a histogram.`);
		return this.registerHistogram(name, description, buckets);
	}

	get(name: string): Metric | undefined {
		return this.metrics.get(name);
	}

	snapshot(): MetricSnapshot[] {
		return [...this.metrics.values()].map((metric) => metric.snapshot());
	}

	dispose(): void {
		this.metrics.clear();
	}
}

export function createMetricRegistry(): MetricRegistry {
	return new MetricRegistry();
}
