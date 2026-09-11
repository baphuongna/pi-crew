---
name: mailbox-interactive
description: >
  Interactive waiting-task and mailbox workflow.
  When NOT to use: fire-and-forget background tasks; non-interactive worker contact.

origin: pi-crew
triggers:
  - "respond to worker"
  - "nudge agent"
  - "mailbox message"
  - "supervisor contact"
  - "waiting task"
---
# mailbox-interactive

Use this skill for live coordination between leader and workers. Mailbox provides an asynchronous message protocol for steer, follow-up, respond, and nudge operations.

## Mailbox Architecture

```
Worker (waiting) ← mailbox inbox ← Leader (respond)
Worker (running) ← mailbox follow-ups ← Leader (followUp)
Leader → Worker: steer, followUp, nudge (non-blocking)
Worker → Leader: supervisor contact (blocking decision)
```

### Mailbox file structure

Each run has a mailbox directory at `.crew/state/runs/<runId>/mailbox/`:
- `inbox.jsonl` — incoming messages (to worker)
- `outbox.jsonl` — sent messages (from worker)
- `steering.jsonl` — steer messages specifically

### Message structure

```typescript
interface MailboxMessage {
  id: string;
  direction: "inbox" | "outbox";
  from: string;           // taskId or "leader"
  to: string;             // taskId or "leader"
  body: string;           // message text
  status: "pending" | "delivered" | "acknowledged" | "rejected";
  priority: "low" | "normal" | "high";
  sentAt: string;         // ISO timestamp
  deliveredAt?: string;
  data?: Record<string, unknown>;  // source, correlation, etc.
}
```

## Core Operations

### 1. respond — Leader responds to waiting worker

```typescript
// Respond writes to inbox and transitions task back to running
async function respond(runId: string, taskId: string, body: string, priority = "normal") {
  // 1. Write inbox message
  const message = appendInboxMessage(manifest, { taskId, body, priority });

  // 2. Re-read state inside lock
  const { tasks } = loadRunManifestById(cwd, runId);
  const task = tasks.find(t => t.id === taskId);

  // 3. Verify task is waiting
  if (task.status !== "waiting") {
    throw new Error(`Cannot respond to non-waiting task: ${task.status}`);
  }

  // 4. Transition task back to running
  const updated = { ...task, status: "running", waitingSince: undefined };
  saveRunTasks(manifest, [updated]);

  // 5. Emit event
  appendEvent(eventsPath, { type: "task.responded", taskId, message: body });

  return message;
}
```

### 2. steer — Live agent steering (non-blocking)

```typescript
// Steer sends a message to a running live agent
async function steerLiveAgent(agentId: string, message: string) {
  const handle = getLiveAgent(agentId);
  if (!handle) throw new Error(`Live agent '${agentId}' not found`);

  // If session.steer is available, deliver immediately
  if (typeof handle.session.steer === "function") {
    await handle.session.steer(message);
    handle.updatedAt = new Date().toISOString();
    return handle;
  }

  // Otherwise, queue for delivery when session becomes ready
  handle.pendingSteers.push(message);
  return handle;
}
```

### 3. followUp — Non-blocking follow-up to running agent

```typescript
async function followUpLiveAgent(agentId: string, prompt: string) {
  const handle = getLiveAgent(agentId);
  if (!handle) throw new Error(`Live agent '${agentId}' not found`);

  if (typeof handle.session.prompt === "function") {
    await handle.session.prompt(prompt, { source: "api", expandPromptTemplates: false });
    handle.updatedAt = new Date().toISOString();
    return handle;
  }

  handle.pendingFollowUps.push(prompt);
  return handle;
}
```

### 4. nudge — Ask agent to report status

```typescript
function nudgeAgent(manifest: TeamRunManifest, agentId: string, message?: string) {
  const agent = readCrewAgents(manifest).find(a => a.id === agentId || a.taskId === agentId);
  if (!agent) throw new Error(`Agent '${agentId}' not found`);

  const text = message ?? "Please report your current status, blocker, or smallest next step.";

  // Write to mailbox
  const mailboxMessage = appendSteeringMessage(manifest, {
    taskId: agent.taskId,
    body: text,
    priority: "normal",
    data: { source: "nudge-agent" }
  });

  // Emit event
  appendEvent(manifest.eventsPath, {
    type: "agent.nudged",
    runId: manifest.runId,
    taskId: agent.taskId,
    message: text,
    data: { agentId: agent.id, mailboxMessageId: mailboxMessage.id }
  });

  return mailboxMessage;
}
```

## Supervisor Contact

Workers can contact the leader for blocking decisions:

```typescript
// Worker stdout contains supervisor contact pattern:
// @supervisor need_confirmation: <decision-type>
// @supervisor need_input: <input-prompt>

// Parsed by parseSupervisorContactFromLine() in supervisor-contact.ts
function parseSupervisorContact(line: string): SupervisorContact | null {
  const match = line.match(/@supervisor\s+(\w+):\s*(.*)/);
  if (!match) return null;
  return { type: match[1], prompt: match[2] };
}

// Recorded as events and surfaced in UI
appendEvent(eventsPath, {
  type: "supervisor.contact",
  runId: manifest.runId,
  taskId: task.id,
  message: contact.prompt,
  data: { contactType: contact.type }
});
```

**Contact types:**
- `need_confirmation` — worker needs explicit approval
- `need_input` — worker needs a text response
- `need_selection` — worker needs to choose from options

## Queue Depth and Backpressure

Mailbox queues can grow large with pending messages:

```typescript
const MAX_PENDING_STEERS = 50;
const MAX_PENDING_FOLLOWUPS = 50;

// When queue exceeds limit, oldest messages are dropped
if (handle.pendingSteers.length >= MAX_PENDING_STEERS) {
  handle.pendingSteers.shift(); // drop oldest
}
```

**Backpressure signals:**
- If `pendingSteers.length > 20`, warn in UI
- If `pendingFollowUps.length > 20`, warn in UI

## Corrupt JSONL Handling

Mailbox JSONL files can become corrupt on crash. Handle gracefully:

```typescript
function readMailboxMessages(path: string): MailboxMessage[] {
  if (!fs.existsSync(path)) return [];

  const lines = fs.readFileSync(path, "utf-8").split("\n");
  const messages: MailboxMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as MailboxMessage);
    } catch {
      // Skip corrupt lines: partial write from crash
      // Try to recover by reading up to the last valid JSON object
      continue;
    }
  }

  return messages;
}
```

## Timeout Patterns

### Responding with timeout

```typescript
async function respondWithTimeout(
  runId: string,
  taskId: string,
  body: string,
  timeoutMs = 30_000
): Promise<MailboxMessage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const message = await respond(runId, taskId, body);
    clearTimeout(timeout);
    return message;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      throw new Error(`Respond timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}
```

### Non-blocking follow-up (no wait)

```typescript
// Fire-and-forget: send message and return immediately
function followUpAsync(agentId: string, prompt: string): void {
  const handle = getLiveAgent(agentId);
  if (!handle) return;

  if (typeof handle.session.prompt === "function") {
    // Non-awaited: delivery happens in background
    void handle.session.prompt(prompt, { source: "api", expandPromptTemplates: false })
      .catch(() => { /* log if needed */ });
  } else {
    handle.pendingFollowUps.push(prompt);
  }
}
```

## Run Ownership Enforcement

Foreign sessions cannot mutate a run's mailbox:

```typescript
// In respond.ts / cancel.ts
function verifyRunOwnership(manifest: TeamRunManifest, sessionId: string, force = false) {
  if (!force && manifest.ownerSessionId && manifest.ownerSessionId !== sessionId) {
    throw new Error(
      `Run ${manifest.runId} is owned by session ${manifest.ownerSessionId}. ` +
      `Cannot mutate from session ${sessionId}. Use force=true to override.`
    );
  }
}
```

## Enforcement — Mailbox Interactive Gate

**Before responding to or mutating mailbox state, verify:**

- [ ] Target task status is "waiting" (respond only works on waiting tasks)
- [ ] ownerSessionId matches current session (ownership verified)
- [ ] Run status is not terminal (do not respond to completed/failed/cancelled)
- [ ] Corrupt JSONL handled gracefully (skip malformed lines)
- [ ] Backpressure respected (queue depth below MAX_PENDING limits)

If ANY answer is NO → Stop. Verify mailbox state before mutating.

## Anti-patterns

- **Resuming non-waiting tasks**: `respond` only works on `waiting` tasks. Resuming `running` tasks corrupts state.
- **Injecting mailbox messages into foreign runs**: Always verify `ownerSessionId` before mutating.
- **Treating every progress update as blocking**: Use `followUp` (non-blocking) instead of `respond` for status updates.
- **Reading large mailbox files in hot paths**: Cache mailbox counts; don't read JSONL on every render tick.
- **Not handling corrupt JSONL**: Skip malformed lines; don't fail the whole read.
- **Losing pending messages on session switch**: Pending steers/followups are stored in-memory in the handle. They survive session fork but not session death.

## Source patterns

- `src/state/mailbox.ts` — appendInboxMessage, appendSteeringMessage, readMailboxMessages
- `src/extension/team-tool/respond.ts` — respond tool handler, ownership verification
- `src/extension/team-tool/cancel.ts` — cancel with mailbox cleanup
- `src/extension/team-tool/api.ts` — steer-agent, follow-up-agent, nudge-agent
- `src/runtime/live-agent-manager.ts` — pendingSteers, pendingFollowUps, steerLiveAgent, followUpLiveAgent
- `src/runtime/supervisor-contact.ts` — parseSupervisorContactFromLine, recordSupervisorContact
- `src/ui/overlays/mailbox-detail-overlay.ts` — mailbox UI

## Verification

```bash
cd pi-crew

# Verify mailbox structure
ls .crew/state/runs/<runId>/mailbox/ 2>/dev/null || echo "No mailbox yet"

# Test respond tool
node --experimental-strip-types --test test/unit/respond-tool.test.ts

# Test mailbox overlay
node --experimental-strip-types --test test/unit/mailbox-detail-overlay.test.ts

# TypeScript
npx tsc --noEmit

# All tests
npm test
```