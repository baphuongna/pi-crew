import { appendEvent } from "../state/event-log.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { runEventBus } from "../ui/run-event-bus.ts";
import type { HookContext, HookDefinition, HookExecutionReport, HookName, HookResult } from "./types.ts";

const registry = new Map<HookName, HookDefinition[]>();

// Track hook IDs registered by pi-crew for scope-aware cleanup
const _piCrewHookIds = new Set<number>();
let _nextHookId = 1;

// SECURITY: Hooks are currently global (registered once, applied to all workspaces).
// For multi-workspace environments, consider filtering hooks by workspace scope:
//   const workspaceHooks = getHooks(name).filter(h => !h.workspaceId || h.workspaceId === ctx.workspaceId);
// This prevents globally-registered hooks from operating on runs they weren't designed for.

export function registerHook(definition: HookDefinition): number {
	const hookId = _nextHookId++;
	_piCrewHookIds.add(hookId);
	const hooks = registry.get(definition.name) ?? [];
	hooks.push({ ...definition, _hookId: hookId });
	registry.set(definition.name, hooks);
	return hookId;
}

export function clearHooks(): void {
	registry.clear();
	_piCrewHookIds.clear();
	_nextHookId = 1;
}

// Scope-aware hook clearing: only removes hooks registered by pi-crew
export function clearHooksScoped(): void {
	for (const [name, hooks] of registry) {
		const remaining = hooks.filter((h) => !("_hookId" in h && _piCrewHookIds.has((h as { _hookId?: number })._hookId ?? -1)));
		if (remaining.length === 0) {
			registry.delete(name);
		} else {
			registry.set(name, remaining);
		}
	}
	_piCrewHookIds.clear();
	_nextHookId = 1;
}

export function getHooks(name: HookName): HookDefinition[] {
	return registry.get(name) ?? [];
}

export async function executeHook(name: HookName, ctx: HookContext): Promise<HookExecutionReport> {
	const hooks = getHooks(name);
	if (hooks.length === 0) return { hookName: name, outcome: "allow", durationMs: 0 };
	// SECURITY: Filter hooks by workspace scope.
	//   - Global hooks (no workspaceId) match all contexts UNLESS ctx explicitly
	//     opts out via `includeGlobalHooks: false`. This is the documented
	//     behavior: "Hooks without workspaceId match ALL workspaces".
	//   - Scoped hooks (workspaceId set) require an exact match with ctx.workspaceId.
	//   - If ctx has no workspaceId, scoped hooks are excluded (they can't match).
	//   - `includeGlobalHooks: true` on ctx forces inclusion of global hooks even
	//     when ctx has a workspaceId.
	const scopedHooks = hooks.filter((h) => {
		// Scoped hook: must match ctx.workspaceId exactly
		if (h.workspaceId !== undefined) {
			return h.workspaceId === ctx.workspaceId;
		}
		// Global hook (no workspaceId): include unless ctx explicitly excludes
		return ctx.includeGlobalHooks !== false;
	});
	if (scopedHooks.length === 0) return { hookName: name, outcome: "allow", durationMs: 0 };
	const POLLUTED_KEYS = new Set(
		[
			"__proto__",
			"constructor",
			"prototype",
			"hasOwnProperty",
			"toString",
			"valueOf",
			"isPrototypeOf",
			"propertyIsEnumerable",
			"__defineGetter__",
			"__defineSetter__",
			"__lookupGetter__",
			"__lookupSetter__",
		].map((k) => k.toLowerCase().normalize("NFKC")),
	);
	function sanitizeMergeData(data: Record<string, unknown>): Record<string, unknown> {
		const clean: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			if (!POLLUTED_KEYS.has(k.toLowerCase().normalize("NFKC"))) {
				if (v !== null && typeof v === "object") {
					if (Array.isArray(v)) {
						// Sanitize array elements that are objects
						clean[k] = v.map((item) =>
							item !== null && typeof item === "object" && !Array.isArray(item)
								? sanitizeMergeData(item as Record<string, unknown>)
								: item,
						);
					} else {
						clean[k] = sanitizeMergeData(v as Record<string, unknown>);
					}
				} else {
					clean[k] = v;
				}
			}
		}
		return clean;
	}
	// Sanitize ctx by stripping dangerous property names before passing to handlers.
	// Hook authors must NOT set these keys directly on ctx: [...POLLUTED_KEYS]
	// This sanitization runs at the start of executeHook to prevent prototype pollution attacks.
	function sanitizeContext(ctx: HookContext): HookContext {
		for (const key of Object.keys(ctx)) {
			if (POLLUTED_KEYS.has(key.toLowerCase().normalize("NFKC"))) {
				delete ctx[key];
			}
		}
		return ctx;
	}
	function sanitizeErrorMessage(message: string): string {
		// Remove file paths, environment variable references, and other potentially sensitive data
		return message
			.replace(/\/[^:\s]+/g, "[path]")
			.replace(/\b[A-Z_0-9]+\s*=/g, "[env]")
			.replace(/\b\d+\.\d+\.\d+\.\d+\b/g, "[ip]");
	}
	const start = Date.now();
	const diagnostics: string[] = [];
	let capturedModifications: Record<string, unknown> | undefined;
	for (const hook of scopedHooks) {
		try {
			const result: HookResult = await hook.handler(sanitizeContext(ctx));
			// SECURITY: Sanitize any direct mutations the handler may have made to ctx.
			// This prevents hooks from injecting dangerous properties via direct ctx assignment.
			sanitizeContext(ctx);
			if (hook.mode === "blocking" && result.outcome === "block") {
				return {
					hookName: name,
					outcome: "block",
					durationMs: Date.now() - start,
					reason: result.reason,
				};
			}
			if (result.outcome === "modify" && result.data) {
				Object.assign(ctx, sanitizeMergeData(result.data));
				capturedModifications = { ...result.data };
			}
		} catch (error) {
			const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
			if (hook.mode === "blocking") {
				return {
					hookName: name,
					outcome: "block",
					durationMs: Date.now() - start,
					reason: `Hook error: ${message}`,
				};
			}
			// Non-blocking hook errors are accumulated as diagnostics; continue to next hook
			diagnostics.push(message);
		}
	}
	if (diagnostics.length > 0) {
		return {
			hookName: name,
			outcome: "diagnostic",
			durationMs: Date.now() - start,
			reason: diagnostics.join("; "),
			modifiedData: capturedModifications,
		};
	}
	return {
		hookName: name,
		outcome: "allow",
		durationMs: Date.now() - start,
		modifiedData: capturedModifications,
	};
}

export function appendHookEvent(manifest: TeamRunManifest, report: HookExecutionReport): void {
	appendEvent(manifest.eventsPath, {
		type: "hook.executed",
		runId: manifest.runId,
		message: `Hook ${report.hookName} completed with outcome=${report.outcome}${report.reason ? `: ${report.reason}` : ""}`,
		data: {
			hookName: report.hookName,
			outcome: report.outcome,
			durationMs: report.durationMs,
			reason: report.reason,
		},
	});
	runEventBus.emit({
		type: "effectiveness_changed",
		runId: manifest.runId,
		data: { hookName: report.hookName, outcome: report.outcome },
	});
}
