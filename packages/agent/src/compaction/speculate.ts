import type { Message } from "@openomni/protocol";
import {
  isWarmCandidateValid,
  latestCompactionAnchorId,
  planAnchoredCut,
  prepareSummarizerInput,
  type CompactionOptions,
} from "./compact";

/** A warm summary is pinned to the cut anchor, not to later appends. */
export interface CompactionCandidate {
  readonly prefixIds: readonly string[];
  readonly prefixFingerprint: string;
  readonly firstKeptId: string;
  readonly compactionAnchorId: string | undefined;
  readonly anchorBody: string;
}

export interface Speculator {
  maybePrepare(
    messages: readonly Message.WithParts[],
    contextTokens: number,
    prepareTokens: number,
    contextWindowTokens: number,
    onFailure?: (error: unknown, failStreak: number) => void,
  ): void;
  peek(): CompactionCandidate | undefined;
  isInFlight(): boolean;
  consume(): void;
  disable(): void;
  abort(): void;
  started(): Promise<void>;
  settled(): Promise<void>;
}

const MAX_PREPARE_FAILURES = 2;

export function createSpeculator(config: {
  readonly protectRecentMessages: number;
  readonly onSummarize: NonNullable<CompactionOptions["onSummarize"]>;
}): Speculator {
  let candidate: CompactionCandidate | undefined;
  let inFlight = false;
  let failStreak = 0;
  let generation = 0;
  let controller: AbortController | undefined;
  let preparation = Promise.resolve();
  let started = Promise.resolve();
  let resolveStarted: (() => void) | undefined;

  return {
    maybePrepare(messages, contextTokens, prepareTokens, contextWindowTokens, onFailure) {
      if (failStreak >= MAX_PREPARE_FAILURES) return;
      if (candidate !== undefined && !isWarmCandidateValid(candidate, messages)) {
        candidate = undefined;
      }
      if (inFlight || candidate !== undefined || contextTokens < prepareTokens) return;

      const plan = planAnchoredCut(messages, config.protectRecentMessages);
      const firstKept = messages[plan?.prefixIds.length ?? -1];
      if (plan === undefined || plan.summarizerInput.length === 0 || firstKept === undefined)
        return;
      const prepared = prepareSummarizerInput(
        plan.summarizerInput,
        contextWindowTokens,
        plan.previousAnchor,
      );
      if (prepared.messages.length === 0) return;

      inFlight = true;
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const runGeneration = generation;
      const preparationController = new AbortController();
      controller = preparationController;
      preparation = Promise.resolve()
        .then(() => {
          resolveStarted?.();
          resolveStarted = undefined;
          if (runGeneration !== generation || preparationController.signal.aborted)
            return undefined;
          return config.onSummarize(
            prepared.messages,
            plan.previousAnchor,
            prepared.budget,
            preparationController.signal,
          );
        })
        .then((merged) => {
          if (runGeneration !== generation || merged === undefined) return;
          failStreak = 0;
          candidate =
            merged.trim().length > 0
              ? {
                  prefixIds: plan.prefixIds,
                  prefixFingerprint: plan.prefixFingerprint,
                  firstKeptId: firstKept.info.id,
                  compactionAnchorId: latestCompactionAnchorId(messages),
                  anchorBody: merged,
                }
              : undefined;
        })
        .catch((error: unknown) => {
          if (runGeneration !== generation) return;
          candidate = undefined;
          if (error instanceof Error && error.name === "AbortError") return;
          failStreak += 1;
          onFailure?.(error, failStreak);
        })
        .finally(() => {
          if (runGeneration === generation) {
            inFlight = false;
            controller = undefined;
          }
        });
    },
    peek: () => candidate,
    isInFlight: () => inFlight,
    consume: () => {
      candidate = undefined;
    },
    disable: () => {
      failStreak = MAX_PREPARE_FAILURES;
      generation += 1;
      candidate = undefined;
      controller?.abort();
      controller = undefined;
      inFlight = false;
    },
    abort: () => {
      generation += 1;
      candidate = undefined;
      controller?.abort();
      controller = undefined;
      inFlight = false;
    },
    started: () => started,
    settled: () => preparation,
  };
}
