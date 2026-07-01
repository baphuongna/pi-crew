# Round 23 Audit Findings (Resource Cleanup)

## Skill: iterative-audit (Pattern #7: Resource Cleanup)

## Findings

### Issue 1: OTLP exporter `inFlight` push not awaited on dispose (LOW)
- **File**: `src/observability/exporters/otlp-exporter.ts:80-86, 127-130`
- **What**: When `dispose()` is called, the interval timer is cleared but the in-flight `push()` continues to run until the 10s fetch timeout. The result is lost (not awaited).
- **Severity**: LOW — bounded by 10s fetch timeout. Not a real leak, just orphaned work.
- **Fix**: Make `dispose()` async. Await the in-flight push before returning.
- **Test**: 1 new test verifies `dispose()` waits for the in-flight push.

## Patterns surveyed (all VERIFIED clean from source)

### setInterval / setTimeout cleanup
| File | Resource | Cleanup | Status |
|------|----------|---------|--------|
| `register.ts:411` | `autoRepairTimer` | cleared on line 308, 402, 1102 | OK |
| `register.ts:442` | `tempReconcileTimer` | cleared on line 308, 402, 1102 | OK |
| `result-watcher.ts:80` | `pollTimer` | cleared in `stopPolling()` | OK |
| `result-watcher.ts:96` | `restartTimer` | cleared in `scheduleRestart()` and `stop()` | OK |
| `async-notifier.ts:101` | `state.interval` | cleared in `stopAsyncRunNotifier()` | OK |
| `subagent-tools.ts:228` | `timer` | cleanup function returned to caller | OK |
| `team-tool.ts:160` | `timer` | `stop()` method clears it | OK |
| `live-conversation-overlay.ts:55` | `pollTimer` | cleared in `close()` / `dispose()` | OK |
| `loaders.ts:127` | `timer` | cleared in `dispose()` | OK |
| `theme-adapter.ts:145` | `pollTimer` | cleared in unsubscribe (line 169) | OK |
| `delivery-coordinator.ts:169` | `ttlTimer` | cleared in `dispose()` | OK |
| `parent-guard.ts:61` | `guardInterval` | cleared in `stopParentGuard()` | OK |
| `scheduler.ts:88` | `t` (timer) | cleared on job removal | OK |
| `otlp-exporter.ts:80` | `timer` | cleared in `dispose()` (Round 23: also awaits inFlight) | OK |
| `team-runner.ts:67` | `interval` | local scope (per-run) | OK |
| `metric-sink.ts:68` | `timer` | cleared in `dispose()` (also closes fd) | OK |
| `handoff-manager.ts:203` | `cleanupTimer` | cleared in `dispose()` (also clears Maps) | OK |
| `live-session-runtime.ts:487` | `controlTimer` | cleared in `finally` block | OK |
| `budget-tracker.ts:231` | `abortInterval` | cleared on abort/exhausted | OK |
| `background-runner.ts:52, 74` | `interval` | local scope (process entry point) | OK |

### process.on() signal handler registration
| File | Handlers | Guard | Status |
|------|----------|-------|--------|
| `crew-cleanup.ts:79, 84` | SIGTERM, SIGHUP | `signalHandlersRegistered` flag (Round 16) | OK |
| `background-runner.ts:107, 148, 175, 181, 194, 198` | many | process entry point (registered once per process) | OK |
| `event-log.ts:490-492` | exit, SIGTERM, SIGINT | module-level (ESM caches) | OK |
| `atomic-write.ts:265-267` | exit, SIGTERM, SIGINT | module-level (ESM caches) | OK |

### File watchers
| File | Watcher | Cleanup | Status |
|------|---------|---------|--------|
| `register.ts:682, 686` | `crewWatcher`, `userCrewWatcher` | `closeWatcher()` in cleanup paths | OK |
| `result-watcher.ts` | `watcher` | `closeWatcher()` in `stop()` | OK |

### Event listeners
| File | Listener | Cleanup | Status |
|------|----------|---------|--------|
| `event-bus.ts:on()` | deduped via Set | cleanup function returned | OK |
| `run-event-bus.ts:onAny()` etc. | deduped via Sets | cleanup function returned | OK |
| `phase-tracker.ts:dispose()` | EventEmitter | `removeAllListeners()` | OK |
| `team-tool.ts:72` | signal listener | `removeEventListener` in `finally` | OK |

### AbortController
| File | Controller | Cleanup | Status |
|------|-----------|---------|--------|
| `team-tool.ts:68` | per-tool | aborted via signal listener, removed in `finally` | OK |
| `subagent-manager.ts:290` | per-run | cleaned in `cleanupRunSignal()` | OK |
| `cancellation-token.ts:17` | per-token | aborted via `#controller.abort()` | OK |
| `otlp-exporter.ts:106` | per-push | cleared in `finally` block | OK (also: dispose awaits inFlight) |

## Plan (1 phase)

### Phase 1: OTLP exporter `dispose()` awaits inFlight
- `src/observability/exporters/otlp-exporter.ts:127-130` — make `dispose()` async, await `this.inFlight`
- 1 new test in `test/unit/otlp-exporter.test.ts`

## Expected impact
- 1 new test, 0 regressions
- Total: 1 LOW severity improvement
- No public API change (callers that don't await still get synchronous timer clear)
- Pattern: matches the existing `await` patterns elsewhere in the codebase
