import type { Message } from "@openomni/protocol";
import { isWarmCandidateValid, latestCompactionAnchorId, planAnchoredCut } from "./candidate";
import { prepareSummarizerInput } from "./estimate";
import { withSummarizerDeadline } from "./summary";
import type { CompactionOptions } from "./compact";

/** A warm summary is pinned to the cut anchor, not to later appends. */
export interface CompactionCandidate {
  readonly prefixIds: readonly string[];
  readonly prefixFingerprint: string;
  readonly firstKeptId: string;
  readonly compactionAnchorId: string | undefined;
  readonly anchorBody: string;
}

const MAX_PREPARE_FAILURES = 2;

/** Run-scoped speculative state owned by the compaction apply seam. */
export class CompactionSession {
  readonly #protectRecentMessages: number;
  readonly #summarize: NonNullable<CompactionOptions["onSummarize"]>;
  #candidate: CompactionCandidate | undefined;
  #inFlight = false;
  #failureStreak = 0;
  #generation = 0;
  #controller: AbortController | undefined;
  #preparation = Promise.resolve();
  #started = Promise.resolve();
  #resolveStarted: (() => void) | undefined;

  constructor(config: {
    readonly protectRecentMessages: number;
    readonly summarize: NonNullable<CompactionOptions["onSummarize"]>;
    readonly summarizerDeadlineMs?: number;
  }) {
    this.#protectRecentMessages = config.protectRecentMessages;
    this.#summarize = withSummarizerDeadline(config.summarize, config.summarizerDeadlineMs);
  }

  prepare(
    messages: readonly Message.WithParts[],
    contextTokens: number,
    prepareTokens: number,
    contextWindowTokens: number,
    onFailure?: (error: Error, failureStreak: number) => void,
  ): void {
    if (this.#failureStreak >= MAX_PREPARE_FAILURES) return;
    if (this.#candidate !== undefined && !isWarmCandidateValid(this.#candidate, messages)) {
      this.#candidate = undefined;
    }
    if (this.#inFlight || this.#candidate !== undefined || contextTokens < prepareTokens) return;

    const plan = planAnchoredCut(messages, this.#protectRecentMessages);
    const firstKept = messages[plan?.prefixIds.length ?? -1];
    if (plan === undefined || plan.summarizerInput.length === 0 || firstKept === undefined) return;
    const prepared = prepareSummarizerInput(
      plan.summarizerInput,
      contextWindowTokens,
      plan.previousAnchor,
    );
    if (prepared.messages.length === 0) return;

    this.#inFlight = true;
    this.#started = new Promise<void>((resolve) => {
      this.#resolveStarted = resolve;
    });
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    this.#preparation = Promise.resolve()
      .then(() => {
        this.#resolveStarted?.();
        this.#resolveStarted = undefined;
        if (generation !== this.#generation || controller.signal.aborted) return undefined;
        return this.#summarize(
          prepared.messages,
          plan.previousAnchor,
          prepared.budget,
          controller.signal,
        );
      })
      .then((summary) => {
        if (generation !== this.#generation || summary === undefined) return;
        this.#failureStreak = 0;
        this.#candidate =
          summary.trim().length === 0
            ? undefined
            : {
                prefixIds: plan.prefixIds,
                prefixFingerprint: plan.prefixFingerprint,
                firstKeptId: firstKept.info.id,
                compactionAnchorId: latestCompactionAnchorId(messages),
                anchorBody: summary,
              };
      })
      .catch((error) => {
        if (generation !== this.#generation) return;
        this.#candidate = undefined;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (failure.name === "AbortError") return;
        this.#failureStreak += 1;
        onFailure?.(failure, this.#failureStreak);
      })
      .finally(() => {
        if (generation === this.#generation) {
          this.#inFlight = false;
          this.#controller = undefined;
        }
      });
  }

  candidate(): CompactionCandidate | undefined {
    return this.#candidate;
  }

  inFlight(): boolean {
    return this.#inFlight;
  }

  consume(): void {
    this.#candidate = undefined;
  }

  disable(): void {
    this.#failureStreak = MAX_PREPARE_FAILURES;
    this.abort();
  }

  abort(): void {
    this.#generation += 1;
    this.#candidate = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.#inFlight = false;
  }

  started(): Promise<void> {
    return this.#started;
  }

  settled(): Promise<void> {
    return this.#preparation;
  }
}
