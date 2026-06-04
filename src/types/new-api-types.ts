/**
 * Type imports from pi v0.77.0
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type {
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

// Note: AgentEvent is not exported by pi-coding-agent v0.77.0
// Using AgentEndEvent and AgentStartEvent instead

// Type guards for pi-crew usage
/** @internal */
function isToolEvent(event: AgentSessionEvent): boolean {
  return event.type === "tool_execution_start" || 
         event.type === "tool_execution_update" || 
         event.type === "tool_execution_end";
}

/** @internal */
function isAgentLifecycleEvent(event: AgentSessionEvent): boolean {
  return event.type === "agent_start" || event.type === "agent_end";
}

/** @internal */
function isCompactionEvent(event: AgentSessionEvent): boolean {
  return event.type === "compaction_start" || event.type === "compaction_end";
}

/** @internal */
function isRetryEvent(event: AgentSessionEvent): boolean {
  return event.type === "auto_retry_start" || event.type === "auto_retry_end";
}

/** @internal */
function isQueueEvent(event: AgentSessionEvent): boolean {
  return event.type === "queue_update";
}
