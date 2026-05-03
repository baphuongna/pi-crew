/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
			return;
		}

		let settled = false;
		const cleanup = (): void => {
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		}, ms);

		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};

		signal?.addEventListener("abort", onAbort);
	});
}
