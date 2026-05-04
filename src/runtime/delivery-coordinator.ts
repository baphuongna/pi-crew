import type { NotificationDescriptor } from "../extension/notification-router.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface PendingDelivery {
	runId: string;
	payload: unknown;
	timestamp: number;
	type: "result" | "notification" | "steer";
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
	private ownerSessionId: string | undefined;
	private active = false;
	private pending: PendingDelivery[] = [];
	private readonly deps: DeliveryCoordinatorDeps;
	private ttlTimer: ReturnType<typeof setInterval> | undefined;

	constructor(deps: DeliveryCoordinatorDeps) {
		this.deps = deps;
		this.ttlTimer = setInterval(() => this.evictExpired(), 60_000);
		this.ttlTimer.unref();
	}

	activate(sessionId: string): void {
		this.ownerSessionId = sessionId;
		this.active = true;
		this.flushQueuedResults();
	}

	deactivate(): void {
		this.active = false;
		this.ownerSessionId = undefined;
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
		this.enqueue({ runId, payload: result, timestamp: Date.now(), type: "result" });
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
				} catch { /* secondary delivery, ignore errors */ }
			}
			return;
		}
		this.enqueue({ runId: notification.runId ?? "", payload: notification, timestamp: Date.now(), type: "notification" });
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
		this.enqueue({ runId, payload: message, timestamp: Date.now(), type: "steer" });
	}

	flushQueuedResults(): void {
		if (!this.active || this.pending.length === 0) return;
		const batch = this.pending.splice(0);
		for (const delivery of batch) {
			try {
				switch (delivery.type) {
					case "result":
						this.deliverResult(delivery.runId, delivery.payload);
						break;
					case "notification": {
						const notification = delivery.payload as NotificationDescriptor;
						this.deliverNotification(notification);
						break;
					}
					case "steer": {
						const message = typeof delivery.payload === "string" ? delivery.payload : String(delivery.payload);
						this.deliverSteer(delivery.runId, message);
						break;
					}
				}
			} catch (error) {
				logInternalError("delivery-coordinator.flush", error, `runId=${delivery.runId} type=${delivery.type}`);
			}
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

	private enqueue(delivery: PendingDelivery): void {
		this.pending.push(delivery);
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