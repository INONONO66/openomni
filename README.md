# OpenOmni

**An agent operating system built around a single permanent Resident, where failures make the system structurally stronger.**

OpenOmni is a personal AI workforce built around one Resident. That Resident is always on — it understands the user's intent and context, handles what it can directly, and delegates everything else to Workers. Workers can be internal agents, external AI services, or people. From the system's perspective, they're all the same thing.

What makes OpenOmni different from a typical agent framework is where the improvement logic lives. The Resident doesn't reflect on itself or rewrite its own behavior. Instead, a separate low-privilege layer called the System Governor watches execution patterns, identifies recurring failures, and adjusts Policy and Skills to prevent them from happening again. The Resident stays focused on the user. The system gets better underneath it.

This separation isn't just an architectural preference. It's the only way to build something you can trust over time.

## What is OpenOmni?

OpenOmni is a system for building an AI workforce one person can rely on for the long term.

Most agent projects focus on making a single agent more capable. OpenOmni focuses on something different: creating the conditions where one Resident can work stably and reliably over months and years. The user has one relationship, with one Resident. That Resident decides what to handle directly and what to hand off. Workers — whether internal tools, other AI agents, or humans — are all treated the same way. They receive work, return results, and don't create new top-level work on their own.

The goal isn't a smarter agent. It's a trustworthy one.

## The Core Model

### The Single Resident

There's exactly one entity the user talks to. The Resident owns the relationship, understands accumulated context, and is responsible for every response the user sees. It doesn't expose internal complexity — Workers, failures, retries, and intermediate reasoning all stay out of the user-facing session.

### Workers as Applications

Everything except the Resident is a Worker. Internal subagents, external AI APIs, human collaborators — they're all the same abstraction. Workers receive a scoped task, execute it in isolation, and return a result. They don't have standing authority to create new inbound work.

### The System Governor

The System Governor is a separate, low-privilege layer that observes the system through the event bus. It reads execution records and failure patterns, then adjusts Policy and Skills to address root causes structurally. The Resident never has to think about self-improvement. The Governor handles it.

## How Improvement Happens

Recurring mistakes get encoded as Policy constraints so they can't happen again. Frequently repeated tasks get distilled into Skills or workflows so the Resident doesn't have to rediscover the same approach each time. Dangerous patterns get flagged and blocked before they cause damage.

The key is that none of this requires the Resident to evaluate itself. Execution and judgment are separate. The entity that did the work doesn't grade it.

## How Work Flows

All work enters the system through a single ingress point. There's no side channel, no direct worker invocation from outside. This keeps authority boundaries clean.

When a request arrives, the Resident decides how to handle it. Simple requests get answered directly in the user session. More complex work gets delegated to a Worker, which runs in an isolated session with a scoped context. The Worker completes its task and returns a result. The Resident integrates that result, decides what the user needs to see, and responds. The user never sees the Worker's internal process — only the distilled outcome.

This delegation chain can go deeper. Workers can spawn sub-workers for specialized subtasks. But the authority to create new top-level inbound work stays with the user and the Resident. Workers return results; they don't generate new mandates.

## Design Philosophy

Agent capability is no longer the bottleneck — reliability is. OpenOmni is built on three principles: reliability over raw capability, structure over instructions, and strict separation between execution and judgment.

→ [Design Philosophy](docs/design-philosophy.md)

## Current Status

The core execution runtime is working. Inbound routing, session management, the ChatAgent loop, tool execution, the on-demand worker runtime, and the in-process Resident all function. The single-Resident operational model and the System Governor are early stage — the architectural foundations (event journal, work ledger, verification-gate schemas) are in place, but the feedback loop that makes them meaningful is not wired yet: today nothing consumes the journal, and worker completion claims are not yet verified by code.

Component-level truth lives in [Implementation Status](docs/implementation-status.md) — design docs describe targets; that file says what actually runs.

## Development

```bash
bun install
bun run build
bun test
bun run check-types
bun run format
```

## Further Reading

- [Design Philosophy](docs/design-philosophy.md)
- [Core Model](docs/core-model.md)
- [Usage Model](docs/usage-model.md) — what operating the system looks like from the Owner's seat
- [Agent OS Definition](docs/agent-os-definition.md) — the five duties and five litmus tests behind the "Agent OS" claim, landscape scored
- [Bets and Kill Criteria](docs/bets-and-kill-criteria.md) — standing criticisms, falsifiable hypotheses, and the conditions under which claims get downgraded
- [Architecture Decision Records](docs/design-decisions/index.md) — ADR-010–013 define the target Agent OS model
- [Implementation Status](docs/implementation-status.md) — what actually runs today

## Acknowledgements

OpenOmni's default `web_search` and `web_fetch` tools are powered by [minpeter/opensearch](https://github.com/minpeter/opensearch) through its AI SDK tool package.

## License

MIT
