import type { Message } from "@openomni/protocol";
import { planAnchoredCut } from "./compact";

/**
 * Speculative compaction (compaction-design L4, D8; pss-runtime's shipped
 * prepare/promote shape). The expensive summarize call runs in the
 * background once the window passes the prepare ratio, so the apply seam —
 * still the only place history is rewritten — almost never waits on a
 * model call: a fresh candidate promotes with zero model calls.
 *
 * Freshness is span identity: the candidate pins the exact message-id
 * prefix it summarized. In-run ids are stable (append-only history; elision
 * rewrites a part's output, never its id), so the prefix check tolerates
 * both later turns (the candidate cuts less than the natural cutoff would —
 * still a valid, smaller cut) and elision (the candidate summarized the
 * richer pre-elision content). Any history REPLACEMENT (a prior cut) mints
 * new ids and invalidates the candidate structurally.
 *
 * Abort linkage: dispatch contexts are structured-clone frozen, so no
 * AbortSignal can ride them. A prepare in flight when the run ends resolves
 * against per-run state that dies with the run's engine (factory-created
 * registration), and its duration is bounded by the host's completion fn —
 * the same bound the synchronous seam call already has.
 */
export interface CompactionCandidate {
  readonly spanIds: readonly string[];
  readonly anchorBody: string;
}

export interface Speculator {
  /**
   * Fire-and-forget, single-flight. Never throws; failure = no candidate,
   * reported through `onFailure` with the consecutive-failure streak. After
   * MAX_PREPARE_FAILURES consecutive failures speculation stops for the run
   * (#724 review M5): the synchronous seam merge remains, and ITS failure
   * surfaces through the fail-closed bracket — no silent per-turn burn.
   */
  maybePrepare(
    messages: readonly Message.WithParts[],
    contextTokens: number,
    contextWindowTokens: number,
    onFailure?: (error: unknown, failStreak: number) => void,
  ): void;
  peek(): CompactionCandidate | undefined;
  /** The seam consumed (promoted or discarded) whatever was pending. */
  consume(): void;
}

export const DEFAULT_PREPARE_RATIO = 0.65;
const MAX_PREPARE_FAILURES = 2;

function isIdPrefix(spanIds: readonly string[], messages: readonly Message.WithParts[]): boolean {
  if (spanIds.length > messages.length) return false;
  for (let index = 0; index < spanIds.length; index += 1) {
    if (messages[index]?.info.id !== spanIds[index]) return false;
  }
  return true;
}

export function createSpeculator(config: {
  readonly prepareRatio: number;
  readonly protectRecentMessages: number;
  readonly onSummarize: (messages: Message.WithParts[], previousAnchor?: string) => Promise<string>;
}): Speculator {
  let candidate: CompactionCandidate | undefined;
  let inFlight = false;
  let failStreak = 0;

  return {
    maybePrepare(messages, contextTokens, contextWindowTokens, onFailure) {
      if (failStreak >= MAX_PREPARE_FAILURES) return;
      // A candidate whose span is no longer a live prefix (history was
      // replaced) is dead weight — drop it so a fresh prepare can run.
      if (candidate !== undefined && !isIdPrefix(candidate.spanIds, messages)) {
        candidate = undefined;
      }
      if (inFlight || candidate !== undefined) return;
      if (contextTokens < contextWindowTokens * config.prepareRatio) return;

      const plan = planAnchoredCut(messages, config.protectRecentMessages);
      if (plan === undefined || plan.summarizerInput.length === 0) return;

      inFlight = true;
      void config
        .onSummarize(plan.summarizerInput, plan.previousAnchor)
        .then((merged) => {
          failStreak = 0;
          candidate =
            merged.trim().length > 0 ? { spanIds: plan.spanIds, anchorBody: merged } : undefined;
        })
        .catch((error: unknown) => {
          // Absent candidate: the seam falls back to its synchronous merge,
          // which surfaces the same failure through the fail-closed bracket
          // if it repeats there. Nothing to rethrow into — this promise has
          // no awaiter by design; the streak caps the retry burn.
          candidate = undefined;
          failStreak += 1;
          onFailure?.(error, failStreak);
        })
        .finally(() => {
          inFlight = false;
        });
    },
    peek: () => candidate,
    consume: () => {
      candidate = undefined;
    },
  };
}
