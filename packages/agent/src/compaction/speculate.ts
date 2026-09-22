import type { Message } from "@openomni/protocol";
import { Effect, Fiber, type Scope } from "effect";
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

/** Speculation is a child of the owning run Scope, never a detached Promise. */
export class CompactionSession {
  readonly #protectRecentMessages: number;
  readonly #summarize: NonNullable<CompactionOptions["onSummarize"]>;
  #candidate: CompactionCandidate | undefined;
  #inFlight = false;
  #failureStreak = 0;
  #generation = 0;
  #preparation: Fiber.RuntimeFiber<void, never> | undefined;
  #entered = true;
  readonly #listeners = new Set<() => void>();

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
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.suspend(() => {
      if (this.#failureStreak >= MAX_PREPARE_FAILURES) return Effect.void;
      if (this.#candidate !== undefined && !isWarmCandidateValid(this.#candidate, messages))
        this.#candidate = undefined;
      if (this.#inFlight || this.#candidate !== undefined || contextTokens < prepareTokens)
        return Effect.void;
      const plan = planAnchoredCut(messages, this.#protectRecentMessages);
      const firstKept = messages[plan?.prefixIds.length ?? -1];
      if (plan === undefined || plan.summarizerInput.length === 0 || firstKept === undefined)
        return Effect.void;
      const prepared = prepareSummarizerInput(plan.summarizerInput, contextWindowTokens, plan.previousAnchor);
      if (prepared.messages.length === 0) return Effect.void;
      this.#inFlight = true;
      this.#entered = false;
      const generation = this.#generation;
      const work = Effect.suspend(() => {
        this.#entered = true;
        for (const notify of this.#listeners) notify();
        return this.#summarize(prepared.messages, plan.previousAnchor, prepared.budget);
      }).pipe(
        Effect.match({
          onSuccess: (summary) => {
            if (generation !== this.#generation) return;
            this.#failureStreak = 0;
            this.#candidate = summary.trim().length === 0 ? undefined : {
              prefixIds: plan.prefixIds,
              prefixFingerprint: plan.prefixFingerprint,
              firstKeptId: firstKept.info.id,
              compactionAnchorId: latestCompactionAnchorId(messages),
              anchorBody: summary,
            };
          },
          onFailure: (error) => {
            if (generation !== this.#generation) return;
            this.#candidate = undefined;
            this.#failureStreak += 1;
            onFailure?.(error, this.#failureStreak);
          },
        }),
        Effect.ensuring(Effect.sync(() => {
          if (generation === this.#generation) this.#inFlight = false;
        })),
      );
      return Effect.forkScoped(work).pipe(Effect.tap((fiber) => Effect.sync(() => {
        this.#preparation = fiber;
      })), Effect.asVoid);
    });
  }

  candidate(): CompactionCandidate | undefined { return this.#candidate; }
  inFlight(): boolean { return this.#inFlight; }
  consume(): void { this.#candidate = undefined; }

  disable(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#failureStreak = MAX_PREPARE_FAILURES;
      return this.abort();
    });
  }

  abort(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.#generation += 1;
      this.#candidate = undefined;
      this.#inFlight = false;
      return this.#preparation === undefined ? Effect.void : Fiber.interrupt(this.#preparation).pipe(Effect.asVoid);
    });
  }

  started(): Effect.Effect<void> {
    return Effect.async((resume) => {
      const notify = () => resume(Effect.void);
      this.#listeners.add(notify);
      if (this.#entered) notify();
      return Effect.sync(() => { this.#listeners.delete(notify); });
    });
  }

  settled(): Effect.Effect<void> {
    return Effect.suspend(() => this.#preparation === undefined ? Effect.void : Fiber.join(this.#preparation));
  }
}
