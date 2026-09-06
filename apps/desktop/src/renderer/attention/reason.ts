import type { AttentionClass, EpochMs, SessionFacts, Signals } from "./score";

/**
 * Why a row sits where it sits, as one muted line of text.
 *
 * Every ranking decision the engine makes has to be sayable in a phrase, or the
 * ranking is not something the Owner can trust or correct. That constraint is
 * the reason this module exists next to the scorer instead of inside the view:
 * a class that cannot produce a reason string is a class that should not exist.
 *
 * `running` is the one class whose phrase is EMPTY, and that is the constraint
 * being honoured rather than waived. Its reason is that it is running right
 * now, and the row already carries that claim as the system's one accent mark
 * beside the very line the phrase would occupy (DESIGN.md §2, the accent
 * budget). Printing the word too is the same fact stated twice, on precisely
 * the rows that are busiest — so the mark keeps the claim and the line stays
 * empty. The word survives in the accessibility tree, where the mark cannot go
 * (`shell/session-tree.tsx`).
 */
export function reasonFor(
  attentionClass: AttentionClass,
  facts: SessionFacts,
  signals: Signals,
): string {
  const snoozedUntil = signals.snoozes.get(facts.id);
  if (attentionClass === "settled" && snoozedUntil !== undefined && snoozedUntil > signals.now) {
    return `snoozed until ${clockTime(snoozedUntil)}`;
  }

  switch (attentionClass) {
    case "pinned":
      return "pinned";
    case "waiting":
      return `waiting for you · ${age(signals.now - facts.lastEventAt)}`;
    case "interrupted":
      return `interrupted · ${age(signals.now - facts.lastEventAt)}`;
    case "finished":
      return `finished · ${age(signals.now - facts.lastEventAt)}`;
    case "running":
      return "";
    case "settled":
      return `done · ${age(signals.now - facts.lastEventAt)}`;
    default:
      return unreachable(attentionClass);
  }
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Coarse ages, deliberately. "23m" and "24m" are the same fact to a person
 * deciding what to open next, and a second-precision age is a number that
 * changes under the cursor for no informational gain.
 */
function age(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/** 24-hour wall clock in UTC: the engine is pure, so it owns no locale. */
function clockTime(at: EpochMs): string {
  const date = new Date(at);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function unreachable(value: never): never {
  throw new Error(`no reason for attention class: ${JSON.stringify(value)}`);
}
