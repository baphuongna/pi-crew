# Harness

pi-crew là một Pi extension cho multi-agent orchestration. Harness này giúp
agents và humans phối hợp phát triển pi-crew một cách reliable, inspectable,
và dễ steer.

Product là pi-crew chính nó. Harness là môi trường operating để agents hiểu
product, classify work, track decisions, và validate changes.

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

Mỗi task có 2 outputs:
1. **Product delta**: code changes, test changes, API shape, config changes
2. **Harness delta**: docs, decisions, test matrix updates, backlog items

## Source Hierarchy

Agents đọc theo thứ tự:

1. `AGENTS.md` — operating rules và important paths
2. `docs/HARNESS.md` — file này, collaboration model
3. `docs/FEATURE_INTAKE.md` — trước khi biến request thành work
4. `docs/product/` — current product contract
5. `docs/ARCHITECTURE.md` — implementation shape
6. `docs/stories/` — active và completed stories
7. `docs/TEST_MATRIX.md` — proof status
8. `docs/decisions/` — why important choices were made

## Validation Ladder

pi-crew đã có validation commands:

| Level | Command | What it proves |
|-------|---------|----------------|
| quick | `npm run typecheck` | TypeScript correctness + strip-types import |
| unit | `npm test` | 1600+ unit tests, all pass |
| lint | `npm run check` | Biome lint + format |
| CI | GitHub Actions | Cross-platform (ubuntu, windows, macos) |

Agents **must not** claim validation passes without running the actual command.

## Growth Rule

Harness grows từ friction. Khi agent:
- Bị confused về expected behavior
- Phải repeat manual reasoning
- Thiếu validation command
- Discover missing rule
- Thấy recurring failure pattern

→ Agent must improve harness directly hoặc propose trong `docs/HARNESS_BACKLOG.md`.

## Working Conventions

- Vietnamese for communication, English for code/comments
- Commit message format: `fix:`, `feat:`, `docs:` — conventional commits
- Every code change must pass `npm test` + `npm run typecheck`
- MEDIUM+ bugs found during review must be fixed before claiming done
- LOW issues documented in `docs/HARNESS_BACKLOG.md` if recurring
