import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "../utils/redaction.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { MetricRegistry } from "./metric-registry.ts";
import type { MetricSnapshot } from "./metrics-primitives.ts";

export interface MetricSink {
	writeSnapshot(snapshots: MetricSnapshot[]): void;
	dispose(): void;
}

export interface MetricFileSinkOptions {
	crewRoot: string;
	registry: MetricRegistry;
	retentionDays?: number;
	intervalMs?: number;
}

function rotateOldFiles(dir: string, retentionDays: number, now = Date.now()): void {
	if (!fs.existsSync(dir)) return;
	const maxAge = retentionDays * 24 * 60 * 60 * 1000;
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		const fullPath = path.join(dir, file);
		try {
			if (now - fs.statSync(fullPath).mtimeMs > maxAge) fs.unlinkSync(fullPath);
		} catch (error) {
			logInternalError("metric-sink.rotate", error, fullPath);
		}
	}
}

export function createMetricFileSink(opts: MetricFileSinkOptions): MetricSink {
	const dir = path.join(opts.crewRoot, "state", "metrics");
	const retentionDays = opts.retentionDays ?? 7;
	const writeSnapshot = (snapshots: MetricSnapshot[]): void => {
		try {
			const now = new Date();
			const date = now.toISOString().slice(0, 10);
			fs.mkdirSync(dir, { recursive: true });
			rotateOldFiles(dir, retentionDays);
			const redacted = redactSecrets(snapshots) as MetricSnapshot[];
			fs.appendFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify({ exportedAt: now.toISOString(), snapshots: redacted })}\n`, "utf-8");
		} catch (error) {
			logInternalError("metric-sink.write", error);
		}
	};
	const timer = setInterval(() => writeSnapshot(opts.registry.snapshot()), opts.intervalMs ?? 60_000);
	timer.unref?.();
	return { writeSnapshot, dispose: () => clearInterval(timer) };
}
