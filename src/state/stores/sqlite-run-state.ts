/**
 * U8 (upgrade-spec 2026-10-09) — sqlite run-state backend. OPT-IN; the JSON
 * file backend stays the default until sqlite is proven in production.
 *
 * What this module owns:
 *   - One sqlite file per run at `<stateRoot>/state.sqlite` (node:sqlite
 *     DatabaseSync — stdlib only, no new dependency; requires Node >= 22.5,
 *     repo pins >= 22.19).
 *   - Schema (spec-mandated, deliberately simple):
 *       tasks(id TEXT PRIMARY KEY, record TEXT NOT NULL)   — one row per task
 *       manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL) — kv; manifest row key "manifest"
 *       worker_status(task_id TEXT PRIMARY KEY, record TEXT NOT NULL) — worker-status CRUD
 *       seq(name TEXT PRIMARY KEY, value INTEGER NOT NULL) — monotonic sequences
 *   - EVERY batch write runs inside ONE explicit transaction (BEGIN IMMEDIATE
 *     … COMMIT / ROLLBACK). A crash (or error) mid-batch can never leave half
 *     a batch on disk — verified by the kill -9 crash test
 *     (test/integration/state-store-sqlite-crash.test.ts), pattern
 *     live-proven in /tmp/pi-crew-verify10-crash/ with journal_mode=wal +
 *     synchronous=1 (both set on open).
 *
 * What this module does NOT own (unchanged by U8):
 *   - events.jsonl stays the audit spine — never routed through this store.
 *   - manifest.json / tasks.json keep being written by state-store.ts as
 *     read-side MIRRORS for consumers that still read the JSON files
 *     directly (ui, prune, resume …). In sqlite mode the db is authoritative
 *     for loadRunManifestById; the mirrors are eventually-consistent copies.
 *   - JSON-backend behavior when PI_CREW_STATE_BACKEND is unset — the
 *     default path must stay byte-identical.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { getCrewEnv } from "../../config/env-vars.ts";
import type { TeamRunManifest, TeamTaskState } from "../types.ts";

/** File name of the sqlite run-state db inside the run's stateRoot. */
export const SQLITE_STATE_FILE = "state.sqlite";

/** manifest-table row key holding the run manifest record. */
const MANIFEST_KEY = "manifest";

/**
 * U8 backend select: PI_CREW_STATE_BACKEND=sqlite opts a process into the
 * sqlite run-state backend. Unset or any other value keeps the JSON backend
 * (fail-safe default). Read via getCrewEnv so the env-vars registry gate
 * stays green.
 */
export function isSqliteStateBackend(): boolean {
	return getCrewEnv("PI_CREW_STATE_BACKEND")?.trim().toLowerCase() === "sqlite";
}

/** Absolute path of the sqlite run-state db for a stateRoot. */
export function sqliteDbPath(stateRoot: string): string {
	return path.join(stateRoot, SQLITE_STATE_FILE);
}

/** A worker-status row: the owning task id plus its opaque JSON record. */
export interface SqliteWorkerStatusRecord {
	taskId: string;
	record: unknown;
}

/**
 * Synchronous sqlite-backed run-state store (DatabaseSync — matches the sync
 * save APIs of state-store.ts; the async save variants call the same sync
 * core). One instance = one open db handle; get one via
 * {@link getSqliteRunStateStore} (process-wide cache) rather than `new`.
 */
export class SqliteRunStateStore {
	private db: DatabaseSync;
	private inTx = false;
	private readonly stmtUpsertManifest: StatementSync;
	private readonly stmtGetManifest: StatementSync;
	private readonly stmtDeleteManifest: StatementSync;
	private readonly stmtInsertTask: StatementSync;
	private readonly stmtDeleteTasks: StatementSync;
	private readonly stmtSelectTasks: StatementSync;
	private readonly stmtUpsertWorkerStatus: StatementSync;
	private readonly stmtSelectWorkerStatus: StatementSync;
	private readonly stmtDeleteWorkerStatus: StatementSync;
	private readonly stmtBumpSeq: StatementSync;
	private readonly stmtInitSeq: StatementSync;
	private readonly stmtGetSeq: StatementSync;
	private closed = false;

	constructor(stateRoot: string) {
		// The stateRoot always exists by the time a save runs (createRunManifest
		// mkdirs it first), but be defensive — sqlite does not create dirs.
		fs.mkdirSync(stateRoot, { recursive: true });
		this.db = new DatabaseSync(sqliteDbPath(stateRoot));
		// Durability combo live-proven by the round-10 kill -9 harness
		// (/tmp/pi-crew-verify10-crash/): WAL journal + synchronous=1
		// (NORMAL). busy_timeout rides out cross-process writer contention
		// (parent + child processes may both hold the run state).
		this.db.exec("PRAGMA journal_mode=wal");
		this.db.exec("PRAGMA synchronous=1");
		this.db.exec("PRAGMA busy_timeout=5000");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				record TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS manifest (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS worker_status (
				task_id TEXT PRIMARY KEY,
				record TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS seq (
				name TEXT PRIMARY KEY,
				value INTEGER NOT NULL
			);
		`);
		this.stmtUpsertManifest = this.db.prepare(
			"INSERT INTO manifest (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		);
		this.stmtGetManifest = this.db.prepare("SELECT value FROM manifest WHERE key = ?");
		this.stmtDeleteManifest = this.db.prepare("DELETE FROM manifest WHERE key = ?");
		this.stmtInsertTask = this.db.prepare(
			"INSERT INTO tasks (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
		);
		this.stmtDeleteTasks = this.db.prepare("DELETE FROM tasks");
		this.stmtSelectTasks = this.db.prepare("SELECT id, record FROM tasks ORDER BY rowid");
		this.stmtUpsertWorkerStatus = this.db.prepare(
			"INSERT INTO worker_status (task_id, record) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET record = excluded.record",
		);
		this.stmtSelectWorkerStatus = this.db.prepare("SELECT task_id, record FROM worker_status ORDER BY rowid");
		this.stmtDeleteWorkerStatus = this.db.prepare("DELETE FROM worker_status WHERE task_id = ?");
		this.stmtBumpSeq = this.db.prepare("UPDATE seq SET value = value + 1 WHERE name = ?");
		this.stmtInitSeq = this.db.prepare("INSERT INTO seq (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING");
		this.stmtGetSeq = this.db.prepare("SELECT value FROM seq WHERE name = ?");
	}

	/** Run `fn` inside ONE write transaction — all-or-nothing per batch. */
	private tx<T>(fn: () => T): T {
		if (this.inTx) throw new Error("sqlite-run-state: nested transaction refused");
		this.db.exec("BEGIN IMMEDIATE");
		this.inTx = true;
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* connection-level failure — surface the original error */
			}
			throw err;
		} finally {
			this.inTx = false;
		}
	}

	/** Run `fn` inside ONE read transaction — a stable snapshot under WAL. */
	private readTx<T>(fn: () => T): T {
		if (this.inTx) throw new Error("sqlite-run-state: nested transaction refused");
		this.db.exec("BEGIN");
		this.inTx = true;
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				/* surface the original error */
			}
			throw err;
		} finally {
			this.inTx = false;
		}
	}

	/** Upsert the run manifest — ONE transaction (1-row batch). */
	saveManifest(manifest: TeamRunManifest): void {
		const record = JSON.stringify(manifest);
		this.tx(() => {
			this.stmtUpsertManifest.run(MANIFEST_KEY, record);
		});
	}

	/**
	 * Replace the whole task set (same whole-file semantics as tasks.json)
	 * — ONE transaction.
	 */
	saveTasks(tasks: TeamTaskState[]): void {
		const rows = tasks.map((task) => [task.id, JSON.stringify(task)] as const);
		this.tx(() => {
			this.stmtDeleteTasks.run();
			for (const [id, record] of rows) {
				// rows are stringified BEFORE BEGIN so a serialization error
				// cannot open a transaction at all (let alone half-apply one).
				this.stmtInsertTask.run(id, record);
			}
		});
	}

	/**
	 * THE U8 batch primitive: manifest + tasks commit together in ONE
	 * transaction. Crash mid-batch → neither lands; observers never see a
	 * half batch (new manifest with stale tasks or the reverse).
	 */
	saveManifestAndTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
		const manifestRecord = JSON.stringify(manifest);
		const rows = tasks.map((task) => [task.id, JSON.stringify(task)] as const);
		this.tx(() => {
			this.stmtUpsertManifest.run(MANIFEST_KEY, manifestRecord);
			this.stmtDeleteTasks.run();
			for (const [id, record] of rows) {
				this.stmtInsertTask.run(id, record);
			}
		});
	}

	/** Load the manifest record (undefined when never saved). */
	loadManifest(): TeamRunManifest | undefined {
		return this.readTx(() => {
			const row = this.stmtGetManifest.get(MANIFEST_KEY) as { value: string } | undefined;
			return row ? (JSON.parse(row.value) as TeamRunManifest) : undefined;
		});
	}

	/** Load all task records in insertion order. */
	loadTasks(): TeamTaskState[] {
		return this.readTx(() => {
			const rows = this.stmtSelectTasks.all() as Array<{ id: string; record: string }>;
			return rows.map((row) => JSON.parse(row.record) as TeamTaskState);
		});
	}

	/**
	 * Load manifest + tasks from ONE consistent snapshot — the sqlite-mode
	 * counterpart of loadRunManifestById's manifest/tasks file pair, minus
	 * the torn-pair window.
	 */
	loadManifestAndTasks(): { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined {
		return this.readTx(() => {
			const manifestRow = this.stmtGetManifest.get(MANIFEST_KEY) as { value: string } | undefined;
			if (!manifestRow) return undefined;
			const manifest = JSON.parse(manifestRow.value) as TeamRunManifest;
			const rows = this.stmtSelectTasks.all() as Array<{ id: string; record: string }>;
			return { manifest, tasks: rows.map((row) => JSON.parse(row.record) as TeamTaskState) };
		});
	}

	/**
	 * Worker-status CRUD (U8: worker-status joins tasks + manifest in the
	 * same file). Batch upsert — ONE transaction for the whole array.
	 */
	saveWorkerStatuses(records: SqliteWorkerStatusRecord[]): void {
		const rows = records.map((entry) => [entry.taskId, JSON.stringify(entry.record ?? null)] as const);
		this.tx(() => {
			for (const [taskId, record] of rows) {
				this.stmtUpsertWorkerStatus.run(taskId, record);
			}
		});
	}

	/** Single worker-status upsert — convenience wrapper over the batch. */
	upsertWorkerStatus(taskId: string, record: unknown): void {
		this.saveWorkerStatuses([{ taskId, record }]);
	}

	/** Remove one worker-status row. */
	deleteWorkerStatus(taskId: string): void {
		this.tx(() => {
			this.stmtDeleteWorkerStatus.run(taskId);
		});
	}

	/** Load every worker-status row in insertion order. */
	loadWorkerStatuses(): SqliteWorkerStatusRecord[] {
		return this.readTx(() => {
			const rows = this.stmtSelectWorkerStatus.all() as Array<{ task_id: string; record: string }>;
			return rows.map((row) => ({ taskId: row.task_id, record: JSON.parse(row.record) }));
		});
	}

	/** Allocate the next value of a named monotonic sequence — ONE tx. */
	nextSeq(name: string): number {
		return this.tx(() => {
			this.stmtInitSeq.run(name);
			this.stmtBumpSeq.run(name);
			const row = this.stmtGetSeq.get(name) as { value: number } | undefined;
			if (!row) throw new Error(`sqlite-run-state: seq '${name}' missing after upsert`);
			return Number(row.value);
		});
	}

	/** True when the manifest row has never been written. */
	isEmptyRun(): boolean {
		return this.loadManifest() === undefined;
	}

	/** Drop the manifest + tasks records (test/teardown helper; worker-status and seq are kept). */
	clearRunState(): void {
		this.tx(() => {
			this.stmtDeleteManifest.run(MANIFEST_KEY);
			this.stmtDeleteTasks.run();
		});
	}

	/** Current journal mode (test observability — expect "wal"). */
	journalMode(): string {
		const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
		return row?.journal_mode ?? "";
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

// ── Process-wide handle cache ─────────────────────────────────────────────
// Saves are frequent (persistSingleTaskUpdate ~500ms); reopen+pragma+prepare
// per call would waste the hot path. Cache one open store per stateRoot,
// FIFO-bounded (each entry pins a file handle; runs are few in prod but
// tests create many tmp dirs).
const SQLITE_STORE_CACHE_MAX = 32;
const sqliteStores = new Map<string, SqliteRunStateStore>();

function evictOldestSqliteStore(): void {
	while (sqliteStores.size > SQLITE_STORE_CACHE_MAX) {
		const oldest = sqliteStores.keys().next().value;
		if (oldest === undefined) break;
		const store = sqliteStores.get(oldest);
		sqliteStores.delete(oldest);
		store?.close();
	}
}

/** Get (or open) the cached sqlite run-state store for a stateRoot. */
export function getSqliteRunStateStore(stateRoot: string): SqliteRunStateStore {
	const existing = sqliteStores.get(stateRoot);
	if (existing && !existing.isClosed) return existing;
	const store = new SqliteRunStateStore(stateRoot);
	sqliteStores.delete(stateRoot);
	sqliteStores.set(stateRoot, store);
	evictOldestSqliteStore();
	return store;
}

/** Close + forget the cached store for a stateRoot (no-op when absent). */
export function closeSqliteRunStateStore(stateRoot: string): void {
	const store = sqliteStores.get(stateRoot);
	if (!store) return;
	sqliteStores.delete(stateRoot);
	store.close();
}

/** @internal — test/teardown: close every cached store. */
export function __test__closeAllSqliteStores(): void {
	for (const store of sqliteStores.values()) store.close();
	sqliteStores.clear();
}

/** @internal — test observability: current cache size. */
export function __test__sqliteStoreCacheSize(): number {
	return sqliteStores.size;
}
