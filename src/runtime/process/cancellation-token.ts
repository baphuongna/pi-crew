import { type CancellationReason, CrewCancellationError, cancellationReasonFromUnknown } from "./cancellation.ts";

export interface CancellationTokenState {
	aborted: boolean;
	reason?: CancellationReason;
	lastHeartbeatAt?: string;
	lastHeartbeatStage?: string;
}

export interface CancellationTokenOptions {
	signal?: AbortSignal;
	onHeartbeat?: (state: CancellationTokenState) => void;
	now?: () => Date;
}

export class CancellationToken {
	readonly #controller = new AbortController();
	readonly #onHeartbeat?: (state: CancellationTokenState) => void;
	readonly #now: () => Date;
	#reason?: CancellationReason;
	#lastHeartbeatAt?: string;
	#lastHeartbeatStage?: string;

	constructor(options: CancellationTokenOptions = {}) {
		this.#onHeartbeat = options.onHeartbeat;
		this.#now = options.now ?? (() => new Date());
		if (options.signal?.aborted) this.abort(options.signal.reason);
		else if (options.signal) options.signal.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}
	get aborted(): boolean {
		return this.#controller.signal.aborted;
	}
	get reason(): CancellationReason | undefined {
		return this.#reason;
	}
	get lastHeartbeatAt(): string | undefined {
		return this.#lastHeartbeatAt;
	}
	get lastHeartbeatStage(): string | undefined {
		return this.#lastHeartbeatStage;
	}

	heartbeat(stage?: string): CancellationTokenState {
		this.throwIfCancelled();
		this.#lastHeartbeatAt = this.#now().toISOString();
		this.#lastHeartbeatStage = stage;
		const state = this.state();
		this.#onHeartbeat?.(state);
		return state;
	}

	throwIfCancelled(): void {
		if (this.aborted) throw new CrewCancellationError(this.#reason ?? cancellationReasonFromUnknown(this.#controller.signal.reason));
	}

	abort(reason?: unknown): void {
		if (this.aborted) return;
		this.#reason = cancellationReasonFromUnknown(reason);
		this.#controller.abort(this.#reason);
	}

	wait(ms: number): Promise<void> {
		this.throwIfCancelled();
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined;
			const cleanup = (): void => {
				if (timeout) clearTimeout(timeout);
				this.signal.removeEventListener("abort", onAbort);
			};
			const onAbort = (): void => {
				cleanup();
				reject(new CrewCancellationError(this.#reason ?? cancellationReasonFromUnknown(this.signal.reason)));
			};
			timeout = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);
			this.signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	state(): CancellationTokenState {
		return {
			aborted: this.aborted,
			...(this.#reason ? { reason: this.#reason } : {}),
			...(this.#lastHeartbeatAt ? { lastHeartbeatAt: this.#lastHeartbeatAt } : {}),
			...(this.#lastHeartbeatStage ? { lastHeartbeatStage: this.#lastHeartbeatStage } : {}),
		};
	}
}

export function createCancellationToken(options: CancellationTokenOptions = {}): CancellationToken {
	return new CancellationToken(options);
}
