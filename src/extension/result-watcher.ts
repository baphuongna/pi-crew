import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "../utils/completion-dedupe.ts";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { createFileCoalescer } from "../utils/file-coalescer.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface ResultWatcherEvents {
	emit(event: string, data: unknown): void;
}

export interface ResultWatcherHandle {
	start(): void;
	prime(): void;
	stop(): void;
}

interface ResultWatcherDependencies {
	watch?: typeof watchWithErrorHandler;
}

export interface ResultWatcherOptions extends ResultWatcherDependencies {
	eventName?: string;
	completionTtlMs?: number;
	isCurrent?: () => boolean;
}

const RESULT_WATCHER_RESTART_MS = 3000;

function readJson(filePath: string): unknown | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
	} catch (error) {
		logInternalError("result-watcher.parse", error, `filePath=${filePath}`);
		return undefined;
	}
}

export function createResultWatcher(events: ResultWatcherEvents, resultsDir: string, eventNameOrOptions: string | ResultWatcherOptions = "pi-crew:run-result"): ResultWatcherHandle {
	const options: ResultWatcherOptions = typeof eventNameOrOptions === "string" ? { eventName: eventNameOrOptions } : eventNameOrOptions;
	const eventName = options.eventName ?? "pi-crew:run-result";
	const completionTtlMs = options.completionTtlMs ?? 5 * 60_000;
	const watch = options.watch ?? watchWithErrorHandler;
	const isCurrent = options.isCurrent ?? (() => true);
	const seen = getGlobalSeenMap("pi-crew.result-watcher");
	let watcher: fs.FSWatcher | null | undefined;
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	const coalescer = createFileCoalescer((file) => {
		if (!isCurrent()) return;
		const filePath = path.join(resultsDir, file);
		if (!file.endsWith(".json") || !fs.existsSync(filePath)) return;
		const payload = readJson(filePath);
		if (payload !== undefined) {
			const key = buildCompletionKey(payload as Record<string, unknown>, `file:${file}`);
			if (!markSeenWithTtl(seen, key, Date.now(), completionTtlMs)) {
				events.emit(eventName, payload);
			}
		}
		try {
			fs.unlinkSync(filePath);
		} catch (error) {
			logInternalError("result-watcher.unlink", error, `filePath=${filePath}`);
		}
	}, 50);
	const scheduleRestart = () => {
		if (restartTimer) clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			restartTimer = undefined;
			try {
				if (!isCurrent()) return;
				fs.mkdirSync(resultsDir, { recursive: true });
				handle.start();
			} catch (error) {
				logInternalError("result-watcher.restart", error, `resultsDir=${resultsDir}`);
			}
		}, RESULT_WATCHER_RESTART_MS);
		restartTimer.unref?.();
	};
	const handle: ResultWatcherHandle = {
		start() {
			if (!isCurrent()) return;
			fs.mkdirSync(resultsDir, { recursive: true });
			if (watcher) closeWatcher(watcher);
			watcher = watch(resultsDir, (event, fileName) => {
				if (event !== "rename" || !fileName) return;
				coalescer.schedule(fileName.toString());
			}, scheduleRestart);
			watcher?.unref?.();
		},
		prime() {
			if (!isCurrent() || !fs.existsSync(resultsDir)) return;
			for (const file of fs.readdirSync(resultsDir).filter((entry) => entry.endsWith(".json"))) coalescer.schedule(file, 0);
		},
		stop() {
			if (restartTimer) clearTimeout(restartTimer);
			restartTimer = undefined;
			closeWatcher(watcher);
			watcher = undefined;
			coalescer.clear();
		},
	};
	return handle;
}
