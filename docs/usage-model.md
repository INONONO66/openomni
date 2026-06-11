# Usage Model — Operating OpenOmni as the Owner

Every other document describes the system from the inside. This one describes it from your seat. For the architecture behind these behaviors, see [Core Model](core-model.md) and [ADR-010](design-decisions/010-agent-os-kernel-model.md); for what is actually implemented today, see [Implementation Status](implementation-status.md) — much of this document describes the target experience.

## The mental model — three things to remember

1. **You talk to one entity.** The Resident, on any channel — Telegram, Discord, CLI. Worker management, retries, and failure handling are not your job.
2. **A request doesn't end when you send it — it ends when the system finishes it.** Work survives your forgetting it, survives server restarts, and wakes up when the world answers.
3. **Your interventions come in two kinds.** Planned approvals (normal, designed) and unplanned rescues (a system defect, recorded as such, expected to decrease).

## What happens when you say something

You never need to classify your own request — the Resident picks the lane. But this is what happens underneath:

| You say | Lane | What happens |
| --- | --- | --- |
| "What was that error about?" | Direct answer | Context + memory + session search. Seconds. |
| "Turn off the lights." / "Reply to B with this." | Dispatch action | No worker — the kernel executes, audits, done. Sensitive actions (first contact with a stranger, spending money) come back as a one-tap approval. |
| "Research competitor pricing." / "Refactor this repo." | Delegated task | A ticket is created (title, completion criteria, executor). It runs in the background; you keep chatting. What returns is a **distilled report that passed an evidence check** — never a process log. |
| "Ask these 3 sellers for price and condition." | Waiting-on-the-world task | Messages go out; the system **sleeps at zero cost**. Replies — even days later — wake exactly the right task. Partial responses are normal; deadlines close the rest. |
| "Brief me on trends every morning at 9." | Scheduled task | Durable cron — the same machinery on a timer. Survives restarts. |
| "Give this one to Claude Code." / "Worker A, change approach." | Direct targeting | Your authority, not a general one. The Resident observes via lineage. |

## When the system talks to you

A noisy inbox is a design failure. Only four kinds of messages reach you:

1. **Results** — "Done. Summary: … Recommendation: …" (deliverable + report, evidence-checked)
2. **Approvals** — one tap: outbound first contacts, spending, loosening permissions
3. **Escalations** — "Tried 3 times, still failing — change approach?" / a question no one else can answer
4. **Weekly digest** — what ran, what failed, what the Governor proposes to change (approve/reject in one place)

## Checking on things

> "What's running?" / "Show open tasks."

```
wi_3f8a  Marketplace price inquiry   ⏸ waiting on replies (2/3)   day 2
wi_9c21  Repo refactor               ▶ running (claude-code)      attempt 2
wi_b771  Weekly trends               ⏰ scheduled Sunday 09:00
```

Who asked for it, who's doing it, what it's blocked on. "Show me Worker A" tails that worker's log on demand — there is no permanent feed.

## When a result isn't right

Just react naturally — every reaction is a signal the system is built to harvest:

- **"Redo this, X is wrong"** → re-dispatched with the issue attached (counts toward the retry limit)
- **You silently fix it yourself** → recorded as `corrected`
- **You use it as-is** → recorded as `adopted`

Corrections are not noise; they are the densest learning signal in the system. A taste-shaped correction becomes memory ("Owner prefers tables"). A defect-shaped one triggers a root-cause analysis and a structural fix — the same mistake should not survive its second occurrence.

## How your role changes over time

```
Month 1   Many approvals, many corrections. You are a supervisor.
          (Every intervention is being recorded and learned from.)
Month 3   Proven task types lose their approval gates — earned, not configured.
          Good workers get promoted; bad patterns get structurally blocked.
Month 6   You set direction. Interventions are reserved for real judgment calls.
```

Autonomy is never granted by a settings toggle; it is earned through ledger evidence and can be revoked by the same evidence.

## Operating tips

1. **Add one line of "done means…" to delegations.** "Research X — across pricing, policy, and recent changes" turns your intent into the acceptance criteria the work is checked against. Skip it and the Resident will define done for you.
2. **Judge results, not process.** Process improvement is the Governor's job. When you do have to dive into the process, that's logged as an unplanned rescue — a defect signal the system must fix.
3. **Don't ration corrections.** Each one compounds.
4. **New channel, device, or CLI app = one adapter.** The core never changes for integrations.

## The two promises

Everything else — the kernel, the ledger, PendingInteraction, the Governor — exists to keep exactly two promises:

> **"What you hand over gets finished."**
> **"The same mistake doesn't happen twice."**
