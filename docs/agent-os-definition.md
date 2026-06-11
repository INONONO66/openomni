# What Is an Agent OS — Definition and Qualification Tests

OpenOmni's stated target category is "Agent OS." This document defines the term functionally — metaphor stripped — so the claim is checkable rather than rhetorical. The project's own scorecard is at the bottom; it is not flattering, by design.

## 1. What an OS functionally is

What makes an OS an OS is five duties:

1. **Multiplexing** — scarce resources (CPU, memory) shared by many programs.
2. **Protection** — programs cannot corrupt each other or the kernel, **by mechanism, not convention**.
3. **Abstraction (ABI)** — stable interfaces (syscalls, files, processes) so programs are portable across hardware.
4. **Lifecycle** — creation, scheduling, termination, recovery.
5. **Running programs it did not write.** Third-party code is the defining customer. A system that only runs its own program is firmware.

## 2. Translating the resources

The classical OS protected memory and CPU. The agent world's scarce resources are different:

| Classical OS | Agent OS |
|---|---|
| CPU cycles | **Money / tokens** (inference cost) |
| RAM | **Context window + memory** |
| Device access | **The principal's authority** — accounts, funds, channels, relationships, reputation |
| Process time | **Real-world time** (human replies take days) |
| — (not needed) | **Truth** — see below |

The last row is the category's genuinely new duty. **A classical OS never needed a truth layer because a CPU does not lie about its exit code.** Agents are stochastic, self-interested reporters; "done" can be false. An OS that runs programs capable of lying acquires a duty no prior OS had: **verification**.

## 3. Definition

> **An Agent OS is the privileged layer that lets agents it did not write share one principal's authority, money, channels, and memory — meterable and revocable (multiplexing); that bounds a malicious agent's blast radius by mechanism (protection); that exposes a stable command interface (ABI); that keeps commitments alive on real-world timescales (lifecycle); and that mechanically verifies the effects agents claim (truth).**

Compressed:

> **The classical OS protected programs from each other. The Agent OS protects the principal from their own agents.** The protected resource moved from memory to authority; the new duty is truth.

## 4. The five litmus tests

A system qualifies only by passing all five. This turns "is it an Agent OS?" from a vocabulary debate into an inspection.

| # | Test | Question |
|---|---|---|
| **T1** | Third-party | Can I *install* an agent I did not write and have it run under enforced limits? |
| **T2** | Hostile program | If that agent is malicious, is the damage bounded by mechanism — not by prompt? |
| **T3** | Power loss | Do commitments (schedules, pending replies, in-flight work) survive a reboot? |
| **T4** | Liar | If an agent claims false completion, does the structure catch it? |
| **T5** | Multiplexing | Do multiple agents share budgets, authority, and channels without trampling each other? |

## 5. The landscape, scored

| System | What it actually is | Passes |
|---|---|---|
| LangGraph / AutoGen | **Framework** (library) — your process, your agents, no protection boundary | — |
| Temporal / Restate | **Durable scheduler** — T3 at full marks; trusts its activities; no authority model, no truth layer, no agent abstraction | T3 |
| Claude Code | **Single-program runtime** (shell + one process) — permissions and sandbox exist, but one agent, one session | partial T2 |
| OpenClaw | **Gateway + companion** — session-centric; ClawHub gives real one-click installs, but skills land in a full-trust context (install without enforced limits); main session = full host access | partial T1 |
| Hermes-Agent | **Self-improving companion** — agent-curated memory; the agent grades and improves itself (self-report as the learning input) | — |
| AIOS-style papers | **Inference scheduler** — kernel for LLM calls; no authority or truth | partial T5 |
| Karpathy "LLM OS" | A different layer entirely (model-as-CPU metaphor) | n/a |

**No existing system passes all five.** The term "Agent OS" is today mostly marketing — and simultaneously a real, unoccupied category. The unoccupied duties are specifically **T4 (truth)** and the authority form of **T1/T5** (multiplexing a principal's life, not a machine's).

A note on trust direction, since it is the deepest split in the landscape: companion systems (OpenClaw, Hermes) are built on *trusting* the agent — its reports, its self-curated memory, its self-improved skills. OpenOmni is built on *not trusting* it: execution, judgment, and improvement are separated, and completion claims must survive an evidence gate. This is an axiom difference, not a feature difference, which is why it is expensive to retrofit in either direction.

## 6. OpenOmni scorecard

Honest as of 2026-06-12. Component truth: [implementation-status.md](implementation-status.md).

| Test | Today | Path |
|---|---|---|
| T1 third-party | ❌ zero installed apps | #216 — `AppConnector` definition as the public ABI; install = detect → register → consent → wire → smoke-verify |
| T2 hostile program | ⚠️ partial — worker-spawn denial, budget hard-stop, tool-guard are mechanisms; but kernel/userland share one process and the Resident still holds direct MCP tools | #218, #221. Full T2 (process-isolation-grade) is honestly long-term; this is a single-Owner trust boundary by design |
| T3 power loss | ⚠️ partial — durable cron jobs persist and boot starts a runner for due schedules; PendingInteraction restoration still does not exist | #215 + #217 |
| T4 liar | ❌ false claims pass today | **#213 — the category's unoccupied duty, and this project's most original contribution** |
| T5 multiplexing | ⚠️ token budgets only | #219, #221 |

**Score: 0.5 / 5 today. Designed path: ~4 / 5.** The project may call itself an Agent OS when T1, T3, and T4 pass; until then the honest description is *"an evidence-gated personal workflow engine building toward an Agent OS."*

The bets this depends on — and the criteria under which we abandon the claim — live in [Bets and Kill Criteria](bets-and-kill-criteria.md).
