import { logInternalError } from "../utils/internal-error.ts";

export type Severity = "info" | "warning" | "error" | "critical";

export interface NotificationDescriptor {
	id?: string;
	severity: Severity;
	source: string;
	runId?: string;
	title: string;
	body?: string;
	timestamp?: number;
}

export interface NotificationRouterOptions {
	dedupWindowMs?: number;
	batchWindowMs?: number;
	quietHours?: string;
	severityFilter?: Severity[];
	sink?: (notification: NotificationDescriptor) => void;
	now?: () => number;
}

const DEFAULT_SEVERITY_FILTER: Severity[] = ["warning", "error", "critical"];
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export function parseHHMMRange(range: string): { startMin: number; endMin: number } {
	const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range);
	if (!match) throw new Error(`Invalid quiet-hours range '${range}'. Expected HH:MM-HH:MM.`);
	const [, sh, sm, eh, em] = match;
	const startHour = Number(sh);
	const startMinute = Number(sm);
	const endHour = Number(eh);
	const endMinute = Number(em);
	if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) throw new Error(`Invalid quiet-hours range '${range}'.`);
	return { startMin: startHour * 60 + startMinute, endMin: endHour * 60 + endMinute };
}

export function isInQuietHours(range: string, now = new Date()): boolean {
	const { startMin, endMin } = parseHHMMRange(range);
	const current = now.getHours() * 60 + now.getMinutes();
	if (startMin === endMin) return false;
	return startMin <= endMin ? current >= startMin && current < endMin : current >= startMin || current < endMin;
}

function notificationKey(notification: NotificationDescriptor): string {
	return notification.id ?? `${notification.source}:${notification.runId ?? "global"}:${notification.title}`;
}

function batchSeverity(items: NotificationDescriptor[]): Severity {
	return items.reduce((highest, item) => SEVERITY_RANK[item.severity] > SEVERITY_RANK[highest] ? item.severity : highest, "info" as Severity);
}

export class NotificationRouter {
	private readonly opts: NotificationRouterOptions;
	private readonly deliver: (notification: NotificationDescriptor) => void;
	private readonly seen = new Map<string, number>();
	private batch: NotificationDescriptor[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private static readonly SEEN_MAP_MAX_SIZE = 10000;

	constructor(opts: NotificationRouterOptions = {}, deliver: (notification: NotificationDescriptor) => void) {
		this.opts = opts;
		this.deliver = deliver;
	}

	/**
	 * Evict oldest entries from seen Map if it exceeds MAX_SIZE.
	 * This prevents unbounded memory growth from notifications without TTL.
	 */
	private evictSeenIfNeeded(): void {
		if (this.seen.size > NotificationRouter.SEEN_MAP_MAX_SIZE) {
			// Sort by timestamp (oldest first) and keep only half
			const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
			const keepCount = Math.floor(NotificationRouter.SEEN_MAP_MAX_SIZE / 2);
			for (const [key] of entries.slice(0, entries.length - keepCount)) {
				this.seen.delete(key);
			}
		}
	}

	enqueue(notification: NotificationDescriptor): boolean {
		const now = this.opts.now?.() ?? Date.now();
		const withTime = { ...notification, timestamp: notification.timestamp ?? now };
		try {
			this.opts.sink?.(withTime);
		} catch (sinkError) {
			logInternalError("notification-sink", sinkError);
		}
		const filter = this.opts.severityFilter ?? DEFAULT_SEVERITY_FILTER;
		if (!filter.includes(withTime.severity)) return false;
		if (this.opts.quietHours && isInQuietHours(this.opts.quietHours, new Date(now))) return false;
		const key = notificationKey(withTime);
		const dedupWindow = this.opts.dedupWindowMs ?? 30_000;
		const previous = this.seen.get(key);
		if (previous !== undefined && now - previous < dedupWindow) return false;
		this.seen.set(key, now);
		this.evictSeenIfNeeded();
		const batchWindow = this.opts.batchWindowMs ?? 0;
		if (batchWindow <= 0) {
			this.deliver(withTime);
			return true;
		}
		this.batch.push(withTime);
		if (!this.timer) this.timer = setTimeout(() => this.flush(), batchWindow);
		return true;
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.batch.length === 0) return;
		const items = this.batch;
		this.batch = [];
		if (items.length === 1) {
			this.deliver(items[0]!);
			return;
		}
		this.deliver({
			id: `batch:${items.map((item) => notificationKey(item)).join(",")}`,
			severity: batchSeverity(items),
			source: "batch",
			title: `${items.length} pi-crew notifications`,
			body: items.map((item) => `• ${item.title}`).join("\n"),
			timestamp: this.opts.now?.() ?? Date.now(),
		});
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.batch = [];
		this.seen.clear();
	}
}
