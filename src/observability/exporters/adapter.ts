import type { MetricSnapshot } from "../metrics-primitives.ts";

export interface MetricExporter {
	name: string;
	push(snapshots: MetricSnapshot[]): Promise<void>;
	dispose(): Promise<void>;
}

export class CompositeExporter implements MetricExporter {
	name = "composite";
	private readonly exporters: MetricExporter[];

	constructor(exporters: MetricExporter[]) {
		this.exporters = exporters;
	}

	async push(snapshots: MetricSnapshot[]): Promise<void> {
		await Promise.allSettled(this.exporters.map((exporter) => exporter.push(snapshots)));
	}

	async dispose(): Promise<void> {
		// OBS-3: await allSettled so an async exporter cleanup (e.g. OTLPExporter awaiting
		// an in-flight HTTP push) isn't cut short. Interface contract changed from `void`
		// to `Promise<void>` because exporters may have async teardown.
		await Promise.allSettled(this.exporters.map((exporter) => exporter.dispose()));
	}
}
