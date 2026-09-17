# pi-crew docs

Documentation for the pi-crew package (multi-agent team orchestration as a Pi
extension). The root of `docs/` holds only **living** docs; dated point-in-time
material (audits, plans, fix specs, roadmaps) is archived under
[`archive/`](./archive/).

## Start here

| Doc | Contents |
|-----|----------|
| [`../README.md`](../README.md) | Package README — what pi-crew is, install, quickstart |
| [`usage.md`](./usage.md) | Config, run modes, slash commands, management actions |
| [`architecture.md`](./architecture.md) | Layers, state layout, and the run lifecycle (the former `runtime-flow.md` content lives here) |
| [`troubleshooting.md`](./troubleshooting.md) | Common errors, recovery procedures, error codes (E001–E013) |

## Reference

| Doc | Contents |
|-----|----------|
| [`actions-reference.md`](./actions-reference.md) | Every `team` tool action with parameters and examples |
| [`commands-reference.md`](./commands-reference.md) | Slash commands and `/team-api` |
| [`hooks-reference.md`](./hooks-reference.md) | The three hook/event subsystems and when to use each |
| [`role-tools.md`](./role-tools.md) | Role → tool permission matrix. **Generated** from `src/config/role-tools.ts` via `scripts/gen-role-tools-docs.mjs` — regenerate, do not hand-edit |
| [`resource-formats.md`](./resource-formats.md) | Agent/team/workflow file formats |
| [`trust-model.md`](./trust-model.md) | The authoritative trust model (single source of truth) |
| [`goals.md`](./goals.md) | Autonomous goal loops (`team action='goal'`) |
| [`dynamic-workflows.md`](./dynamic-workflows.md) | `.dwf.ts` script workflows and their trust model |
| [`live-mailbox-runtime.md`](./live-mailbox-runtime.md) | Mailbox files and the live-session runtime direction |
| [`UI-DESIGN-SYSTEM.md`](./UI-DESIGN-SYSTEM.md) | RAIL design contract for TUI surfaces (primitive source: `src/ui/rail.ts`) |
| [`publishing.md`](./publishing.md) | npm release and publish process |
| [`failure-mode-inventory.md`](./failure-mode-inventory.md) | Failure modes mapped to their handlers; gaps are declared, not hidden |
| [`TEST_MATRIX.md`](./TEST_MATRIX.md) | Behavior → proof mapping; every row needs real evidence |
| [`HARNESS.md`](./HARNESS.md) | Development-harness operating model for building pi-crew itself |
| [`HARNESS_BACKLOG.md`](./HARNESS_BACKLOG.md) | Harness capability backlog (HB-xxx items) |
| [`FEATURE_INTAKE.md`](./FEATURE_INTAKE.md) | Intake gate every implementation prompt must pass |

## Records

Historical and supporting material lives in subdirectories. These are records,
not living specs — verify against code before relying on them.

| Subdir | Contents |
|--------|----------|
| [`decisions/`](./decisions/) | Architecture decision records (ADRs); index in its README |
| [`design/`](./design/) | Design and implementation-plan docs for features in flight (subagent-v2, inline agent panel, work-item splits) |
| [`bugs/`](./bugs/) | Bug write-ups plus security audits/issues |
| [`fixes/`](./fixes/) | Per-bug fix reports: root cause, evidence, applied layers |
| [`perf/`](./perf/) | Performance baselines, bench reports, optimization plans, sprint reports |
| [`archive/`](./archive/) | Dated point-in-time docs (audits, plans, fix specs, roadmaps) kept for history |
| [`ui-samples/`](./ui-samples/) | TUI surface catalog: captures rendered by the real render functions, PNGs, and generator scripts |
| [`real-test/`](./real-test/) | Real-binary test session reports and probe logs |
| [`evidence/`](./evidence/) | Raw evidence logs captured for work items (e.g., RED demos) |
| [`migration/`](./migration/) | Migration guides (e.g., atomic-write v2) |
| [`patterns/`](./patterns/) | Distilled reusable patterns (command → agent → skill tiers) |
| [`product/`](./product/) | Product-domain docs: team-run lifecycle, team-tool API, state contracts |
| [`skills/`](./skills/) | Skill chains and effectiveness reference |
| [`stories/`](./stories/) | Story-sized work packets with status |
| [`superpowers/`](./superpowers/) | Adopted workflow plans (`plans/`) and specs (`specs/`) |
| [`templates/`](./templates/) | Templates: `decision.md`, `story.md`, `validation-report.md` |
| [`distillation/`](./distillation/) | Distillations of external skill libraries into pi-crew patterns |

## See also

- [Package README](../README.md) and [CHANGELOG](../CHANGELOG.md)
- Source cluster maps: [`src/runtime/README.md`](../src/runtime/README.md),
  [`src/state/README.md`](../src/state/README.md)
