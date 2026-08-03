# Harness

pi-crew is a Pi extension for multi-agent orchestration. This harness helps
agents and humans collaborate on developing pi-crew in a reliable, inspectable,
and easy-to-steer way.

The product is pi-crew itself. The harness is the operating environment that
helps agents understand the product, classify work, track decisions, and
validate changes.

## Mental Model

```text
Human intent (issue, prompt, request)
         │
         ▼
  Feature intake
  (classify → risk lane)
         │
         ▼
  Story packet or direct patch
         │
         ▼
  Agent work loop
  (explore → plan → execute → verify)
         │
         ▼
  Product delta (code, tests, docs)
         │
         ▼
  Validation proof (tests, typecheck, CI)
         │
         ▼
  Harness delta (decisions, test matrix, backlog)
         │
         ▼
  Next intent
```

Each task has 2 outputs:
1. **Product delta**: code changes, test changes, API shape, config changes
2. **Harness delta**: docs, decisions, test matrix updates, backlog items

## Source Hierarchy

Agents read in this order:

1. `AGENTS.md` — operating rules and important paths
2. `docs/HARNESS.md` — this file, the collaboration model
3. `docs/FEATURE_INTAKE.md` — before turning a request into work
4. `docs/product/` — current product contract
5. `docs/architecture.md` — implementation shape
6. `docs/stories/` — active and completed stories
7. `docs/TEST_MATRIX.md` — proof status
8. `docs/decisions/` — why important choices were made

## Validation Ladder

pi-crew already has validation commands:

| Level | Command | What it proves |
|-------|---------|----------------|
| quick | `npm run typecheck` | TypeScript correctness + strip-types import |
| unit | `npm test` | 1600+ unit tests, all pass |
| lint | `npm run check` | Biome lint + format |
| CI | GitHub Actions | Cross-platform (ubuntu, windows, macos) |

Agents **must not** claim validation passes without running the actual command.

## Growth Rule

The harness grows from friction. When an agent:
- Gets confused about expected behavior
- Has to repeat manual reasoning
- Lacks a validation command
- Discovers a missing rule
- Sees a recurring failure pattern

→ The agent must improve the harness directly or propose changes in `docs/HARNESS_BACKLOG.md`.

## Working Conventions

- Vietnamese for communication, English for code/comments
- Commit message format: `fix:`, `feat:`, `docs:` — conventional commits
- Every code change must pass `npm test` + `npm run typecheck`
- MEDIUM+ bugs found during review must be fixed before claiming done
- LOW issues documented in `docs/HARNESS_BACKLOG.md` if recurring
