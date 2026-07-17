import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";
import type { MetricRegistry } from "./metric-registry.ts";
import type { MetricSnapshot } from "./metrics-primitives.ts";

export interface MetricSink {
	writeSnapshot(snapshots: MetricSnapshot[]): void | Promise<void>;
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
	// 4.1: hold a single open fd per UTC date instead of `appendFileSync` per
	// snapshot. Avoids open/close syscalls each tick and keeps the
	// synchronous write semantics that callers (and tests) expect.
	let fd: number | undefined;
	let fdDate: string | undefined;
	const ensureFd = (date: string): number => {
		if (fd !== undefined && fdDate === date) return fd;
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch (error) {
				logInternalError("metric-sink.closeFd", error);
			}
		}
		fs.mkdirSync(dir, { recursive: true });
		rotateOldFiles(dir, retentionDays);
		fd = fs.openSync(path.join(dir, `${date}.jsonl`), "a");
		fdDate = date;
		return fd;
	};
	const writeSnapshot = (snapshots: MetricSnapshot[]): Promise<void> => {
		try {
			const now = new Date();
			const date = now.toISOString().slice(0, 10);
			const redacted = redactSecrets(snapshots);
			if (!Array.isArray(redacted)) {
				logInternalError("metric-sink.type", new Error("redactSecrets did not return an array"), `got=${typeof redacted}`);
				return Promise.resolve();
			}
			const target = ensureFd(date);
			const line = `${JSON.stringify({ exportedAt: now.toISOString(), snapshots: redacted as MetricSnapshot[] })}\n`;
			// Async write to avoid blocking the main thread on the 60s tick.
			// Return a promise that resolves once the write callback fires so
			// tests (and any callers awaiting) can synchronize on completion.
			return new Promise<void>((resolve) => {
				fs.write(target, line, (err) => {
					if (err) logInternalError("metric-sink.asyncWrite", err);
					resolve();
				});
			});
		} catch (error) {
			logInternalError("metric-sink.write", error);
			return Promise.resolve();
		}
	};
	const timer = setInterval(() => writeSnapshot(opts.registry.snapshot()), opts.intervalMs ?? 60_000);
	timer.unref();
	return {
		writeSnapshot,
		dispose: () => {
			clearInterval(timer);
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch (error) {
					logInternalError("metric-sink.dispose", error);
				}
				fd = undefined;
				fdDate = undefined;
			}
		},
	};
}
