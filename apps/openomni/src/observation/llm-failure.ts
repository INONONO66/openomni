/** Channel rendering of kernel-classified failures; raw provider details stay private. */

import { failureFacts } from "@openomni/agent";
import { Retry } from "@openomni/llm";

/** How the classified failure reads to the person who asked for the turn. */
export interface ClassifiedFailure {
  /** The closed llm-package class this failure was decided to be. */
  readonly reason: Retry.Reason;
  /** The channel-visible message. */
  readonly text: string;
}

function attemptClause(error: unknown): string {
  const facts = failureFacts(error);
  // No decided facts means the run died before any retry decision — saying
  // "tried 1 time" would be a claim the run never made.
  if (facts === undefined) return "";
  return facts.attempt === 1 ? ", tried once" : `, tried ${facts.attempt} times`;
}

/**
 * Classifies a terminal turn failure into the message the channel shows.
 *
 * Hedging is deliberate and load-bearing on the billing arm: an unambiguous
 * exhaustion signal (the llm package's `billing` class) states the account is
 * spent, while payment-required status only suggests it — telling an operator
 * their balance is gone when it might be a card decline sends them to the
 * wrong place. These messages never include a thrown error's raw details.
 */
export function classifyTurnFailure(error: unknown): ClassifiedFailure {
  const reason = Retry.classifyFailure(error);
  switch (reason) {
    case "rate_limit":
      return {
        reason,
        text: `I could not answer: the model provider rate limited upstream${attemptClause(error)}. Nothing is wrong with the request — retry in a moment.`,
      };
    case "billing":
      return {
        reason,
        text: paymentRequired(error)
          ? "I could not answer: the provider returned payment required, so the account's quota or balance may be exhausted — check provider account. (402 Payment Required)"
          : "I could not answer: the provider reports quota/billing exhausted — check provider account balance or limits. Retrying will not help until it is topped up.",
      };
    case "content_policy":
      return {
        reason,
        text: "I could not answer: the provider refused this request on content policy grounds. The same prompt will be refused again — rephrase or change what is being asked.",
      };
    case "overloaded":
    case "server_error":
      return {
        reason,
        text: `I could not answer: the model provider failed server-side${attemptClause(error)}. This is upstream, not your request — retry shortly.`,
      };
    case "validation_error":
    case "non_retryable":
      return {
        reason,
        text: unclassifiedText(error),
      };
  }
}

/**
 * The residue: no provider facts to classify by. A 402 is the one status that
 * MIGHT be a spent balance and might be a declined card, so it is hedged
 * rather than either asserted or hidden.
 */
function unclassifiedText(error: unknown): string {
  if (paymentRequired(error)) {
    return "I could not answer: the provider returned payment required, so the account's quota or balance may be exhausted — check provider account. (402 Payment Required)";
  }
  return "I could not answer: I could not reach the model. Retry shortly.";
}

/**
 * Read structurally from the error, never from prose: an AI SDK error carries
 * `statusCode` on the object, and the package's typed one carries it under
 * `.data`. Cause links are walked for the same reason the llm classifier
 * walks them — the status can sit one wrapper down.
 */
function paymentRequired(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("statusCode" in current && current.statusCode === 402) return true;
    if ("data" in current && typeof current.data === "object" && current.data !== null &&
      "statusCode" in current.data && current.data.statusCode === 402) return true;
    const cause = "cause" in current ? current.cause : undefined;
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
}
