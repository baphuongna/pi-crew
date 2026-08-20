---
name: requirements-to-task-packet
description: "Use when a goal, issue, roadmap item, review finding, or user request must become actionable worker tasks."
origin: pi-crew
triggers:
  - "convert requirements"
  - "create task packet"
  - "decompose goal"
  - "write task"
  - "spec to implementation"

---
# requirements-to-task-packet

Core principle: workers need explicit task packets, not inherited ambiguity. Ask only when ambiguity changes architecture, safety, public behavior, or data loss risk; otherwise record assumptions.

Distilled from detailed reads of clarification, spec-to-implementation, subagent-driven development, and skill-authoring patterns.

## Clarify or Proceed

Ask before implementation when ambiguity affects:

- security boundary, permissions, ownership, or secret handling;
- destructive operations, migrations, publishing, or public API behavior;
- architecture or data model;
- acceptance criteria or rollback expectations.

Proceed with explicit assumptions when ambiguity is local, reversible, and testable.

## Task Packet Template

```text
Objective:
Scope/paths:
Allowed edits:
Forbidden edits/non-goals:
Inputs/dependencies:
Relevant context/artifacts:
Assumptions:
Risks:
Acceptance criteria:
Verification commands:
Expected output artifacts:
Escalation conditions:
```

## Subagent Context Rules

- Give each worker fresh, curated context; do not rely on hidden parent history.
- Include exact upstream artifact paths and summaries when needed.
- Keep implementation tasks independent or explicitly sequenced.
- Require workers to report one of: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED.
- For BLOCKED/NEEDS_CONTEXT, change context/model/scope before retrying.

## Acceptance Criteria

Use observable checks:

- command output, state transition, UI/status text, artifact contents;
- regression tests or named test files;
- security properties such as containment/ownership/no secrets;
- compatibility requirements such as Windows paths or Pi CLI flags;
- rollback notes.

## Spec Pairs (pi-crew v0.10.1+, ADR-6)

When the target runs pi-crew, author the **SpecRecord + TaskPacket pair** instead of prose-only acceptance:

1. **SpecRecord** (workspace `state/specs/<id>.json`): `requirements[]` with
   `must|should|could` priority + stable ids; `acceptance[]` entries each tied to
   a `requirementId`. Machine-checkable acceptances carry `command`,
   `expectedDigest` (sha-256 hex of stdout) or `expectedExitCode`, and
   `idempotent: true` — only idempotent commands are ever re-run.
2. **PROVENANCE — critical**: specs you (an agent/skill path) write are persisted
   `generated` and NEVER re-executed by the orchestrator. `manual`+`trusted`
   (the only specs strict mode re-runs) are minted exclusively by USER-facing
   import actions — a worker cannot author a command the root re-executes.
3. **Wire the workflow**: add `specRefs: [<spec ids>]` to steps held to the spec;
   `specStrict: true` in frontmatter opts the whole workflow into strict mode
   (requires a `verifier` role step — the run rejects at start otherwise).
4. **Executor footer contract**: workers must END results with

   ```text
   SPEC-EVIDENCE:
   <acceptanceId>: <one-line evidence>
   ```

   Non-strict = mechanical coverage only (`unverified` badge on gaps, never
   blocks). Strict = coverage AND machine-check; failures fail the run.

## Enforcement — Requirements to Task Packet Gate

**Before dispatching workers, verify task packet has:**

- [ ] Objective clearly stated (goal in one sentence)
- [ ] Scope and paths defined (what is/isn't in scope)
- [ ] Allowed vs forbidden edits specified
- [ ] Inputs/dependencies and expected output artifacts listed
- [ ] Acceptance criteria are observable (command output, state transition, test)
- [ ] Verification commands provided
- [ ] Escalation conditions defined

If ANY answer is NO → Stop. Complete task packet before dispatching.

## Anti-patterns

- Broad "fix everything" prompts.
- Buried assumptions.
- Expanding scope because context remains.
- Treating tests as proof when the requirement was never asserted.
