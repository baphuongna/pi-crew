# pi-crew Migration Guide: v0.4 → v0.5

**Author:** pi-crew team  
**Date:** 2026-06-01  
**Version:** 0.5.5 *(covers v0.4→v0.5 migration; later v0.5.x versions are drop-in replacements)*

---

## Overview

This guide covers breaking changes and new features introduced in v0.5.x.

---

## v0.5.5 Highlights (June 2026)

v0.5.5 closes 13 rounds of code review. The user-facing changes are:

- **Linear-time secret redaction** at all event/mailbox/artifact boundaries.
- **v8.deserialize hardened** with `BINARY_MAGIC` headers — old binaries are auto-discarded.
- **Adaptive implementation workflow** now has a single `assess` step; the planner picks the smallest effective crew.
- **Async-notifier debounce** of 30 s — completion notifications can be delayed by up to 30 s.
- **Mailbox delivery state capped at 10000 messages** — older entries are pruned FIFO.
- **Anchors cap at 50 with 100 handoffs each** — older handoffs are pruned FIFO.

No new public API is required for any of these changes. If you pinned a `BINARY_MAGIC`-guarded binary from a previous session, delete `~/.pi/agent/pi-crew/.cache/active-run-index.bin` once.

## v0.5.4 → v0.5.5 Migration

No breaking changes. Drop-in replacement.

## Breaking Changes

### 1. Environment Variable Allowlist (Security)

**Before (v0.4):**
```typescript
// Child Pi workers received ALL matching secrets
"*_API_KEY",
"*_TOKEN", 
"*_SECRET",
```

**After (v0.5):**
```typescript
// Only explicit provider keys
"ANTHROPIC_API_KEY",
"OPENAI_API_KEY",
"GOOGLE_API_KEY",
// ...
```

**Action Required:** If your workflows rely on custom environment variables with `*_API_KEY` patterns, you must now explicitly list them:
```json
{
  "piCrew": {
    "runtime": {
      "envAllowlist": ["MY_CUSTOM_API_KEY", "MY_OTHER_KEY"]
    }
  }
}
```

---

### 2. Mock Mode Requires Dual Environment Variables

**Before (v0.4):**
```bash
PI_TEAMS_MOCK_CHILD_PI=success  # Works silently
```

**After (v0.5):**
```bash
PI_TEAMS_MOCK_CHILD_PI=success
PI_CREW_ALLOW_MOCK=1  # Required for security
```

**Action Required:** Update CI/CD and test scripts that use mock mode.

---

### 3. Skill Frontmatter Format

**Before (v0.4):**
```yaml
---
name: my-skill
description: "My skill description"
---
```

**After (v0.5):**
```yaml
---
name: my-skill
description: "My skill description"
triggers:
  - "trigger phrase 1"
  - "trigger phrase 2"
---
```

**Action Required:** Run `node scripts/check-all-skills.ts` to identify skills needing `triggers` field.

---

## New Features in v0.5

### 1. Enhanced Security

- **Secure env allowlist**: Only explicit API keys passed to child processes
- **Mock mode protection**: Requires `PI_CREW_ALLOW_MOCK=1` alongside `PI_TEAMS_MOCK_CHILD_PI`
- **Worktree hook hardening**: Safer execution on Windows

### 2. Improved Reliability

- **Terminal event durability**: Critical events (task.completed, task.failed) now bypass event buffering
- **Race condition fixes**: Foreground interrupt requests are now properly serialized
- **File descriptor cleanup**: Background runner properly closes log file descriptors

### 3. Better Observability

- **Reduced cache TTL**: Manifest cache now expires in 30s instead of 5min for faster state updates
- **Decision ledger integrity**: Ledger entries are preserved during promote/decay operations

### 4. Skill System

- **Standardized triggers**: All 35 built-in skills now have explicit trigger phrases
- **Enforcement gates**: Skills include checklist-based enforcement sections
- **Anti-patterns**: Most skills include anti-pattern documentation

---

## Configuration Changes

### New Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `limits.heartbeatStaleMs` | number | 30000 | Stale heartbeat threshold |
| `runtime.effectivenessGuard` | string | "off" | Effectiveness guard level |
| `runtime.completionMutationGuard` | string | "off" | Mutation guard level |

### Deprecated Config Keys

None in v0.5.

---

## Workflow Migration

### Updating Custom Agents

1. Ensure agent files have `triggers` in frontmatter:
```yaml
---
name: my-agent
triggers:
  - "my trigger"
---
```

2. Verify agent is discovered:
```bash
team action=list agent=my-agent
```

### Updating Custom Teams

1. Validate team config:
```bash
team action=validate resource=team name=my-team
```

2. Check for breaking changes in role/task definitions.

---

## Testing Checklist

After upgrading to v0.5:

- [ ] Run `team action=doctor` to verify configuration
- [ ] Run `node scripts/check-all-skills.ts` to verify skills
- [ ] Test mock mode with both env vars set
- [ ] Verify environment variables are properly filtered in child processes
- [ ] Test foreground interrupt (cancel) behavior
- [ ] Verify terminal events are properly logged

---

## Rollback

If issues occur after upgrade:

```bash
# Revert to v0.4.x
pi install npm:pi-crew@0.4.x
```

---

## Support

- **Issues**: https://github.com/baphuongna/pi-crew/issues
- **Documentation**: [docs/](docs/)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)
