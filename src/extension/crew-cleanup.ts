import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupAllTrackedTempDirs } from "../runtime/pi-args.ts";
import { logInternalError } from "../utils/internal-error.ts";

// NOTE: globalProgressTracker import kept for documentation but not directly used
// since we don't have agent IDs to untrack. Actual progress clearing should be
// handled by the progress tracker itself on shutdown.
// import { globalProgressTracker } from "../runtime/progress-tracker.ts";

/**
 * Registers cleanup handlers for graceful shutdown.
 * Handles session_shutdown and SIGTERM/SIGHUP signals.
 */

// Module-level flag to ensure signal handlers are registered only once,
// even if registerCleanupHandler is called multiple times (e.g., on extension
// reload or during dev hot-reload). Without this, listeners stack up and
// cleanupChildProcesses fires N times on shutdown.
let signalHandlersRegistered = false;

interface ChildProcessInfo {
	pid: number;
	runId: string;
	agentId: string;
	startedAt: number;
}

class ChildProcessRegistry {
	private processes = new Map<number, ChildProcessInfo>();

	register(pid: number, runId: string, agentId: string): void {
		this.processes.set(pid, { pid, runId, agentId, startedAt: Date.now() });
	}

	unregister(pid: number): void {
		this.processes.delete(pid);
	}

	getAllPids(): number[] {
		return Array.from(this.processes.keys());
	}

	getInfo(pid: number): ChildProcessInfo | undefined {
		return this.processes.get(pid);
	}

	clear(): void {
		this.processes.clear();
	}
}

export const childProcessRegistry = new ChildProcessRegistry();

export function registerCleanupHandler(pi: ExtensionAPI): void {
	// Handle session_shutdown event
	pi.on("session_shutdown", async () => {
		console.log("[pi-crew] Session shutdown - cleaning up resources");

		try {
			// Kill all child-pi processes
			await cleanupChildProcesses();

			// Cleanup temp directories
			await cleanupTempDirectories();

			console.log("[pi-crew] Cleanup complete");
		} catch (error) {
			logInternalError("crew-cleanup.shutdown", error);
		}
	});

	// Register signal handlers exactly once, even if registerCleanupHandler
	// is called multiple times. This prevents listener stacking on extension
	// reload and avoids double-cleanup on shutdown.
	if (!signalHandlersRegistered) {
		signalHandlersRegistered = true;
		const handleSignal = async (signal: string): Promise<void> => {
			console.log(`[pi-crew] Received ${signal} - starting cleanup`);
			await cleanupChildProcesses();
		};
		process.on("SIGTERM", () => {
			handleSignal("SIGTERM").catch((error) => {
				logInternalError("crew-cleanup.SIGTERM", error);
			});
		});
		process.on("SIGHUP", () => {
			handleSignal("SIGHUP").catch((error) => {
				logInternalError("crew-cleanup.SIGHUP", error);
			});
		});
	}
}

async function cleanupChildProcesses(): Promise<void> {
	const pids = childProcessRegistry.getAllPids();
	if (pids.length === 0) return;
	// Lazy-import to avoid eagerly pulling the heavy runtime/child-pi chain into the
	// extension load path (check-lazy-imports) AND to avoid a static import cycle
	// (child-pi.ts already imports registerChildProcess from this module).
	// LAZY: defer child-pi.ts load (heavy runtime chain) + avoid static import cycle.
	const { killProcessPid } = await import("../runtime/child-pi.ts");
	for (const pid of pids) {
		// killProcessPid signals the whole process GROUP (-pid on POSIX, taskkill /T on
		// Windows) and escalates to SIGKILL after HARD_KILL_MS. A bare
		// process.kill(pid, "SIGTERM") only reaches the direct child — grandchildren
		// (bash/MCP the worker spawned) in the child's group survive as orphans, and
		// a child that lags SIGTERM would linger forever with no escalation.
		// NOTE: on graceful session_shutdown (reason=quit/reload) register.ts ALSO runs
		// terminateActiveChildPiProcesses(); both are idempotent for a dying pid. This
		// signal handler (SIGTERM/SIGHUP) is the SOLE teardown path when the Pi process
		// is killed by signal, so it must be robust on its own.
		try {
			killProcessPid(pid);
			console.log(`[pi-crew] Sent group SIGTERM (+SIGKILL escalation) to child process ${pid}`);
		} catch (error: unknown) {
			// Process may already be dead or not exist
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ESRCH" && err.code !== "ENOENT") {
				logInternalError("crew-cleanup.kill", error, `pid=${pid}`);
			}
		}
		childProcessRegistry.unregister(pid);
	}

	// Clear progress tracker
	// Note: Can't call untrack on all because we don't track agent IDs here
	// The progress tracker should clear itself on shutdown via session_dispose
}

async function cleanupTempDirectories(): Promise<void> {
	// Clean up every temp dir created in this process. Previously this was
	// a stub that just logged; it caused /tmp/pi-crew-* dirs to accumulate
	// from killed test runs and child-pi invocations. See issue #<n>.
	try {
		const result = cleanupAllTrackedTempDirs();
		if (result.cleaned > 0) {
			console.log(`[pi-crew] Cleaned ${result.cleaned} tracked temp dirs (${result.failed} failed)`);
		}
	} catch (error) {
		logInternalError("crew-cleanup.temp", error);
	}
}

// Export for child-pi.ts to register processes
export function registerChildProcess(pid: number, runId: string, agentId: string): void {
	childProcessRegistry.register(pid, runId, agentId);
}

export function unregisterChildProcess(pid: number): void {
	childProcessRegistry.unregister(pid);
}
