import type { MetricSnapshot } from "../metrics-primitives.ts";

export interface MetricExporter {
	name: string;
	push(snapshots: MetricSnapshot[]): Promise<void>;
	dispose(): void;
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

	dispose(): void {
		for (const exporter of this.exporters) exporter.dispose();
	}
}
