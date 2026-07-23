# Decisions

Decision records explain why important product, architecture, or harness choices were made.

Add a decision when:
- Runtime mode changes (child-process vs live-session)
- State format changes
- New dependency introduced
- API contract changes
- Security hardening applied
- Validation requirements added/removed/changed

Current decisions derived from 9 review rounds and 13 bug fixes.

## Index

| ID | Title | Status |
|----|-------|--------|
| 0001 | Durable state as source of truth | Accepted |
| 0002 | Child-process for async runners | Accepted |
| 0003 | Depth guard for nested live-session | Accepted |
| 0004 | execFileSync over execSync | Accepted |
| 0005 | No TypeScript parameter properties | Accepted |
| 2026-07-21-broker-windows-perms | Windows broker named-pipe permissions | Accepted |
| 2026-07-21-broker-phase4-default-on | Phase 4 — do **not** flip default to true (interim) | **Superseded** by `2026-07-22-broker-phase4-gated-on` |
| 2026-07-22-broker-phase4-gated-on | Phase 4 — flip `broker.enabled` default to true | Accepted (default-on) |
