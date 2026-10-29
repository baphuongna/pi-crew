import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, sign as ed25519Sign, verify as ed25519Verify, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_MAILBOX } from "../../config/defaults.ts";
import { getCrewEnv } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import type { TeamRunManifest } from "../types.ts";
import { withFileLockAsync, withFileLockSync } from "./locks.ts";

export type MailboxDirection = "inbox" | "outbox";
export type MailboxMessageStatus = "queued" | "delivered" | "acknowledged";
export type MailboxMessageKind = "message" | "notify" | "steer" | "follow-up" | "response" | "group_join";
export type MailboxMessagePriority = "urgent" | "normal" | "low";
export type MailboxDeliveryMode = "interrupt" | "next_turn";
/**
 * W10-3 (2026-10-22, lesson #22 — intercom typed reason): why the sender is
 * contacting the supervisor/peer channel. Optional + backward-compatible —
 * pre-W10-3 rows simply carry no `reason`; an out-of-enum value parses as
 * `undefined` (dropped field, NOT a repair-worthy error — same graceful
 * semantics as `kind`/`priority`).
 */
export type MailboxReason = "need_decision" | "progress_update" | "interview_request";

// ============================================================================
// Coordination-row sender binding (w1a, coordination-durable-files-no-sender-binding).
//
// The durable coordination channels (mailbox JSONL + steering JSONL) are
// same-uid-writable by design: every WRITE-role child holds absolute paths to
// them (PI_CREW_STATE_ROOT / PI_CREW_STEERING_FILE). Before this section, every
// consumer trusted the file's caller-declared from/kind/to/taskId fields, so any
// worker could forge orchestrator-authority steers and leader/human-attributed
// messages with plain fs.appendFileSync.
//
// Fix: the parent/broker process SIGNS every row it writes with an Ed25519
// per-process keypair. The PRIVATE key is heap-only in the writer process
// (never persisted, never serialized, never placed in any child env). Children
// receive ONLY the public verify key (PI_CREW_MAILBOX_VERIFY_KEY, base64 SPKI
// DER — a public key, safe in env) set by child-pi-spawn at spawn time.
// Delivery-side readers (parseMailboxFile — the shared path under readMailbox /
// readAllMailboxMessages / pollWorkerInbox / replay) verify the signature over
// the identity-bearing fields and treat unverifiable rows as NOISE (dropped,
// not delivered). The key-possession constraint is respected: a shared HMAC
// secret distributed to children would let a malicious child forge valid rows;
// an Ed25519 public key cannot sign.
//
// Verification policy (delivery reads):
//   - verify key available (env key in a child, or the in-process keypair in a
//     writer) → a row is delivered ONLY with a valid signature; unsigned
//     (legacy or forged) rows are noise. This is the fail-closed default the
//     fix brief sanctions — including resume/replay: rows signed by a
//     predecessor process verify against the NEW process keypair only if that
//     key is the same, which it never is (heap-only per-process key), so
//     pre-restart pending rows are dropped on replay. Documented tradeoff.
//   - NO verify key available (standalone reader that never signed anything
//     and carries no env key — e.g. offline tooling/test harnesses) → rows are
//     kept without verification (inert-reader mode). Such a process is not a
//     delivery sink: production children always carry the env key and
//     production writer processes create their keypair at install/first-sign.
//
// validateMailbox()/updateMailboxMessageReply() deliberately keep using the
// shape-only parseMailboxMessage and preserve original line bytes on repair so
// repair tooling can neither drop nor forge authentication.
// ============================================================================

/** Child env var carrying the parent's base64 SPKI DER Ed25519 public verify
 *  key (set by child-pi-spawn). A PUBLIC key — non-secret, env-safe. */
export const COORDINATION_VERIFY_KEY_ENV = "PI_CREW_MAILBOX_VERIFY_KEY";

interface MailboxSigningKeypair {
	privateKey: KeyObject;
	publicKey: KeyObject;
	publicBase64: string;
}

let signingKeypair: MailboxSigningKeypair | undefined;

function getMailboxSigningKeypair(): MailboxSigningKeypair {
	if (!signingKeypair) {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		const der = publicKey.export({ type: "spki", format: "der" });
		signingKeypair = { privateKey, publicKey, publicBase64: Buffer.from(der).toString("base64") };
		// A freshly created keypair changes the verification verdict for rows
		// parsed before it existed (keyless → keyed). Drop memoized parses so no
		// cached pre-key verdict survives the transition.
		mailboxParseCache.clear();
	}
	return signingKeypair;
}

/** Public verify key (base64 SPKI DER) of this process's coordination signing
 *  keypair, creating the keypair on first use. Called by the writer process at
 *  install/spawn time so children can be handed the key, and at every sign. */
export function getMailboxVerifyKeyPublic(): string {
	return getMailboxSigningKeypair().publicBase64;
}

/** Whether any verify key is resolvable in THIS process (child env key or an
 *  already-created in-process keypair). Keyless processes are inert readers. */
export function hasCoordinationVerifyKeys(): boolean {
	return resolveCoordinationVerifyKeys().length > 0;
}

function resolveCoordinationVerifyKeys(): string[] {
	const envKey = getCrewEnv(COORDINATION_VERIFY_KEY_ENV);
	if (envKey && envKey.length > 0) return [envKey];
	return signingKeypair ? [signingKeypair.publicBase64] : [];
}

/** Canonical payload string over the identity-bearing mailbox-row fields —
 *  fixed field order, undefined → null. `sig` itself is never included. `data`
 *  rides as its deterministic JSON serialization (writer and verifier both
 *  derive it from the same written file bytes). */
function canonicalMailboxPayload(row: Record<string, unknown>): string {
	const pick = (key: string): unknown => (row[key] === undefined ? null : row[key]);
	return JSON.stringify([
		pick("id"),
		pick("runId"),
		pick("direction"),
		pick("from"),
		pick("to"),
		pick("body"),
		pick("createdAt"),
		pick("status"),
		pick("kind"),
		pick("priority"),
		pick("deliveryMode"),
		pick("taskId"),
		pick("questionId"),
		pick("requestId"),
		pick("reason"),
		pick("replyTo"),
		pick("replyFrom"),
		pick("replyDeadline"),
		pick("acknowledgedAt"),
		row.data !== undefined && row.data !== null && typeof row.data === "object" ? JSON.stringify(row.data) : pick("data"),
	]);
}

function coordinationPayloadHash(canonical: string): string {
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function signPayloadHash(payloadHash: string): string {
	const { privateKey } = getMailboxSigningKeypair();
	return ed25519Sign(null, Buffer.from(payloadHash, "utf8"), privateKey).toString("base64");
}

/** Verify a mailbox row's Ed25519 signature against explicit base64 SPKI keys
 *  (default: the keys resolvable in this process). False for missing/invalid
 *  signatures and malformed keys — never throws. */
export function verifyMailboxRowSig(row: Record<string, unknown>, verifyKeys?: string[]): boolean {
	const sig = row.sig;
	if (typeof sig !== "string" || sig.length === 0) return false;
	const keys = verifyKeys ?? resolveCoordinationVerifyKeys();
	if (keys.length === 0) return false;
	const payloadHash = coordinationPayloadHash(canonicalMailboxPayload(row));
	let sigBuf: Buffer;
	try {
		sigBuf = Buffer.from(sig, "base64");
	} catch {
		return false;
	}
	for (const key of keys) {
		try {
			const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
			if (ed25519Verify(null, Buffer.from(payloadHash, "utf8"), pub, sigBuf)) return true;
		} catch {
			/* malformed key material — try the next */
		}
	}
	return false;
}

/** Stamp this process's Ed25519 signature onto a mailbox message. Called at
 *  every durable mailbox write (append + reply rewrite) in the writer process. */
export function signMailboxMessage(message: MailboxMessage): MailboxMessage & { sig: string } {
	// Spread into an anonymous object literal (assignable to Record<string, unknown>
	// without a cast — named interfaces lack implicit index signatures, anonymous
	// object types do not) so the canonical payload sees every MailboxMessage field.
	const row: Record<string, unknown> = { ...message };
	return { ...message, sig: signPayloadHash(coordinationPayloadHash(canonicalMailboxPayload(row))) };
}

/** Steering-JSONL line shape shared by every writer (team-tool, broker
 *  steer.push, child-executor seed, wrap-up advisories). */
export interface CoordinationSteerEntry {
	type?: string;
	message?: string;
	id?: string;
	ts?: string;
}

/** Canonical payload for a steering line — fixed field order (type, message,
 *  id, ts); `sig` never included. */
function canonicalSteeringPayload(entry: CoordinationSteerEntry): string {
	return JSON.stringify([entry.type ?? null, entry.message ?? null, entry.id ?? null, entry.ts ?? null]);
}

/** Stamp this process's Ed25519 signature onto a steering JSONL entry. */
export function signSteeringEntry<T extends CoordinationSteerEntry>(entry: T): T & { sig: string } {
	return { ...entry, sig: signPayloadHash(coordinationPayloadHash(canonicalSteeringPayload(entry))) };
}

/** Verify a steering line's signature against this process's resolvable keys.
 *  False for missing/invalid signatures; never throws. */
export function verifySteeringEntrySig(entry: unknown): boolean {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	const sig = (entry as Record<string, unknown>).sig;
	if (typeof sig !== "string" || sig.length === 0) return false;
	const keys = resolveCoordinationVerifyKeys();
	if (keys.length === 0) return false;
	const payloadHash = coordinationPayloadHash(canonicalSteeringPayload(entry as CoordinationSteerEntry));
	let sigBuf: Buffer;
	try {
		sigBuf = Buffer.from(sig, "base64");
	} catch {
		return false;
	}
	for (const key of keys) {
		try {
			const pub = createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" });
			if (ed25519Verify(null, Buffer.from(payloadHash, "utf8"), pub, sigBuf)) return true;
		} catch {
			/* malformed key material — try the next */
		}
	}
	return false;
}

// ============================================================================
// Phase 1.3: post-append observer (single notification point)
// ============================================================================
// A registry of callbacks invoked AFTER a durable mailbox append completes
// (both sync and async paths). The broker registers here to fan out live
// notifications to connected recipients. The notifier is non-throwing and
// never blocks the append — it queues work via queueMicrotask so a slow
// observer cannot stall the mailbox write path. Registration is idempotent.

export type MailboxAppendObserver = (message: MailboxMessage) => void;

const mailboxAppendObservers = new Set<MailboxAppendObserver>();

/** Register a post-append observer. Returns an unsubscribe function. */
export function registerMailboxAppendObserver(fn: MailboxAppendObserver): () => void {
	mailboxAppendObservers.add(fn);
	return () => {
		mailboxAppendObservers.delete(fn);
	};
}

/**
 * Internal: invoked by appendMailboxMessage[Async] AFTER the durable write +
 * delivery RMW have completed. Non-throwing; never blocks the caller.
 */
function notifyMailboxAppended(message: MailboxMessage): void {
	if (mailboxAppendObservers.size === 0) return;
	// Snapshot the message so a later mutation by the caller cannot affect
	// what the observer sees.
	const snapshot = { ...message };
	queueMicrotask(() => {
		for (const fn of mailboxAppendObservers) {
			try {
				fn(snapshot);
			} catch {
				/* observer must not break the append path */
			}
		}
	});
}

export interface MailboxMessage {
	id: string;
	runId: string;
	direction: MailboxDirection;
	from: string;
	to: string;
	body: string;
	createdAt: string;
	status: MailboxMessageStatus;
	kind?: MailboxMessageKind;
	priority?: MailboxMessagePriority;
	deliveryMode?: MailboxDeliveryMode;
	taskId?: string;
	/** WP-2/R2 (ADR-0 item 11/F11): ask-response correlation id (randomUUID).
	 *  Carried by `kind:"response"` entries; matches task.waiting.questionId —
	 *  matching must be exact equality (never prefix/substring). */
	questionId?: string;
	/** U5 (2026-10-10): stable per-send idempotency key — uuid or
	 *  `{runId}:{taskId}:{seq}`. Every append auto-stamps one when the caller
	 *  omits it; resend-safe callers (broker msg.send) pass an explicit one so
	 *  `appendMailboxMessageIdempotent` can dedup by (direction, requestId) in
	 *  the SAME mailbox file (the durable analog of pi-durable's
	 *  `tx.submissionByRequest()` exactly-once root-submit). */
	requestId?: string;
	acknowledgedAt?: string;
	data?: Record<string, unknown>;
	/** W10-3 (2026-10-22, lesson #22): typed supervisor-contact reason
	 *  ({@link MailboxReason}). Optional — old messages without it parse
	 *  unchanged. */
	reason?: MailboxReason;
	/** ID of the original message this is a reply to. */
	replyTo?: string;
	/** Task ID sending the reply. */
	replyFrom?: string;
	/** Ms epoch deadline for a reply. */
	replyDeadline?: number;
	/** ISO timestamp when a reply was received for this message. */
	repliedAt?: string;
	/** Content of the reply received for this message. */
	replyContent?: string;
}

export interface MailboxDeliveryState {
	messages: Record<string, MailboxMessageStatus>;
	updatedAt: string;
	/** U5 (2026-10-10): durable delivered-requestId index —
	 *  key `${direction}:${recipientTaskId}:${requestId}` → id of the message row
	 *  that recipient consumed under it (M3-9/R33-1 recipient scoping: one group
	 *  fan-out reuses a single requestId for every recipient, so a run-scoped key
	 *  let the first acker starve all siblings — probe 1/0/0). Written by the
	 *  worker inbox pickup (recordMailboxRequestIdDelivery) and read back after a
	 *  restart so a redelivered/resent row is dropped (exactly-once pickup).
	 *  Optional so pre-U5 delivery.json files parse unchanged. */
	requestIds?: Record<string, string>;
}

export interface MailboxValidationIssue {
	level: "error" | "warning";
	path: string;
	message: string;
}

export interface MailboxValidationReport {
	issues: MailboxValidationIssue[];
	repaired: string[];
}

export interface MailboxReplayResult {
	messages: MailboxMessage[];
	updatedAt: string;
}

function mailboxDir(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "mailbox");
}

/** w1a: durable serialize + Ed25519 sign of a mailbox row. Signature is
 *  computed over the REDACTED row (the exact bytes that hit the file), so a
 *  verifier recomputing the canonical payload from the parsed line matches. */
function serializeMailboxRow(message: MailboxMessage): string {
	const prepared = redactSecrets(message) as MailboxMessage;
	return JSON.stringify({ ...prepared, sig: signMailboxMessage(prepared).sig });
}

function safeMailboxDir(manifest: TeamRunManifest, create = false): string {
	const dir = mailboxDir(manifest);
	if (create) {
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (error) {
			// Windows EPERM: can occur when dir uses long-name form (runneradmin)
			// but filesystem parent only exists in short-name form (RUNNER~1).
			// Retry with realpathSync-resolved form.
			if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
				try {
					const realDir = fs.realpathSync(path.dirname(dir));
					const correctedDir = path.join(realDir, path.basename(dir));
					fs.mkdirSync(correctedDir, { recursive: true });
				} catch {
					throw error;
				}
			} else {
				throw error;
			}
		}
	}
	// SECURITY: When create=true, dir now exists and must be validated via
	// resolveRealContainedPath. When create=false, missing dir must throw —
	// never return an unvalidated bare path (bypasses containment checks).
	if (!fs.existsSync(dir)) {
		if (create) throw new Error(`Mailbox directory creation failed: ${dir}`);
		return path.join(dir); // will throw in callers via resolveRealContainedPath on read
	}
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Invalid mailbox directory: ${dir}`);
	// Return dir as-is. The containment guarantee is provided by
	// manifest.stateRoot which was validated by createRunPaths. Re-resolving
	// through resolveRealContainedPath can change the path form on Windows
	// (short-name vs long-name), causing subsequent operations to see a
	// different filesystem entry.
	return dir;
}

function safeTaskId(taskId: string): string {
	if (!/^[\w.-]+$/.test(taskId) || taskId.includes("..") || path.isAbsolute(taskId))
		throw new Error(`Invalid mailbox task id: ${taskId}`);
	return taskId;
}

function safeMailboxTasksRoot(manifest: TeamRunManifest, create = false): string {
	const root = path.join(safeMailboxDir(manifest, create), "tasks");
	if (create) fs.mkdirSync(root, { recursive: true });
	if (!fs.existsSync(root)) return root;
	if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Invalid mailbox tasks directory: ${root}`);
	// Return root as-is (see safeMailboxDir comment about path form consistency)
	return root;
}

function taskMailboxDir(manifest: TeamRunManifest, taskId: string, create = false): string {
	const tasksRoot = safeMailboxTasksRoot(manifest, create);
	const normalizedTaskId = safeTaskId(taskId);
	const resolved = path.resolve(tasksRoot, normalizedTaskId);
	const relative = path.relative(tasksRoot, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Invalid mailbox task id: ${taskId}`);
	if (create) fs.mkdirSync(resolved, { recursive: true });
	if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) throw new Error(`Invalid mailbox task directory: ${resolved}`);
	// Return resolved as-is (see safeMailboxDir comment about path form consistency)
	return resolved;
}

function mailboxPath(manifest: TeamRunManifest, direction: MailboxDirection, taskId?: string, create = false): string {
	return taskId
		? path.join(taskMailboxDir(manifest, taskId, create), `${direction}.jsonl`)
		: path.join(safeMailboxDir(manifest, create), `${direction}.jsonl`);
}

function deliveryPath(manifest: TeamRunManifest, create = false): string {
	return path.join(safeMailboxDir(manifest, create), "delivery.json");
}

function safeMailboxFile(filePath: string, parentDir: string): string {
	if (!fs.existsSync(filePath)) return filePath;
	if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`Invalid mailbox file: ${filePath}`);
	// Return filePath as-is instead of calling resolveRealContainedPath().
	// The containment guarantee is already provided by safeMailboxDir/taskMailboxDir
	// when the parent directory is created. Re-resolving can change the path
	// form (e.g. short-name vs long-name on Windows), causing subsequent
	// existsSync/appendFileSync to see a different file.
	return filePath;
}

function mailboxFile(manifest: TeamRunManifest, direction: MailboxDirection, taskId?: string, create = false): string {
	const parent = taskId ? taskMailboxDir(manifest, taskId, create) : safeMailboxDir(manifest, create);
	return safeMailboxFile(path.join(parent, `${direction}.jsonl`), parent);
}

function deliveryFile(manifest: TeamRunManifest, create = false): string {
	// Pass create=true to ensure mailbox dir exists before computing delivery.json path.
	// This mirrors ensureRunMailbox() pattern — always create before computing nested paths.
	// When create=false, a missing directory is tolerated (callers like readDeliveryState
	// handle missing file via try/catch; but missing directory must not throw here).
	try {
		const parent = safeMailboxDir(manifest, create);
		return safeMailboxFile(path.join(parent, "delivery.json"), parent);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// Directory missing and create=false: return unvalidated path so callers
			// (readDeliveryState) that have their own try/catch can handle gracefully.
			return path.join(mailboxDir(manifest), "delivery.json");
		}
		throw err;
	}
}

function ensureRunMailbox(manifest: TeamRunManifest): void {
	safeMailboxDir(manifest, true);
	for (const direction of ["inbox", "outbox"] as const) {
		const filePath = mailboxFile(manifest, direction, undefined, true);
		if (!fs.existsSync(filePath)) {
			// Ensure parent dir exists (may have been lost due to race or
			// Windows path normalization mismatch)
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			atomicWriteFile(filePath, "");
		}
	}
	const delivery = deliveryFile(manifest, true);
	if (!fs.existsSync(delivery)) {
		fs.mkdirSync(path.dirname(delivery), { recursive: true });
		atomicWriteFile(delivery, `${JSON.stringify({ messages: {}, updatedAt: new Date().toISOString() }, null, 2)}\n`);
	}
}

function ensureTaskMailbox(manifest: TeamRunManifest, taskId: string): void {
	ensureRunMailbox(manifest);
	taskMailboxDir(manifest, taskId, true);
	for (const direction of ["inbox", "outbox"] as const) {
		const filePath = mailboxFile(manifest, direction, taskId, true);
		// STATE-10: use atomicWriteFile for consistency with ensureRunMailbox —
		// the old fs.writeFileSync was non-atomic (TOCTOU on concurrent reads).
		if (!fs.existsSync(filePath)) atomicWriteFile(filePath, "");
	}
}

function isDirection(value: unknown): value is MailboxDirection {
	return value === "inbox" || value === "outbox";
}

function isStatus(value: unknown): value is MailboxMessageStatus {
	return value === "queued" || value === "delivered" || value === "acknowledged";
}

function isKind(value: unknown): value is MailboxMessageKind {
	return (
		value === "message" ||
		value === "notify" ||
		value === "steer" ||
		value === "follow-up" ||
		value === "response" ||
		value === "group_join"
	);
}

function isPriority(value: unknown): value is MailboxMessagePriority {
	return value === "urgent" || value === "normal" || value === "low";
}

function isDeliveryMode(value: unknown): value is MailboxDeliveryMode {
	return value === "interrupt" || value === "next_turn";
}

function isReason(value: unknown): value is MailboxReason {
	return value === "need_decision" || value === "progress_update" || value === "interview_request";
}

function parseMailboxMessage(raw: unknown, expectedDirection: MailboxDirection): MailboxMessage | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	if (
		typeof obj.id !== "string" ||
		typeof obj.runId !== "string" ||
		!isDirection(obj.direction) ||
		typeof obj.from !== "string" ||
		typeof obj.to !== "string" ||
		typeof obj.body !== "string" ||
		typeof obj.createdAt !== "string" ||
		!isStatus(obj.status)
	)
		return undefined;
	if (obj.direction !== expectedDirection) return undefined;
	const data = obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) ? (obj.data as Record<string, unknown>) : undefined;
	const dataKind = data?.kind;
	return {
		id: obj.id,
		runId: obj.runId,
		direction: obj.direction,
		from: obj.from,
		to: obj.to,
		body: obj.body,
		createdAt: obj.createdAt,
		status: obj.status,
		kind: isKind(obj.kind) ? obj.kind : isKind(dataKind) ? dataKind : undefined,
		priority: isPriority(obj.priority) ? obj.priority : undefined,
		deliveryMode: isDeliveryMode(obj.deliveryMode) ? obj.deliveryMode : undefined,
		taskId: typeof obj.taskId === "string" ? obj.taskId : undefined,
		reason: isReason(obj.reason) ? obj.reason : undefined,
		questionId: typeof obj.questionId === "string" ? obj.questionId : undefined,
		requestId: typeof obj.requestId === "string" ? obj.requestId : undefined,
		acknowledgedAt: typeof obj.acknowledgedAt === "string" ? obj.acknowledgedAt : undefined,
		data,
		replyTo: typeof obj.replyTo === "string" ? obj.replyTo : undefined,
		replyFrom: typeof obj.replyFrom === "string" ? obj.replyFrom : undefined,
		replyDeadline: typeof obj.replyDeadline === "number" ? obj.replyDeadline : undefined,
		repliedAt: typeof obj.repliedAt === "string" ? obj.repliedAt : undefined,
		replyContent: typeof obj.replyContent === "string" ? obj.replyContent : undefined,
	};
}

/** Raw read+parse of one mailbox JSONL file (extracted verbatim from the old
 *  readMailboxFile body). Callers go through cachedMailboxRead instead.
 *
 *  w1a sender-binding GATE: this is THE shared delivery-read path (readMailbox,
 *  readAllMailboxMessages → pollWorkerInbox / msg.inbox / replay). When this
 *  process can verify coordination signatures (child env key or an existing
 *  writer keypair), a row is delivered ONLY with a valid Ed25519 signature —
 *  unsigned (legacy/forged) rows and tampered rows are dropped as noise.
 *  Keyless processes (no env key, keypair never created) keep rows without
 *  verification — inert-reader mode, never a delivery sink in production.
 *  Shape-only parsing (validateMailbox / reply rewrite) deliberately bypasses
 *  this gate via parseMailboxMessage. */
function parseMailboxFile(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	const messages: MailboxMessage[] = [];
	const verifyKeys = resolveCoordinationVerifyKeys();
	const raw = fs.readFileSync(filePath, "utf-8");
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		try {
			const parsedLine = JSON.parse(line) as unknown;
			if (verifyKeys.length > 0) {
				if (!parsedLine || typeof parsedLine !== "object" || Array.isArray(parsedLine)) continue;
				const row = parsedLine as Record<string, unknown>;
				if (typeof row.sig !== "string" || !verifyMailboxRowSig(row, verifyKeys)) continue;
			}
			const message = parseMailboxMessage(parsedLine, direction);
			if (message) messages.push(message);
		} catch {
			// Invalid mailbox lines are reported by validateMailbox().
		}
	}
	return messages;
}

// PERF (2026-08-24): parked workers poll all mailboxes every 500ms and used to
// read+parse every file each tick. Parse results are now memoized per file by
// (mtime, size); append/rotate change mtime so invalidation is automatic.
// Entries hold the parsed array; readers get a shallow copy (array of refs) —
// 100x cheaper than re-reading, and callers never mutate message objects.
const mailboxParseCache = new Map<string, { mtimeMs: number; size: number; messages: MailboxMessage[] }>();
const MAILBOX_PARSE_CACHE_MAX = 128;
function cachedMailboxRead(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		// Missing (or vanished, e.g. pruned archive) → drop any stale entry.
		mailboxParseCache.delete(filePath);
		return [];
	}
	const hit = mailboxParseCache.get(filePath);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.messages.slice();
	const messages = parseMailboxFile(filePath, direction);
	if (mailboxParseCache.size >= MAILBOX_PARSE_CACHE_MAX) {
		const oldest = mailboxParseCache.keys().next().value;
		if (oldest !== undefined) mailboxParseCache.delete(oldest);
	}
	mailboxParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
	return messages.slice();
}

/** R7-3 (2026-10-16): rotated archive siblings of a live mailbox file,
 *  sorted lexicographically. The archive name embeds an ISO timestamp, so
 *  lexicographic order ≈ chronological (oldest first). */
function listMailboxArchives(filePath: string): string[] {
	try {
		const dir = path.dirname(filePath);
		const base = path.basename(filePath);
		return fs
			.readdirSync(dir)
			.filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".archive.jsonl"))
			.sort()
			.map((entry) => path.join(dir, entry));
	} catch {
		// Directory missing — nothing to read.
		return [];
	}
}

function safeReadMailboxFile(filePath: string, direction: MailboxDirection): MailboxMessage[] {
	// PERF: stat-gated primary read — ENOENT is handled inside cachedMailboxRead.
	const live = cachedMailboxRead(filePath, direction);
	// 3.3 — also include any rotated archive files alongside the live file.
	// Archive naming: `<filename>.<isoTimestamp>.archive.jsonl`.
	// PERF: archives are immutable once written (rotation only ever creates
	// new ones — see rotateMailboxFileIfNeeded's rename + atomicWriteFile
	// sequence), so they route through cachedMailboxRead too and permanently
	// hit after the first parse. pruneOldMailboxArchives deleting an archive
	// is covered by cachedMailboxRead's ENOENT → cache-delete branch.
	const archives = listMailboxArchives(filePath);
	if (archives.length === 0) return live;
	// R7-3 (2026-10-16) — same-id LAST-WINS merge, live file applied LAST.
	//
	// DESIGN: rotation moves a message into an archive and recreates an empty
	// live file, so a message normally exists in exactly ONE place and a plain
	// concat was duplicate-free. The exception is updateMailboxMessageReply:
	// archives are IMMUTABLE history and are never rewritten, so when the
	// original message lives only in an archive the reply is recorded as a
	// COMPENSATING record — same id, reply metadata set — appended to the LIVE
	// file. Merging by id (archives oldest→newest first, live file last)
	// collapses the pair into a single reply-marked message, so readMailbox /
	// readMailboxMessage expose ONE copy with repliedAt set; consumers
	// (replayPendingMailboxMessages, listMailboxByKind, …) never see the
	// duplicate reply-less archived original.
	const merged: MailboxMessage[] = [];
	const indexById = new Map<string, number>();
	const upsert = (message: MailboxMessage): void => {
		const existing = indexById.get(message.id);
		if (existing === undefined) {
			indexById.set(message.id, merged.length);
			merged.push(message);
		} else {
			merged[existing] = message;
		}
	};
	for (const archivePath of archives) {
		for (const message of cachedMailboxRead(archivePath, direction)) upsert(message);
	}
	for (const message of live) upsert(message);
	return merged;
}

/**
 * 3.3 — rotate a mailbox JSONL file when it grows past `thresholdBytes`.
 * Renames it to `<file>.<timestamp>.archive.jsonl` and re-creates an empty
 * primary file. Readers continue to see all messages because
 * `safeReadMailboxFile` walks both the primary file and any archives.
 */
const MAILBOX_ARCHIVE_THRESHOLD_BYTES = DEFAULT_MAILBOX.perFileThresholdBytes;
function rotateMailboxFileIfNeeded(filePath: string, thresholdBytes = MAILBOX_ARCHIVE_THRESHOLD_BYTES): boolean {
	try {
		if (!fs.existsSync(filePath)) return false;
		const stat = fs.statSync(filePath);
		if (stat.size < thresholdBytes) return false;
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const archivePath = `${filePath}.${ts}.archive.jsonl`;
		fs.renameSync(filePath, archivePath);
		atomicWriteFile(filePath, "");
		// FIX: Prune old archives so total per-direction count stays bounded.
		pruneOldMailboxArchives(filePath);
		return true;
	} catch (error) {
		logInternalError("mailbox.rotate", error, filePath);
		return false;
	}
}

/**
 * Keep at most `DEFAULT_MAILBOX.maxArchivesPerDirection` archive files per
 * mailbox. Older archives are deleted. Prevents unbounded growth on long runs.
 */
function pruneOldMailboxArchives(mailboxFilePath: string): void {
	try {
		const dir = path.dirname(mailboxFilePath);
		const base = path.basename(mailboxFilePath);
		const archives = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith(base) && f.includes(".archive.jsonl"))
			.sort(); // Chronological (ISO timestamp in filename)
		const excess = archives.length - DEFAULT_MAILBOX.maxArchivesPerDirection;
		for (let i = 0; i < excess; i += 1) {
			fs.rmSync(path.join(dir, archives[i]), { force: true });
		}
	} catch (error) {
		logInternalError("mailbox.prune", error, mailboxFilePath);
	}
}

export function readMailbox(
	manifest: TeamRunManifest,
	direction?: MailboxDirection,
	taskId?: string,
	kind?: MailboxMessageKind,
): MailboxMessage[] {
	const directions = direction ? [direction] : (["inbox", "outbox"] as const);
	return directions
		.flatMap((item) => safeReadMailboxFile(mailboxFile(manifest, item, taskId), item))
		.filter((msg) => !kind || msg.kind === kind)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readAllMailboxMessages(manifest: TeamRunManifest, direction?: MailboxDirection, signal?: AbortSignal): MailboxMessage[] {
	const directions = direction ? [direction] : (["inbox", "outbox"] as const);
	return directions.flatMap((item) => readAllMessages(manifest, item, signal)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readAllMessages(manifest: TeamRunManifest, direction: MailboxDirection, signal?: AbortSignal): MailboxMessage[] {
	const messages = [...safeReadMailboxFile(mailboxFile(manifest, direction), direction)];
	const tasksDir = safeMailboxTasksRoot(manifest);
	if (fs.existsSync(tasksDir)) {
		for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
			if (signal?.aborted) break;
			if (!entry.isDirectory()) continue;
			messages.push(...safeReadMailboxFile(mailboxFile(manifest, direction, entry.name), direction));
		}
	}
	return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function readAllInboxMessages(manifest: TeamRunManifest): MailboxMessage[] {
	return readAllMessages(manifest, "inbox");
}

// FIND-01: in-process delivery cache to avoid O(N²) re-reads on every append.
// Keyed by delivery file path; invalidated by mtime check on read + updated on
// write. Team-runner is single-process so in-process caching is sufficient.
const deliveryCache = new Map<string, { mtimeMs: number; size: number; state: MailboxDeliveryState }>();
const MAX_DELIVERY_CACHE_ENTRIES = 256;
// R1 review fix: setDeliveryCacheEntry stores an immutable snapshot (deep
// copy of `messages`) so callers mutating the returned state cannot corrupt
// the cache (TOCTOU race), and bounds the map size with FIFO eviction to
// prevent unbounded growth across runs.
function setDeliveryCacheEntry(filePath: string, entry: { mtimeMs: number; size: number; state: MailboxDeliveryState }): void {
	if (deliveryCache.size >= MAX_DELIVERY_CACHE_ENTRIES) {
		const oldest = deliveryCache.keys().next().value;
		if (oldest !== undefined) deliveryCache.delete(oldest);
	}
	deliveryCache.set(filePath, {
		mtimeMs: entry.mtimeMs,
		size: entry.size,
		state: { ...entry.state, messages: { ...entry.state.messages } },
	});
}

export function readDeliveryState(manifest: TeamRunManifest): MailboxDeliveryState {
	const filePath = deliveryFile(manifest);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (e) {
		// R1 review fix: narrow to ENOENT so permission errors aren't silently
		// treated as "missing file" (would wipe a valid cache entry).
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		deliveryCache.delete(filePath);
		return { messages: {}, updatedAt: new Date().toISOString() };
	}
	const cached = deliveryCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		// R2 review fix: return a copy so callers mutating the result cannot
		// leak into the cached snapshot (residual TOCTOU: the cache holds the
		// snapshot until the next write replaces it; without this copy, a
		// pre-write mutation by one caller would be persisted into the
		// post-write snapshot by the next writer's setDeliveryCacheEntry).
		return { ...cached.state, messages: { ...cached.state.messages } };
	}
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid delivery state.");
		const obj = raw as Record<string, unknown>;
		const messages: Record<string, MailboxMessageStatus> = {};
		if (obj.messages && typeof obj.messages === "object" && !Array.isArray(obj.messages)) {
			for (const [id, status] of Object.entries(obj.messages)) if (isStatus(status)) messages[id] = status;
		}
		const state: MailboxDeliveryState = {
			messages,
			updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
		};
		// U5: optional durable (direction, requestId) delivered index — absent
		// in pre-U5 delivery.json files (treated as "nothing delivered yet").
		if (obj.requestIds && typeof obj.requestIds === "object" && !Array.isArray(obj.requestIds)) {
			const requestIds: Record<string, string> = {};
			for (const [key, id] of Object.entries(obj.requestIds as Record<string, unknown>))
				if (typeof id === "string") requestIds[key] = id;
			if (Object.keys(requestIds).length > 0) state.requestIds = requestIds;
		}
		setDeliveryCacheEntry(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
		return state;
	} catch (error) {
		// NEW-R4: a corrupt delivery.json was previously swallowed silently, returning
		// empty → messages appear undelivered → re-delivery on every replay. Quarantine
		// the corrupt file (preserve for diagnosis) + log prominently so the re-delivery
		// risk is visible. Mirror the state-store quarantineCorruptFile pattern.
		const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
		try {
			fs.renameSync(filePath, quarantinePath);
		} catch (renameError) {
			logInternalError("mailbox.readDeliveryState.quarantine", renameError, `filePath=${filePath}`);
		}
		// NEW-R4: prominent (ungated) error so corrupt-delivery re-delivery risk is
		// visible even without PI_TEAMS_DEBUG — messages may be re-delivered.
		logInternalError(
			"mailbox.readDeliveryState",
			error,
			`corrupt delivery.json quarantined to ${quarantinePath} — delivery state reset to empty; messages may be re-delivered`,
			"error",
		);
		deliveryCache.delete(filePath);
		return { messages: {}, updatedAt: new Date().toISOString() };
	}
}

const MAX_DELIVERY_MESSAGES = 10000;

/**
 * F09 (RR-016): an `acknowledged` delivery entry is the ONLY durable record
 * that a message was handled — the inbox line keeps `status: "queued"` forever
 * (nothing writes the ack back to the message), so `replayPendingMailboxMessages`
 * keys on the delivery map. The old prune sorted `queued(0) < delivered(1) <
 * acknowledged(2)` and kept `slice(0, MAX)`, i.e. it evicted ACKNOWLEDGED entries
 * FIRST — the moment the cap was crossed, an acked message became replayable
 * again, and it never self-healed (replay only writes "delivered"), so it was
 * re-delivered on EVERY resume.
 *
 * Fix: the prune may only drop an acknowledged entry when the message it refers
 * to is provably no longer replayable (absent from the whole replayable history:
 * live inbox files + retained archives — the exact set `replayPendingMailboxMessages`
 * reads). Non-acknowledged entries keep the previous eviction semantics
 * (queued → delivered → acknowledged, oldest-inserted first within a tier).
 *
 * Acknowledged entries are tiny (`"<id>":"acknowledged"`), but they must not
 * grow without bound either: a sweep that drops the PROVABLY-dead acks is run
 * once the ack set is large enough to matter, and at most once per
 * ACK_SWEEP_MIN_INTERVAL_MS (the sweep reads the mailbox history, so it is
 * throttled rather than run on every append).
 */
const ACK_SWEEP_MIN_ACKS = 1000;
const ACK_SWEEP_FORCE_ACKS = 5000;
const ACK_SWEEP_MIN_INTERVAL_MS = 30_000;
// Bounded FIFO (the asyncAgentReaderCache pattern) so a long-running process
// cannot accumulate one timestamp per run ever seen.
const ACK_SWEEP_TIMESTAMP_MAX_ENTRIES = 256;
const lastAckSweepAt = new Map<string, number>();

function recordAckSweep(filePath: string, at: number): void {
	if (lastAckSweepAt.has(filePath)) lastAckSweepAt.delete(filePath);
	lastAckSweepAt.set(filePath, at);
	while (lastAckSweepAt.size > ACK_SWEEP_TIMESTAMP_MAX_ENTRIES) {
		const oldest = lastAckSweepAt.keys().next().value;
		if (oldest === undefined) break;
		lastAckSweepAt.delete(oldest);
	}
}

/** Ids of every message `replayPendingMailboxMessages` could return (live inbox
 *  files + retained archives, run-level and per-task). Returns `undefined` when
 *  the history could not be READ (fail-closed, review MAJOR 1): an unreadable
 *  history must never be conflated with an empty one — the sweep treats an
 *  empty set as "every ack is dead" and would delete all acknowledged entries,
 *  replaying already-processed messages (the F09 bug class). */
function collectReplayableInboxIds(manifest: TeamRunManifest): Set<string> | undefined {
	const ids = new Set<string>();
	try {
		for (const message of readAllInboxMessages(manifest)) ids.add(message.id);
	} catch (error) {
		logInternalError("mailbox.collect-replayable-ids", error, `runId=${manifest.runId}`);
		return undefined;
	}
	return ids;
}

/** Drop acknowledged entries whose message can no longer be replayed. Returns
 *  the number of entries dropped. Never drops an entry whose message is still
 *  in the replayable history. FAIL-CLOSED (review MAJOR 1): if the replayable
 *  history cannot be read, the sweep aborts dropping NOTHING and does not
 *  consume the throttle window (`recordAckSweep` is only recorded after a
 *  successful read), so the next prune retries once the FS is readable. */
function sweepDeadAcknowledgements(manifest: TeamRunManifest, state: MailboxDeliveryState): number {
	const ackedIds = Object.entries(state.messages)
		.filter(([, status]) => status === "acknowledged")
		.map(([id]) => id);
	if (ackedIds.length === 0) return 0;
	const filePath = deliveryFile(manifest, true);
	const now = Date.now();
	const last = lastAckSweepAt.get(filePath) ?? 0;
	// The sweep reads the whole replayable history, so it is time-throttled:
	// at most once per ACK_SWEEP_MIN_INTERVAL_MS below ACK_SWEEP_FORCE_ACKS,
	// and immediately above it so the ack set cannot grow unbounded.
	const shouldSweep =
		ackedIds.length >= ACK_SWEEP_FORCE_ACKS || (ackedIds.length >= ACK_SWEEP_MIN_ACKS && now - last >= ACK_SWEEP_MIN_INTERVAL_MS);
	if (!shouldSweep) return 0;
	const replayable = collectReplayableInboxIds(manifest);
	if (replayable === undefined) return 0; // unreadable history → abort, keep every ack
	recordAckSweep(filePath, now);
	let dropped = 0;
	for (const id of ackedIds) {
		if (replayable.has(id)) continue;
		delete state.messages[id];
		dropped++;
	}
	return dropped;
}

function pruneDeliveryMessages(manifest: TeamRunManifest, state: MailboxDeliveryState): void {
	const entries = Object.entries(state.messages);
	const ackedCount = entries.reduce((count, [, status]) => (status === "acknowledged" ? count + 1 : count), 0);
	if (ackedCount > ACK_SWEEP_MIN_ACKS) sweepDeadAcknowledgements(manifest, state);
	pruneDeliveredRequestIds(state);
	const remaining = Object.entries(state.messages);
	if (remaining.length <= MAX_DELIVERY_MESSAGES) return;
	// Stable sort: within a status tier the previous insertion order (which is
	// the order entries were first written) is preserved, so the eviction choice
	// for non-acknowledged entries is unchanged from before this fix.
	const sorted = [...remaining].sort(([, a], [, b]) => {
		const order = { queued: 0, delivered: 1, acknowledged: 2 };
		return (order[a] ?? 3) - (order[b] ?? 3);
	});
	const ackedAfterSweep = sorted.filter(([, status]) => status === "acknowledged").length;
	if (ackedAfterSweep > MAX_DELIVERY_MESSAGES) {
		// Pathological: more acks than the cap and every one of them still refers
		// to a replayable message. Correctness (an acked message must never
		// replay) wins over the memory bound — keep them and make it visible.
		logInternalError(
			"mailbox.delivery-ack-over-cap",
			new Error(`delivery.json holds ${ackedAfterSweep} acknowledged entries for replayable messages (cap ${MAX_DELIVERY_MESSAGES})`),
			`runId=${manifest.runId}`,
			"warn",
		);
	}
	const keptIds = new Set<string>();
	let evictableBudget = Math.max(0, MAX_DELIVERY_MESSAGES - ackedAfterSweep);
	for (const [id, status] of sorted) {
		if (status === "acknowledged") {
			keptIds.add(id);
			continue;
		}
		if (evictableBudget > 0) {
			keptIds.add(id);
			evictableBudget--;
		}
	}
	// Filter the ORIGINAL entry order so surviving entries keep their positions.
	state.messages = Object.fromEntries(remaining.filter(([id]) => keptIds.has(id)));
}

/** U5: bound the durable (direction, recipient, requestId) delivered index.
 *  Keys insert chronologically (first delivery under that key), so eviction keeps
 *  the most recent MAX_DELIVERY_MESSAGES keys — dropping a key can only
 *  re-enable delivery of an extremely old duplicate row, the same bounded
 *  risk the messages map already accepts. */
function pruneDeliveredRequestIds(state: MailboxDeliveryState): void {
	if (!state.requestIds) return;
	const keys = Object.keys(state.requestIds);
	if (keys.length <= MAX_DELIVERY_MESSAGES) return;
	const keep = new Set(keys.slice(keys.length - MAX_DELIVERY_MESSAGES));
	for (const key of keys) if (!keep.has(key)) delete state.requestIds[key];
}

function writeDeliveryState(
	manifest: TeamRunManifest,
	state: MailboxDeliveryState,
	options?: { durability?: "full" | "best-effort" },
): void {
	ensureRunMailbox(manifest);
	// Prune oldest entries if capped (F09: acknowledged entries are protected).
	pruneDeliveryMessages(manifest, state);
	// F4: mailbox delivery is informational — accept losing the very last write on
	// a hard crash (the next message will overwrite it on disk). Cheaper fsync on
	// the hot path; terminal/reply paths still pass full durability below.
	const filePath = deliveryFile(manifest, true);
	atomicWriteFile(filePath, `${JSON.stringify(redactSecrets(state), null, 2)}\n`, {
		durability: options?.durability ?? "best-effort",
	});
	// FIND-01: update cache with post-write mtime so subsequent reads get a hit.
	try {
		const postStat = fs.statSync(filePath);
		// setDeliveryCacheEntry stores an immutable snapshot (deep copy of
		// messages) so subsequent read-modify-write callers mutating the
		// returned state cannot corrupt the cache.
		setDeliveryCacheEntry(filePath, { mtimeMs: postStat.mtimeMs, size: postStat.size, state });
	} catch {
		deliveryCache.delete(filePath);
	}
}

/** U5 (2026-10-10): shared message construction for every append path.
 *  Auto-stamps a unique `requestId` (`req_<uuid>`) when the caller omits one
 *  so EVERY mailbox row carries one (receiver dedup keys on it); callers
 *  that need resend idempotency pass an explicit stable id instead. */
type MailboxAppendInput = Omit<MailboxMessage, "id" | "runId" | "createdAt" | "status"> & {
	id?: string;
	status?: MailboxMessageStatus;
};

function buildMailboxMessage(manifest: TeamRunManifest, message: MailboxAppendInput, createdAt: string): MailboxMessage {
	return {
		// RR-021 WI-4.3j: randomUUID instead of Date.now()+Math.random() —
		// collision-free under the msg_ prefix, no clock-ordering leakage.
		id: message.id ?? `msg_${randomUUID()}`,
		runId: manifest.runId,
		direction: message.direction,
		from: message.from,
		to: message.to,
		body: message.body,
		createdAt,
		status: message.status ?? "queued",
		kind: message.kind,
		priority: message.priority,
		deliveryMode: message.deliveryMode,
		taskId: message.taskId,
		reason: message.reason,
		questionId: message.questionId,
		// U5: every send carries a requestId — explicit (idempotent senders)
		// or auto-stamped uuid (one per row; still unique per send).
		requestId: message.requestId ?? `req_${randomUUID()}`,
		acknowledgedAt: message.acknowledgedAt,
		data: message.data,
		replyTo: message.replyTo,
		replyFrom: message.replyFrom,
		replyDeadline: message.replyDeadline,
		repliedAt: message.repliedAt,
		replyContent: message.replyContent,
	};
}

/**
 * Append a message to a run's or task's mailbox.
 *
 * SECURITY NOTE (updated w1a — coordination-durable-files-no-sender-binding):
 * The `from` field is caller-declared within the pi-crew process; every row
 * this module writes is stamped with the writer process's Ed25519 signature
 * over the identity-bearing fields (see the sender-binding section above), and
 * every DELIVERY-side consumer (readMailbox / readAllMailboxMessages →
 * pollWorkerInbox, msg.inbox, replay) drops rows without a valid signature.
 * Workers and same-uid processes can still APPEND bytes to the JSONL files,
 * but those rows no longer deliver: they verify against no trusted key. The
 * private signing key never leaves the parent process heap; children hold only
 * the public verify key (PI_CREW_MAILBOX_VERIFY_KEY).
 */
export function appendMailboxMessage(manifest: TeamRunManifest, message: MailboxAppendInput): MailboxMessage {
	if (message.taskId) ensureTaskMailbox(manifest, message.taskId);
	else ensureRunMailbox(manifest);
	const createdAt = new Date().toISOString();
	const complete = buildMailboxMessage(manifest, message, createdAt);
	// ST-3: collapse to ONE lock namespace (.flock) for ALL mailbox-file
	// operations — sync append, async append, and full-file rewrite. Previously
	// this used withEventLogLockSync (.mkdirlock) while async append used an
	// in-process promise chain (no on-disk artifact) and reply-rewrite used
	// withFileLockSync (.flock). The three DISJOINT namespaces let concurrent
	// operations interleave, silently losing messages (especially during the
	// rotation rename↔recreate window). Now all three use withFileLockSync /
	// withFileLockAsync — both backed by the same .flock sidecar.
	// B8: rotation (rename + recreate) also runs INSIDE the lock so it is serialized
	// with appends — otherwise a concurrent append between rename and recreate can
	// be truncated to an empty file.
	withFileLockSync(mailboxFile(manifest, complete.direction, complete.taskId), () => {
		fs.appendFileSync(mailboxFile(manifest, complete.direction, complete.taskId), `${serializeMailboxRow(complete)}\n`, "utf-8");
		// 3.3 — rotate mailbox file if it has grown past 10 MB. Cheap stat check;
		// rotates at most once per append.
		rotateMailboxFileIfNeeded(mailboxFile(manifest, complete.direction, complete.taskId));
	});
	// BUGFIX (Round 12 C3): the delivery.json read-modify-write below was
	// UNLOCKED, so concurrent appendMailboxMessage calls could interleave and
	// clobber each other's delivery entries (lost-update race). FIX: wrap the
	// entire read-modify-write in a file lock on the delivery file.
	withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		delivery.messages[complete.id] = complete.status;
		delivery.updatedAt = createdAt;
		// F4: delivery state is informational and overwritten by the next message —
		// drop explicit full durability so the default (best-effort) applies; a hard
		// crash only risks re-delivery, the accepted semantics of the default path.
		writeDeliveryState(manifest, delivery);
	});
	notifyMailboxAppended(complete);
	return complete;
}

export function appendSteeringMessage(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		body: string;
		from?: string;
		to?: string;
		priority?: MailboxMessagePriority;
		status?: MailboxMessageStatus;
		data?: Record<string, unknown>;
	},
): MailboxMessage {
	return appendMailboxMessage(manifest, {
		direction: "inbox",
		from: input.from ?? "leader",
		to: input.to ?? input.taskId,
		taskId: input.taskId,
		body: input.body,
		kind: "steer",
		priority: input.priority ?? "urgent",
		deliveryMode: "interrupt",
		status: input.status,
		data: { ...(input.data ?? {}), kind: "steer" },
	});
}

export function appendFollowUpMessage(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		body: string;
		from?: string;
		to?: string;
		priority?: MailboxMessagePriority;
		status?: MailboxMessageStatus;
		data?: Record<string, unknown>;
	},
): MailboxMessage {
	return appendMailboxMessage(manifest, {
		direction: "inbox",
		from: input.from ?? "leader",
		to: input.to ?? input.taskId,
		taskId: input.taskId,
		body: input.body,
		kind: "follow-up",
		priority: input.priority ?? "normal",
		deliveryMode: "next_turn",
		status: input.status,
		data: { ...(input.data ?? {}), kind: "follow-up" },
	});
}

/**
 * FIND-02: Async variant of appendMailboxMessage for the live-session path.
 * Uses withFileLockAsync (promise-chain, no sleepSync) instead of
 * withEventLogLockSync/withFileLockSync, preventing event-loop stalls during
 * steering/follow-up delivery. readDeliveryState/writeDeliveryState remain
 * sync but are cheap thanks to the FIND-01 delivery cache.
 */
export async function appendMailboxMessageAsync(manifest: TeamRunManifest, message: MailboxAppendInput): Promise<MailboxMessage> {
	if (message.taskId) ensureTaskMailbox(manifest, message.taskId);
	else ensureRunMailbox(manifest);
	const createdAt = new Date().toISOString();
	const complete = buildMailboxMessage(manifest, message, createdAt);
	const mbFile = mailboxFile(manifest, complete.direction, complete.taskId);
	await withFileLockAsync(mbFile, async () => {
		await fs.promises.appendFile(mbFile, `${serializeMailboxRow(complete)}\n`, "utf-8");
		rotateMailboxFileIfNeeded(mbFile);
	});
	// R1 review fix / plan §5 #6: delivery RMW uses the cross-process sync
	// lock (withFileLockSync) so sync callers (acknowledgeMailboxMessage,
	// replayPendingMailboxMessages) serialize against this async path. The
	// body has no await, so sync locking is safe and restores the
	// cross-process safety net that the async lock cannot provide.
	withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		delivery.messages[complete.id] = complete.status;
		delivery.updatedAt = createdAt;
		// PERF round 2 (mirror of the sync-twin fix at :647): delivery.json is
		// informational and the next message overwrites it — drop the forced
		// full durability so the default (best-effort) applies here too. A
		// crash risks re-delivery only, the accepted default-path semantics.
		writeDeliveryState(manifest, delivery);
	});
	notifyMailboxAppended(complete);
	return complete;
}

export async function appendSteeringMessageAsync(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		body: string;
		from?: string;
		to?: string;
		priority?: MailboxMessagePriority;
		status?: MailboxMessageStatus;
		data?: Record<string, unknown>;
	},
): Promise<MailboxMessage> {
	return appendMailboxMessageAsync(manifest, {
		direction: "inbox",
		from: input.from ?? "leader",
		to: input.to ?? input.taskId,
		taskId: input.taskId,
		body: input.body,
		kind: "steer",
		priority: input.priority ?? "urgent",
		deliveryMode: "interrupt",
		status: input.status,
		data: { ...(input.data ?? {}), kind: "steer" },
	});
}

export async function appendFollowUpMessageAsync(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		body: string;
		from?: string;
		to?: string;
		priority?: MailboxMessagePriority;
		status?: MailboxMessageStatus;
		data?: Record<string, unknown>;
	},
): Promise<MailboxMessage> {
	return appendMailboxMessageAsync(manifest, {
		direction: "inbox",
		from: input.from ?? "leader",
		to: input.to ?? input.taskId,
		taskId: input.taskId,
		body: input.body,
		kind: "follow-up",
		priority: input.priority ?? "normal",
		deliveryMode: "next_turn",
		status: input.status,
		data: { ...(input.data ?? {}), kind: "follow-up" },
	});
}

// ============================================================================
// U5 (2026-10-10): requestId idempotency — every send carries a unique
// requestId; resend-safe senders reuse the SAME one and are deduped per
// target mailbox by (direction, requestId) via an in-lock row scan (the
// durable analog of pi-durable's `tx.submissionByRequest()` exactly-once
// root-submit, per upgrade-spec U5).
// ============================================================================

export interface IdempotentMailboxAppendResult {
	message: MailboxMessage;
	/** true when an existing (direction, requestId) row in the SAME mailbox
	 *  file was reused — NO new row, NO delivery-state write, NO observer
	 *  notification (the original append already did all three). */
	deduped: boolean;
}

/** Row-level (direction, requestId) match against one mailbox file — the
 *  same keying findMailboxMessageByRequestId exposes. Checks the U5
 *  top-level field and the legacy `data.requestId` shape (group_join). */
function findRequestIdRowInFile(filePath: string, direction: MailboxDirection, requestId: string): MailboxMessage | undefined {
	return safeReadMailboxFile(filePath, direction).find(
		(message) => message.requestId === requestId || message.data?.requestId === requestId,
	);
}

function recordDeliveryEntry(manifest: TeamRunManifest, complete: MailboxMessage, createdAt: string): void {
	withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		delivery.messages[complete.id] = complete.status;
		delivery.updatedAt = createdAt;
		writeDeliveryState(manifest, delivery);
	});
}

/** U5: idempotent SYNC append — if the target mailbox file already holds a
 *  row with this (direction, requestId), return that row (deduped) without
 *  writing anything. The check-then-append runs INSIDE the mailbox file lock
 *  so two concurrent sends with the same requestId cannot both append. */
export function appendMailboxMessageIdempotent(
	manifest: TeamRunManifest,
	message: MailboxAppendInput & { requestId: string },
): IdempotentMailboxAppendResult {
	if (message.taskId) ensureTaskMailbox(manifest, message.taskId);
	else ensureRunMailbox(manifest);
	const createdAt = new Date().toISOString();
	const complete = buildMailboxMessage(manifest, message, createdAt);
	const mbFile = mailboxFile(manifest, complete.direction, complete.taskId);
	let stored: MailboxMessage | undefined;
	withFileLockSync(mbFile, () => {
		const existing = findRequestIdRowInFile(mbFile, complete.direction, message.requestId);
		if (existing) {
			stored = existing;
			return;
		}
		fs.appendFileSync(mbFile, `${serializeMailboxRow(complete)}\n`, "utf-8");
		rotateMailboxFileIfNeeded(mbFile);
	});
	if (stored) return { message: stored, deduped: true };
	recordDeliveryEntry(manifest, complete, createdAt);
	notifyMailboxAppended(complete);
	return { message: complete, deduped: false };
}

/** U5: async twin of appendMailboxMessageIdempotent for the broker fan-out
 *  path (withFileLockAsync — promise-chain, no sleepSync stall). The
 *  delivery RMW keeps the cross-process sync lock, mirroring
 *  appendMailboxMessageAsync. */
export async function appendMailboxMessageIdempotentAsync(
	manifest: TeamRunManifest,
	message: MailboxAppendInput & { requestId: string },
): Promise<IdempotentMailboxAppendResult> {
	if (message.taskId) ensureTaskMailbox(manifest, message.taskId);
	else ensureRunMailbox(manifest);
	const createdAt = new Date().toISOString();
	const complete = buildMailboxMessage(manifest, message, createdAt);
	const mbFile = mailboxFile(manifest, complete.direction, complete.taskId);
	let stored: MailboxMessage | undefined;
	await withFileLockAsync(mbFile, async () => {
		const existing = findRequestIdRowInFile(mbFile, complete.direction, message.requestId);
		if (existing) {
			stored = existing;
			return;
		}
		await fs.promises.appendFile(mbFile, `${serializeMailboxRow(complete)}\n`, "utf-8");
		rotateMailboxFileIfNeeded(mbFile);
	});
	if (stored) return { message: stored, deduped: true };
	recordDeliveryEntry(manifest, complete, createdAt);
	notifyMailboxAppended(complete);
	return { message: complete, deduped: false };
}

/** U5: durable receiver-side dedup record — the worker inbox pickup marks the
 *  messages it surfaced as consumed: `messages[id] = "acknowledged"` (the F09
 *  durable record; the inbox line itself never flips status) plus the
 *  recipient-scoped `${direction}:${taskId}:${requestId}` index. Both survive
 *  restart, so a later poll (fresh process, empty seen-set) still drops them. */
export interface MailboxRequestIdDeliveryRecord {
	direction: MailboxDirection;
	messageId: string;
	/** The RECIPIENT mailbox this pickup consumed (the polling task).
	 *  M3-9 / R33-1: part of the index key — see {@link requestIdDeliveryKey}.
	 *  Undefined = the run-level mailbox. */
	taskId?: string;
	/** Optional: rows without a requestId (pre-U5 legacy) only get the
	 *  by-id acknowledged record. */
	requestId?: string;
}

/**
 * M3-9 / R33-1 — THE delivery-index key: `${direction}:${recipient}:${requestId}`.
 *
 * Round 33 probe (fan-out delivered 1/0/0): a group send mints ONE requestId
 * (crew-broker handleMsgSend) and reuses it for every recipient. The pickup
 * index was run-scoped (`${direction}:${requestId}`), so the FIRST recipient to
 * ack wrote the key and every SIBLING recipient was then starved at its own
 * pickup — one delivered, the rest silently dropped (and the
 * `mailbox.pickup_deduped` audit logged it as an expected duplicate).
 * Recipient scoping restores per-recipient exactly-once: each recipient's
 * mailbox gets its own entry for the same requestId, so all N copies deliver
 * (once each).
 *
 * Migration: keys written before this change use the legacy two-part shape and
 * are no longer matched. Safe — the same-row case stays covered by the
 * per-message `messages[id]="acknowledged"` record, and the send-side
 * idempotent append prevents a resend from adding a second row at all.
 */
export function requestIdDeliveryKey(direction: MailboxDirection, recipientTaskId: string | undefined, requestId: string): string {
	return `${direction}:${recipientTaskId ?? "-"}:${requestId}`;
}

export function recordMailboxRequestIdDelivery(manifest: TeamRunManifest, records: MailboxRequestIdDeliveryRecord[]): MailboxDeliveryState {
	return withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		for (const record of records) {
			delivery.messages[record.messageId] = "acknowledged";
			if (record.requestId)
				(delivery.requestIds ??= {})[requestIdDeliveryKey(record.direction, record.taskId, record.requestId)] = record.messageId;
		}
		delivery.updatedAt = new Date().toISOString();
		// Pickup is terminal for that message on the worker side — full durability
		// (same rationale as acknowledgeMailboxMessage).
		writeDeliveryState(manifest, delivery, { durability: "full" });
		return delivery;
	});
}

export function listMailboxByKind(manifest: TeamRunManifest, kind: MailboxMessageKind, direction?: MailboxDirection): MailboxMessage[] {
	const messages = direction
		? readAllMessages(manifest, direction)
		: [...readAllMessages(manifest, "inbox"), ...readAllMessages(manifest, "outbox")].sort((a, b) =>
				a.createdAt.localeCompare(b.createdAt),
			);
	return messages.filter((message) => message.kind === kind || message.data?.kind === kind);
}

export function findMailboxMessageByRequestId(
	manifest: TeamRunManifest,
	requestId: string,
	scope?: { direction?: MailboxDirection; taskId?: string },
): MailboxMessage | undefined {
	// U5: also match the top-level `requestId` field (new sends) alongside the
	// legacy `data.requestId` shape (group_join) so one lookup covers both.
	const matches = (message: MailboxMessage) => message.requestId === requestId || message.data?.requestId === requestId;
	if (scope) return readMailbox(manifest, scope.direction, scope.taskId).find(matches);
	return readMailbox(manifest).find(matches);
}

export function readMailboxMessage(manifest: TeamRunManifest, messageId: string): MailboxMessage | undefined {
	return readMailbox(manifest).find((message) => message.id === messageId);
}

/** Verdict of the W10-3 strict replyTo origin check (lesson #22, A→B→C). */
export type ReplyToRequesterOrigin =
	| { verdict: "no-reply-to" }
	| { verdict: "match"; replyTo: string; requester: string }
	| { verdict: "origin-not-found"; replyTo: string }
	| { verdict: "mismatch"; replyTo: string; originalFrom: string; responseTo: string };

/**
 * W10-3 (2026-10-22, lesson #22): strict replyTo routing predicate.
 *
 * Gap (verified 2-way): `replyTo` was parse/serialize-only — NOTHING validated
 * that a response tagged with a `replyTo` was resolving a request opened by
 * the SAME requester the response is addressed to. With parallel lanes asking
 * concurrently, a reply meant for B (replyTo → a request B opened) could
 * resolve C's waiting park (A→B→C confusion) when its questionId happened to
 * tag C.
 *
 * Rule: when a response carries `replyTo`, the ORIGINAL message that id points
 * at (searched across global + every task mailbox, live + archives — the same
 * scan space `updateMailboxMessageReply` uses) must have been opened by
 * (`from` ===) the requester the response is addressed to (`to`). Verdicts:
 *  - "no-reply-to"        — untagged legacy responses: nothing to verify.
 *  - "match"              — right pair (original.from === response.to).
 *  - "origin-not-found"   — the replyTo id cannot be resolved (rotated out,
 *                          garbage, cross-run): unverifiable — callers keep
 *                          the exact-questionId correlation as the primary
 *                          defense and only log (fail-open, no availability
 *                          regression on stale ids).
 *  - "mismatch"           — A→B→C: original found but opened by a DIFFERENT
 *                          requester ⇒ callers MUST NOT resolve the waiting
 *                          task with this response (log + skip).
 *
 * Pure read-only; throws never (a mailbox read failure surfaces as
 * "origin-not-found" so the caller's own error handling decides).
 */
export function checkReplyToRequesterOrigin(manifest: TeamRunManifest, response: MailboxMessage): ReplyToRequesterOrigin {
	const replyTo = response.replyTo;
	if (replyTo === undefined) return { verdict: "no-reply-to" };
	let original: MailboxMessage | undefined;
	try {
		original = readAllMailboxMessages(manifest).find((message) => message.id === replyTo);
	} catch {
		// Unreadable mailbox during the lookup — unverifiable, same as not found.
		return { verdict: "origin-not-found", replyTo };
	}
	if (!original) return { verdict: "origin-not-found", replyTo };
	if (original.from === response.to) return { verdict: "match", replyTo, requester: original.from };
	return { verdict: "mismatch", replyTo, originalFrom: original.from, responseTo: response.to };
}

export function acknowledgeMailboxMessage(manifest: TeamRunManifest, messageId: string): MailboxDeliveryState {
	// BUGFIX (Round 12 I6): unlocked read-modify-write on delivery.json could
	// clobber concurrent appends. FIX: wrap in a file lock.
	return withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		if (!delivery.messages[messageId]) throw new Error(`Mailbox message '${messageId}' not found.`);
		delivery.messages[messageId] = "acknowledged";
		delivery.updatedAt = new Date().toISOString();
		// F4: acknowledge is terminal for that message — keep full durability.
		writeDeliveryState(manifest, delivery, { durability: "full" });
		return delivery;
	});
}

/**
 * Update an original mailbox message with reply metadata.
 * Rewrites the mailbox file line containing the original message
 * to include `repliedAt` and `replyContent`.
 *
 * R7-3 (2026-10-16): the original may have been ROTATED out of the live file
 * into a `*.archive.jsonl` sibling (rotateMailboxFileIfNeeded). Archives are
 * IMMUTABLE history — they are never rewritten here. When the original is
 * found only in an archive, a COMPENSATING record (same id + reply metadata)
 * is appended to the LIVE file instead; safeReadMailboxFile merges by id
 * last-wins (live overrides archive), so every reader sees the reply-marked
 * message. Global run mailboxes AND every task mailbox (inbox + outbox, live
 * + archives) are scanned.
 */
export function updateMailboxMessageReply(manifest: TeamRunManifest, originalMessageId: string, replyContent: string): void {
	const directions: MailboxDirection[] = ["inbox", "outbox"];

	// Collect all mailbox file paths (global + task-specific)
	const filesToSearch: Array<{
		filePath: string;
		direction: MailboxDirection;
	}> = [];
	for (const direction of directions) {
		filesToSearch.push({
			filePath: mailboxFile(manifest, direction),
			direction,
		});
	}
	const tasksDir = safeMailboxTasksRoot(manifest);
	if (fs.existsSync(tasksDir)) {
		for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const direction of directions) {
				filesToSearch.push({
					filePath: mailboxFile(manifest, direction, entry.name),
					direction,
				});
			}
		}
	}

	for (const { filePath, direction } of filesToSearch) {
		const archives = listMailboxArchives(filePath);
		if (fs.existsSync(filePath)) {
			// Path 1 (original behavior): the message still lives in the LIVE
			// file — rewrite its line in place.
			// FIX: Wrap read-modify-write in withFileLockSync to prevent concurrent
			// updates from clobbering each other (each reply rewrites the whole file).
			const found = withFileLockSync(filePath, () => {
				const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
				let localFound = false;
				const updatedLines: string[] = [];
				for (const line of lines) {
					try {
						const parsed = JSON.parse(line) as unknown;
						const msg = parseMailboxMessage(parsed, direction);
						if (msg && msg.id === originalMessageId) {
							msg.repliedAt = new Date().toISOString();
							msg.replyContent = replyContent;
							// w1a: the rewrite mutates signed fields — re-sign so the
							// row stays authentic under the writer process key.
							updatedLines.push(serializeMailboxRow(msg));
							localFound = true;
						} else {
							updatedLines.push(line);
						}
					} catch {
						updatedLines.push(line);
					}
				}
				if (localFound) {
					atomicWriteFile(filePath, `${updatedLines.join("\n")}\n`);
				}
				return localFound;
			});
			if (found) return;
		}
		if (archives.length === 0) continue;
		// Path 2 (R7-3): the original was rotated into an archive. Archives are
		// immutable (see safeReadMailboxFile) — do NOT rewrite them; append a
		// compensating record carrying the reply metadata to the LIVE file.
		// The id-based last-wins merge makes it win over the archived original.
		const archived = archives
			.flatMap((archivePath) => cachedMailboxRead(archivePath, direction))
			.find((message) => message.id === originalMessageId);
		if (!archived) continue;
		const compensating: MailboxMessage = {
			...archived,
			repliedAt: new Date().toISOString(),
			replyContent,
		};
		withFileLockSync(filePath, () => {
			// Recreate the live file if it went missing — the archives in this
			// directory prove the mailbox itself is valid.
			if (!fs.existsSync(filePath)) atomicWriteFile(filePath, "");
			// w1a: compensating records are NEW durable rows — sign them like any
			// append, or the delivery-read gate would drop them as unauthenticated.
			fs.appendFileSync(filePath, `${serializeMailboxRow(compensating)}\n`, "utf-8");
			// The append may itself trigger rotation — safe: the compensating
			// record then lands in the NEWEST archive, which sorts after the
			// original's archive in the merge order, so it still wins by id.
			rotateMailboxFileIfNeeded(filePath);
		});
		return;
	}
	// Not finding the original is non-fatal; the reply is still delivered.
}

export function replayPendingMailboxMessages(manifest: TeamRunManifest): MailboxReplayResult {
	// BUGFIX (Round 12 I6): unlocked read-modify-write on delivery.json could
	// clobber concurrent appends/acknowledgments. FIX: wrap in a file lock.
	return withFileLockSync(deliveryFile(manifest, true), () => {
		const delivery = readDeliveryState(manifest);
		const pending = readAllInboxMessages(manifest).filter(
			(message) => message.status !== "acknowledged" && delivery.messages[message.id] !== "acknowledged",
		);
		if (!pending.length) return { messages: [], updatedAt: delivery.updatedAt };
		const updatedAt = new Date().toISOString();
		for (const message of pending) delivery.messages[message.id] = "delivered";
		delivery.updatedAt = updatedAt;
		writeDeliveryState(manifest, delivery);
		return { messages: pending, updatedAt };
	});
}

export function validateMailbox(
	manifest: TeamRunManifest,
	options: { repair?: boolean; signal?: AbortSignal } = {},
): MailboxValidationReport {
	ensureRunMailbox(manifest);
	const issues: MailboxValidationIssue[] = [];
	const repaired: string[] = [];
	// L-9 (2026-10-16): validate + repair the TASK mailboxes
	// (`mailbox/tasks/<id>/<direction>.jsonl`) with the same line-parse
	// semantics as the run-level files — enumerate the tasks dir the same way
	// updateMailboxMessageReply does. Rotated `*.archive.jsonl` files are
	// immutable history and are deliberately NOT repaired.
	const filesToValidate: Array<{ filePath: string; direction: MailboxDirection }> = [];
	for (const direction of ["inbox", "outbox"] as const) {
		filesToValidate.push({ filePath: mailboxFile(manifest, direction), direction });
	}
	const tasksDir = safeMailboxTasksRoot(manifest);
	if (fs.existsSync(tasksDir)) {
		for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const direction of ["inbox", "outbox"] as const) {
				filesToValidate.push({ filePath: mailboxFile(manifest, direction, entry.name), direction });
			}
		}
	}
	for (const { filePath, direction } of filesToValidate) {
		if (options.signal?.aborted) break;
		if (!fs.existsSync(filePath)) continue;
		// FIX: Wrap read + optional repair in withFileLockSync so concurrent appends
		// don't race with the read-modify-write. Mailbox files are capped at 10MB
		// (MAILBOX_ARCHIVE_THRESHOLD_BYTES), so the per-call memory is bounded.
		withFileLockSync(filePath, () => {
			const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/).filter(Boolean);
			const validLines: string[] = [];
			for (let i = 0; i < lines.length; i += 1) {
				if (options.signal?.aborted) break;
				const line = lines[i];
				if (!line) continue;
				try {
					const parsed = JSON.parse(line) as unknown;
					const message = parseMailboxMessage(parsed, direction);
					if (!message) throw new Error("invalid message schema");
					// w1a: preserve the ORIGINAL line bytes for valid rows. The old
					// re-serialization here stripped Ed25519 signatures from every
					// valid line on a repair pass (repair only rewrites when at least
					// one line was invalid), silently de-authenticating the whole
					// file. Repair must never drop NOR forge authentication — keep
					// the row exactly as written.
					validLines.push(line);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					issues.push({ level: "error", path: filePath, message });
				}
			}
			if (options.repair && validLines.length !== lines.length) {
				atomicWriteFile(filePath, `${validLines.join("\n")}${validLines.length ? "\n" : ""}`);
				repaired.push(filePath);
			}
		});
	}
	const delivery = readDeliveryState(manifest);
	// L-9: delivery-entry coverage now includes task mailbox messages
	// (readAllMessages walks the global files AND every task mailbox).
	const allMessages = [...readAllMessages(manifest, "inbox"), ...readAllMessages(manifest, "outbox")];
	for (const message of allMessages) {
		if (options.signal?.aborted) break;
		if (!delivery.messages[message.id])
			issues.push({
				level: "warning",
				path: deliveryFile(manifest),
				message: `Missing delivery entry for ${message.id}.`,
			});
	}
	if (options.repair) {
		for (const message of allMessages) delivery.messages[message.id] ??= message.status;
		delivery.updatedAt = new Date().toISOString();
		writeDeliveryState(manifest, delivery);
		repaired.push(deliveryFile(manifest));
	}
	return { issues, repaired };
}
