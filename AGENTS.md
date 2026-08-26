# PROJECT KNOWLEDGE BASE

Last verified against `origin/main`: 2026-08-26 (legacy-tree decommission, paths, dependency graph, and shipped-state claims re-checked; keep this stamp current when editing - doc-state sync law).

## OVERVIEW

OpenOmni is a single-Owner Agent OS: one Resident delegates through durable contracts and evidence, not self-report. The repository now contains core packages and one deployable app. Target contracts live in `docs/core-model.md`, `docs/kernel-contract.md`, and `docs/machines-and-delegation.md`; `docs/implementation-status.md` is authoritative for current wiring.

## STRUCTURE

```text
openomni/
├── apps/
│   └── openomni/        # sole deployable app: Resident, gateway composition, machines, delegation, memory
├── packages/
│   ├── protocol/        # Zod schemas and cross-package contracts
│   ├── policy/          # pure policy engine and effect composition
│   ├── placement/       # pure model/tool target selection
│   ├── telemetry/       # observation channel
│   ├── ledger/          # durable stores and journal persistence
│   ├── llm/             # provider I/O, transforms, retry, token/cost accounting
│   ├── agent/           # stateless ChatAgent loop and MCP client
│   ├── ipc/             # protocol-only bidirectional IPC transport
│   ├── machines/        # attached-machine driver band
│   └── channels/        # channel drivers and perimeter gateway router
├── script/              # conformance and repository gates
├── turbo.json
└── package.json
```

## DEPENDENCY GRAPH

Read `X <- Y` as Y may depend on X.

```text
protocol <- policy, telemetry, ipc, placement
telemetry <- ledger, llm
protocol, ipc <- machines
protocol, ipc, policy, ledger <- channels
policy, placement, llm, telemetry <- agent
protocol, channels, agent, llm, ledger, telemetry, placement, machines <- apps/openomni
```

| Package | May depend on |
| --- | --- |
| `protocol` | none |
| `policy`, `placement`, `telemetry`, `ipc` | protocol |
| `ledger` | protocol, telemetry |
| `llm` | protocol, telemetry; `src/` uses protocol only |
| `machines` | protocol, ipc |
| `channels` | protocol, ipc, policy, ledger; policy/ledger are confined to `src/router/` and `src/authn/`; tests may use telemetry |
| `agent` | protocol, policy, placement, llm, telemetry; `src/` excludes telemetry |
| `apps/openomni` | protocol, channels, agent, llm, ledger, telemetry, placement, machines |

`script/check-deps.ts` is the executable contract. Product meaning is composed in `apps/openomni`; core packages remain independently consumable primitives.

## PACKAGE OWNERSHIP

| Package | Owns | Must not own |
| --- | --- | --- |
| `packages/protocol` | Schemas, wire contracts, pure folds | I/O, storage, product decisions |
| `packages/policy` | Generic policy evaluation | Product-specific authority |
| `packages/placement` | Pure target selection | Authorization or execution |
| `packages/telemetry` | Bus, scoped observation, spans | Durable or decision state |
| `packages/ledger` | Durable state and typed store surfaces | Routing and authority decisions |
| `packages/llm` | Provider behavior and model accounting | Product routing or tools |
| `packages/agent` | Stateless loop, compaction, MCP client | Durable session/product lifecycle |
| `packages/ipc` | Framing and bidirectional transport | Run semantics or authorization |
| `packages/machines` | Machine attach and cell execution driver | Enrollment policy or product judgment |
| `packages/channels` | Drivers plus perimeter routing, waits, and admission | Session content or product execution |
| `apps/openomni` | Product composition: Resident, gateway, delegation, memory, code mode, boot/shutdown | Reimplementation of package primitives |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Shared schema or event | `packages/protocol/src/` |
| Session/store behavior | `packages/ledger/src/` |
| Policy mechanism | `packages/policy/src/` |
| ChatAgent loop and compaction | `packages/agent/src/core/` |
| Channel driver or perimeter route | `packages/channels/src/` |
| Machine attach/cell execution | `packages/machines/src/` |
| Resident and app composition | `apps/openomni/src/resident.ts`, `apps/openomni/src/index.ts` |
| Gateway and channel registration | `apps/openomni/src/gateway.ts`, `apps/openomni/src/channels.ts` |
| Delegation lifecycle and transports | `apps/openomni/src/delegation/` |
| Product tools and memory | `apps/openomni/src/tools/`, `apps/openomni/src/memory/` |
| Shipped-state truth | `docs/implementation-status.md` |
| Conformance/ratchets | `script/`, `script/conformance/` |

## CONVENTIONS

- ESM, strict TypeScript, Zod-first shared contracts, namespace-style public APIs.
- One enforcement layer per invariant; durable writes fail closed.
- No deep package imports. Driver-band code stays on published protocol/IPC contracts.
- Product vocabulary avoids new `runtime`, `task`, and `envelope` nouns in protocol surfaces.
- Tests use exact state/event completion rather than sleeps and assert typed errors or messages.
- Baseline shrinkage is autonomous; baseline growth requires Owner sign-off.
- Reconcile before deletion and update implementation docs in the same PR.

## COMMANDS

```bash
bun install
bun run build
bunx turbo run check-types
bun run script/check-deps.ts
bun run script/check-import-cycles.ts
bun run lint:tools
bunx ultracite check --formatter-enabled=false .
bun run script/check-dead-exports.ts
bun test --timeout 15000

# Sole app
bun run --cwd apps/openomni dev
```

Coverage baselines are updated after coverage-producing test runs with `bun run script/check-coverage-ratchet.ts --update`. Dead-export shrinkage uses `bun run script/check-dead-exports.ts --update`.

## NOTES

- `apps/openomni` is the only deployable composition and production entry point.
- `packages/channels` is the perimeter gateway; `apps/openomni` injects delivery and observation ports.
- `packages/agent` owns no durable state. `packages/ledger` stores facts but does not decide product meaning.
- WorkItem completion authority, Stakes, and effective-authority semantics remain contract-inherited in the design docs; their removed implementation is not reported as wired.
- Connector installation/execution remains deferred; protocol and ledger primitives do not imply a live connector consumer.
- CI lives in `.github/workflows/ci.yml`; whole-repository formatting is always `bunx ultracite check --formatter-enabled=false .`.
