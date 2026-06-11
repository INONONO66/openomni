# Bets and Kill Criteria

This project's founding principle is *evidence over self-report*. This document applies that principle to the project itself: the strongest standing criticisms of the design, the falsifiable bets the impact rests on, and the pre-committed criteria under which claims get downgraded. Written 2026-06-11, after a full adversarial review; revisit at each checkpoint below.

## 1. Standing criticisms (the indictment)

Kept here so they cannot be quietly forgotten. None are refuted yet — they are answered only by the measurements in §2.

1. **An OS with one app is not an OS.** The dispatch "syscall table" currently has exactly one caller — our own Resident. Until third parties target the ABI, "OS" is branding. (→ T1, #216)
2. **The kernel is a convention, not a privilege boundary.** Kernel and userland share one Bun process; only three guarantees are mechanism-enforced today, and the Resident still holds direct MCP tools — a gate with a side door. (→ T2, #218/#221)
3. **`await world` is less novel than claimed.** Temporal/Restate/BPM have done day-scale suspend/resume for years. The genuinely new part — correlating messy human replies — is also the most fragile part: people reply without threads, from other accounts, with no quote. If disambiguation-by-Resident becomes the common case, we built a clerk's inbox, not a primitive. (→ H1)
4. **The evidence loop is statistically anemic at personal scale.** ~10–50 tasks/week fragmented by (cause × task type × executor) gives n=1–3 cells; routing "statistics" are anecdotes; the 2-consecutive-failure ratchet has no statistical power. Model swaps reset evidence (non-stationarity: the ledger may rot faster than it accumulates). The gate verifies *occurrence*, not *quality* — quality judgment still bottoms out in an LLM. "Trust through evidence" is honestly "receipts plus a different LLM's opinion." (→ H2, H3)
5. **The Governor presumes stable root causes; LLM failures are often stochastic.** An LLM writing RCAs over non-reproducible failures risks confabulated causality — plausible post-hoc narratives hardened into policy. Policies accumulate with no garbage collection; the ratchet catches per-change regressions but not gradual ossification. (→ H3, ossification guard)
6. **The single Resident is a bottleneck and an injection surface.** External content flows through worker reports into the judge's context; the gate checks evidence *existence*, not content *safety*. Prompt injection via a seller's reply is the system's most under-addressed threat. (open design item)
7. **The control group is cheap.** Claude Code + cron + a Telegram bot + a notes file covers much of the value if H1/H2 fail. One operator maintains 6 packages + coordinator + governor — the homelab trap: the OS becomes the hobby, not the tool.
8. **Metaphor cosplay risk.** The OS metaphor drove good decisions (chokepoint, journal) and tempts bad ones (QoS classes for 10 concurrent tasks). Guard: every "OS-like" idea must answer *which of T1–T5 does this advance?* No answer → decoration.
9. **Self-serving definition risk.** We defined "Agent OS" ([agent-os-definition.md](agent-os-definition.md)) in a way we are positioned to win. T4 (truth) being the category's missing duty is our belief, not a proven market need — OpenClaw's adoption suggests *presence* wins adoption, not accountability. Our meta-bet: as agents take on consequential work, trust becomes the binding constraint. Guard: external validation signals (does anyone else adopt the connector ABI? does anyone ask for evidence gates?) count more than our own conviction.

## 2. The falsifiable bets

The impact thesis rests on three measurable hypotheses. The ledger itself is the measurement instrument — no extra tooling needed.

| Bet | Claim | Metric | Kill criterion |
|---|---|---|---|
| **H1 — correlation is real** | Replies from humans can be auto-matched to waiting work on messy channels | Auto-match rate of inbound human replies; Resident-disambiguation rate | Auto-match **< 70%** sustained after tuning → `await world` is downgraded from "primitive" to "assisted inbox"; the marketplace-class use case is re-scoped |
| **H2 — autonomy compounds** | Owner's *unplanned* interventions per completed task decline as evidence accumulates | Unplanned-rescue count / completed task, 8-week trend after #213+#215 ship | No downward trend over 8 weeks of regular use → the self-improvement narrative is dropped; Governor scope frozen at reporting |
| **H3 — the Governor is net-positive** | Structural fixes prevent recurrence without ossifying the system | (fixes with recurrence = 0) : (rolled-back fixes) ≥ **3 : 1**, AND active policy count growth does not reduce task throughput | Ratio missed or throughput degrades → Governor demoted to weekly digest generator; fixes become Owner-authored only |

**Checkpoint cadence**
- **C1 — #213 merged**: the dormant-engine pattern (the project's one proven failure mode: engines built, consumers never wired) is broken or repeated. This is the highest-information single event in the roadmap.
- **C2 — #215 + #216 shipped**: T1/T3 inspection; H1 measurement begins.
- **C3 — 8 weeks of regular use after C2**: H2/H3 verdicts; this document gets a Verdict section appended with the numbers.

## 3. Current verdict (pre-data)

- **As a design: A.** The only candidate in the surveyed landscape whose axioms (separation of execution/judgment/improvement, work as the first-class unit, truth as a kernel duty) target the category's unoccupied duties. The substrate (dispatch, hash-chained journal, on-demand workers) is real and audited.
- **As a running system: D+.** Qualification score 0.5/5; every differentiator is still 📋. Today, "use OpenOmni as your Agent OS" cannot be honestly recommended.
- **Deciding variable: not competitors — our own wiring conversion rate.** The most probable failure path is ADR-011~013 becoming the next dormant engines. C1 is the test.

> The honest self-description until T1+T3+T4 pass: **"an evidence-gated personal workflow engine building toward an Agent OS."** The two promises stand regardless of branding: *what you hand over gets finished; the same mistake doesn't happen twice.*
