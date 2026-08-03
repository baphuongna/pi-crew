# docs/ — documentation index

pi-crew's documentation. After the v0.9.x reorg the **living/active** docs
stay at the root of this directory; historical/retired docs live in
[`archive/`](./archive/). Cluster maps for the code live in
[`src/runtime/README.md`](../src/runtime/README.md) and
[`src/state/README.md`](../src/state/README.md).

## Living docs (root)

| Doc | Contents |
|-----|----------|
| [`usage.md`](./usage.md) | Usage patterns + config examples |
| [`commands-reference.md`](./commands-reference.md) | Slash commands + `/team-api` |
| [`actions-reference.md`](./actions-reference.md) | Full tool actions + examples |
| [`resource-formats.md`](./resource-formats.md) | Agent/team/workflow file formats |
| [`architecture.md`](./architecture.md) | Internal architecture + run flow |
| [`runtime-flow.md`](./runtime-flow.md) | Runtime execution details |
| [`dynamic-workflows.md`](./dynamic-workflows.md) | `.dwf.ts` script runtime + trust model |
| [`goals.md`](./goals.md) | Autonomous goal loops (`team action='goal'`) |
| [`live-mailbox-runtime.md`](./live-mailbox-runtime.md) | Mailbox + live-session runtime |
| [`troubleshooting.md`](./troubleshooting.md) | Common errors, recovery, error-code reference (E001–E012) |
| [`publishing.md`](./publishing.md) | Release & publish process |
| [`migration-v0.4-v0.5.md`](./migration-v0.4-v0.5.md) | Migration guide: v0.4 → v0.5 |
| [`HARNESS.md`](./HARNESS.md) | Agent-testing harness operating model |
| [`HARNESS_BACKLOG.md`](./HARNESS_BACKLOG.md) | Harness capability backlog |
| [`FEATURE_INTAKE.md`](./FEATURE_INTAKE.md) | Feature-intake gate for implementation prompts |
| [`TEST_MATRIX.md`](./TEST_MATRIX.md) | Behavior→proof mapping (every row needs real evidence) |
| [`TEST-STRATEGY-2026-07-30.md`](./TEST-STRATEGY-2026-07-30.md) | v0.9.56 test strategy (coverage × test type) |
| [`COVERAGE-ASSESSMENT-2026-08-01.md`](./COVERAGE-ASSESSMENT-2026-08-01.md) | v0.9.56 coverage assessment + source-reorg history |
| [`AUDIT-2026-07-30.md`](./AUDIT-2026-07-30.md) | v0.9.56 comprehensive audit (6 parallel streams) |
| [`REMEDIATION-PLAN-2026-07-30.md`](./REMEDIATION-PLAN-2026-07-30.md) | v0.9.56 remediation plan |

## Subdirectories

| Subdir | Contents |
|--------|----------|
| [`archive/`](./archive/) | Historical/retired docs (flat; ~59 files — audits, research, superseded plans) |
| [`bugs/`](./bugs/) | Bug write-ups + security audit/issues |
| [`decisions/`](./decisions/) | Architecture decision records (ADRs, numbered) |
| [`distillation/`](./distillation/) | Distilled pattern/skill references |
| [`fixes/`](./fixes/) | Bug-fix reports |
| [`migration/`](./migration/) | Migration guides (e.g. atomic-write v2) |
| [`patterns/`](./patterns/) | Reusable pattern references |
| [`perf/`](./perf/) | Performance audits, sprint reports, optimization plans |
| [`product/`](./product/) | Product-domain docs |
| [`skills/`](./skills/) | pi-crew skills reference |
| [`stories/`](./stories/) | Story-sized work packets |
| [`superpowers/`](./superpowers/) | Fallow-patterns adoption plans |
| [`templates/`](./templates/) | Decision / story / validation-report templates |

See also the top-level [README.md](../README.md) and the source cluster maps
([`src/runtime/README.md`](../src/runtime/README.md),
[`src/state/README.md`](../src/state/README.md)).
