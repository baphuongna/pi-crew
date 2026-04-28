import * as fs from "node:fs";

interface TimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimerApi: TimerApi = {
	setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface FileCoalescer {
	schedule(file: string, delayMs?: number): boolean;
	clear(): void;
}

export function createFileCoalescer(handler: (file: string) => void, defaultDelayMs: number, timerApi: TimerApi = defaultTimerApi): FileCoalescer {
	const pending = new Map<string, unknown>();
	return {
		schedule(file, delayMs = defaultDelayMs) {
			if (pending.has(file)) return false;
			const timer = timerApi.setTimeout(() => {
				pending.delete(file);
				handler(file);
			}, delayMs);
			pending.set(file, timer);
			return true;
		},
		clear() {
			for (const timer of pending.values()) timerApi.clearTimeout(timer);
			pending.clear();
		},
	};
}

interface ReadCacheEntry<T> {
	value: T;
	mtimeMs: number;
	size: number;
	expiresAt: number;
}

const readCache = new Map<string, ReadCacheEntry<unknown>>();
const readCacheSizeLimit = 128;

function evictOldestCacheEntry(): void {
	if (readCache.size < readCacheSizeLimit) return;
	const oldestKey = readCache.keys().next().value;
	if (oldestKey !== undefined) {
		readCache.delete(oldestKey);
	}
}

export function clearReadCache(): void {
	readCache.clear();
}

export function readJsonFileCoalesced<T>(filePath: string, ttlMs: number, read: () => T): T {
	const now = Date.now();
	const stat = (() => {
		try {
			const fileStat = fs.statSync(filePath);
			return { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
		} catch {
			return undefined;
		}
	})();
	const cached = readCache.get(filePath);
	if (cached && stat && cached.expiresAt > now && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.value as T;
	}
	const value = read();
	if (stat !== undefined) {
		readCache.set(filePath, {
			value,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			expiresAt: now + ttlMs,
		});
		evictOldestCacheEntry();
	}
	return value;
}
