import type { NotificationDescriptor } from "../extension/notification-router.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface PendingDelivery {
	runId: string;
	payload: unknown;
	timestamp: number;
	type: "result" | "notification" | "steer";
	generation?: number;
}

export interface DeliveryCoordinatorDeps {
	/** Emit an event to the active Pi event bus. */
	emit?: (event: string, data: unknown) => void;
	/** Send a follow-up message to the active session (for notifications). */
	sendFollowUp?: (title: string, body: string) => void;
	/** Send a wake-up message to the active session (for async results). */
	sendWakeUp?: (message: string) => void;
}

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DeliveryCoordinator {
	private active = false;
	private generation = 0;
	private pending: PendingDelivery[] = [];
	private flushing = false;
	private readonly deps: DeliveryCoordinatorDeps;
	private ttlTimer: ReturnType<typeof setInterval> | undefined;
	private timerStarted = false;
	private ownerSessionId: string | undefined = undefined;

	constructor(deps: DeliveryCoordinatorDeps) {
		this.deps = deps;
	}

	activate(sessionId: string): void {
		this.ownerSessionId = sessionId;
		this.active = true;
		this.flushQueuedResults();
	}

	deactivate(): void {
		this.active = false;
		this.ownerSessionId = undefined;
		this.generation += 1;
	}

	isActive(): boolean {
		return this.active;
	}

	getPendingCount(): number {
		return this.pending.length;
	}

	deliverResult(runId: string, result: unknown): void {
		if (this.active && this.deps.emit) {
			try {
				this.deps.emit("pi-crew:run-result", result);
				return;
			} catch (error) {
				logInternalError("delivery-coordinator.deliverResult", error, `runId=${runId}`);
			}
		}
		if (!this.flushing)
			this.enqueue({
				runId,
				payload: result,
				timestamp: Date.now(),
				type: "result",
			});
	}

	deliverNotification(notification: NotificationDescriptor): void {
		let delivered = false;
		if (this.active && this.deps.sendFollowUp) {
			try {
				this.deps.sendFollowUp(notification.title, notification.body ?? "");
				delivered = true;
			} catch (error) {
				logInternalError("delivery-coordinator.deliverNotification", error, `id=${notification.id}`);
			}
		}
		if (delivered) {
			if (this.deps.emit) {
				try {
					this.deps.emit("pi-crew:notification", notification);
				} catch {
					/* secondary delivery, ignore errors */
				}
			}
			return;
		}
		if (!this.flushing)
			this.enqueue({
				runId: notification.runId ?? "",
				payload: notification,
				timestamp: Date.now(),
				type: "notification",
			});
	}

	deliverSteer(runId: string, message: string): void {
		if (this.active && this.deps.sendWakeUp) {
			try {
				this.deps.sendWakeUp(message);
				return;
			} catch (error) {
				logInternalError("delivery-coordinator.deliverSteer", error, `runId=${runId}`);
			}
		}
		if (!this.flushing)
			this.enqueue({
				runId,
				payload: message,
				timestamp: Date.now(),
				type: "steer",
			});
	}

	flushQueuedResults(): void {
		if (!this.active || this.pending.length === 0) return;
		// HIGH-16/ MEDIUM-16: Set flushing BEFORE splice to prevent re-entrancy
		if (this.flushing) return;
		this.flushing = true;
		// Note: this.flushing is now set, so concurrent calls will exit early due to the check above
		// This serves as a simple lock to prevent race conditions
		const batch = this.pending.splice(0);
		try {
			const retryLater: PendingDelivery[] = [];
			for (const delivery of batch) {
				if (delivery.type === "steer" && delivery.generation !== undefined && delivery.generation !== this.generation) {
					logInternalError("delivery-coordinator.flush.stale", undefined, `runId=${delivery.runId} type=${delivery.type}`);
					continue;
				}
				try {
					if (!this.deliverQueued(delivery))
						retryLater.push({
							...delivery,
							generation: this.generation,
						});
				} catch (error) {
					logInternalError("delivery-coordinator.flush", error, `runId=${delivery.runId} type=${delivery.type}`);
					retryLater.push({
						...delivery,
						generation: this.generation,
					});
				}
			}
			this.pending.unshift(...retryLater);
		} finally {
			this.flushing = false;
		}
	}

	dispose(): void {
		this.deactivate();
		this.pending.length = 0;
		if (this.ttlTimer) {
			clearInterval(this.ttlTimer);
			this.ttlTimer = undefined;
		}
	}

	private deliverQueued(delivery: PendingDelivery): boolean {
		switch (delivery.type) {
			case "result":
				if (!this.deps.emit) return false;
				this.deps.emit("pi-crew:run-result", delivery.payload);
				return true;
			case "notification": {
				const notification = delivery.payload as NotificationDescriptor;
				if (!this.deps.sendFollowUp) return false;
				this.deps.sendFollowUp(notification.title, notification.body ?? "");
				try {
					this.deps.emit?.("pi-crew:notification", notification);
				} catch {
					// Secondary event delivery must not consume the user-facing notification.
				}
				return true;
			}
			case "steer": {
				if (!this.deps.sendWakeUp) return false;
				const message = typeof delivery.payload === "string" ? delivery.payload : String(delivery.payload);
				this.deps.sendWakeUp(message);
				return true;
			}
		}
	}

	private enqueue(delivery: PendingDelivery): void {
		// Lazily start the TTL timer on first enqueue (only if never started)
		if (!this.timerStarted) {
			this.timerStarted = true;
			this.ttlTimer = setInterval(() => this.evictExpired(), 60_000);
			this.ttlTimer.unref();
		}
		this.pending.push({ ...delivery, generation: this.generation });
	}

	private evictExpired(): void {
		const cutoff = Date.now() - PENDING_TTL_MS;
		const before = this.pending.length;
		this.pending = this.pending.filter((d) => d.timestamp > cutoff);
		const evicted = before - this.pending.length;
		if (evicted > 0) {
			logInternalError("delivery-coordinator.evict", undefined, `evicted=${evicted} remaining=${this.pending.length}`);
		}
	}
}
