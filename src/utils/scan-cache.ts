import * as fs from "node:fs";
import * as path from "node:path";

export interface ScanEntry {
	/** Unique key for this entry (e.g., runId, artifactPath) */
	key: string;
	/** Filesystem path */
	path: string;
	/** Raw content (parsed JSON or text) */
	raw: unknown;
	/** File modification time */
	mtimeMs: number;
	/** File size in bytes */
	sizeBytes: number;
	/** When this entry was loaded */
	loadedAtMs: number;
}

export interface ScanCacheOptions {
	/** TTL in ms for cached entries. Default 1000. */
	ttlMs?: number;
	/** Maximum number of entries. Default 100. */
	maxEntries?: number;
}

interface CacheBucket {
	entries: Map<string, ScanEntry>;
	expireAtMs: number;
}

/**
 * Shared raw scan-entry cache for runs, artifacts, mailbox, transcripts.
 * Provides deterministic sort order and invalidation on mutation.
 */
export class SharedScanCache {
	#buckets = new Map<string, CacheBucket>();
	#ttlMs: number;
	#maxEntries: number;
	#now: () => number;

	constructor(options: ScanCacheOptions = {}) {
		this.#ttlMs = options.ttlMs ?? 1000;
		this.#maxEntries = options.maxEntries ?? 100;
		this.#now = () => Date.now();
	}

	/** Get a cached entry by bucket and key. Returns undefined if not cached or expired. */
	get(bucket: string, key: string): ScanEntry | undefined {
		const b = this.#buckets.get(bucket);
		if (!b) return undefined;
		if (this.#now() > b.expireAtMs) {
			this.#buckets.delete(bucket);
			return undefined;
		}
		return b.entries.get(key);
	}

	/** Get all entries in a bucket. Returns empty array if expired or missing. */
	list(bucket: string): ScanEntry[] {
		const b = this.#buckets.get(bucket);
		if (!b) return [];
		if (this.#now() > b.expireAtMs) {
			this.#buckets.delete(bucket);
			return [];
		}
		return [...b.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
	}

	/** Set an entry in a bucket. */
	set(bucket: string, entry: ScanEntry): void {
		let b = this.#buckets.get(bucket);
		if (!b || this.#now() > b.expireAtMs) {
			b = { entries: new Map(), expireAtMs: this.#now() + this.#ttlMs };
			this.#buckets.set(bucket, b);
		}
		if (b.entries.size >= this.#maxEntries) {
			// Evict oldest entry
			const firstKey = b.entries.keys().next().value;
			if (firstKey !== undefined) b.entries.delete(firstKey);
		}
		b.entries.set(entry.key, entry);
	}

	/** Invalidate a specific key in a bucket. */
	invalidate(bucket: string, key: string): void {
		const b = this.#buckets.get(bucket);
		if (b) b.entries.delete(key);
	}

	/** Invalidate an entire bucket. */
	invalidateBucket(bucket: string): void {
		this.#buckets.delete(bucket);
	}

	/** Invalidate all buckets. */
	clear(): void {
		this.#buckets.clear();
	}

	/** Read a file, parse if JSON, and cache the result. */
	readAndCache(bucket: string, key: string, filePath: string, parseJson = true): ScanEntry | undefined {
		try {
			if (!fs.existsSync(filePath)) return undefined;
			const stat = fs.statSync(filePath);
			const cached = this.get(bucket, key);
			if (cached && cached.mtimeMs >= stat.mtimeMs && cached.sizeBytes === stat.size) return cached;
			const content = fs.readFileSync(filePath, "utf-8");
			const raw = parseJson ? JSON.parse(content) : content;
			const entry: ScanEntry = { key, path: filePath, raw, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, loadedAtMs: this.#now() };
			this.set(bucket, entry);
			return entry;
		} catch {
			return undefined;
		}
	}

	/** Read a directory and cache entries for each file. */
	scanAndCache(bucket: string, dirPath: string, parseJson = true): ScanEntry[] {
		try {
			if (!fs.existsSync(dirPath)) return [];
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			const results: ScanEntry[] = [];
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				const filePath = path.join(dirPath, entry.name);
				const cached = this.readAndCache(bucket, entry.name, filePath, parseJson);
				if (cached) results.push(cached);
			}
			return results.sort((a, b) => a.key.localeCompare(b.key));
		} catch {
			return [];
		}
	}
}

/** Global shared scan cache instance. */
export const sharedScanCache = new SharedScanCache();