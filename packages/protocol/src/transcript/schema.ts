import { z } from "zod";
import { Message } from "../message/index.js";

/**
 * Transcript fact vocabulary (#545 T1): conversation history as an
 * append-only fact stream. Facts are immutable records — once emitted they
 * are never mutated, so the fold may share their objects into folded state.
 *
 * `Usage` is a transcript-owned shape on purpose: token/ later exits to the
 * llm package (#497) and ring-0 facts cannot reference llm, so the finish
 * fact carries this minimal shape instead of Token.Count.
 */

const Id = z.string().min(1);
const TokenCount = z.number().int().nonnegative();

export const Usage = z
  .object({
    input: TokenCount,
    output: TokenCount,
    reasoning: TokenCount,
    cache: z
      .object({
        read: TokenCount,
        write: TokenCount,
      })
      .strict(),
  })
  .strict();
export type Usage = z.infer<typeof Usage>;

/**
 * Part lifecycle transitions. These mirror Tool.State statuses plus
 * "interrupted" (abort mid-flight). `at` is epoch ms, always an input —
 * the fold never reads a clock.
 */
const TransitionRunning = z
  .object({
    to: z.literal("running"),
    at: z.number(),
  })
  .strict();

const TransitionCompleted = z
  .object({
    to: z.literal("completed"),
    at: z.number(),
    output: z.string(),
    title: z.string().optional(),
    /**
     * Provider reasoning signature — arrives at stream end, so the completed
     * transition is its carrier fact. Projected onto ReasoningPart.signature;
     * ignored for text and tool parts.
     */
    signature: z.string().optional(),
  })
  .strict();

const TransitionError = z
  .object({
    to: z.literal("error"),
    at: z.number(),
    error: z.string(),
  })
  .strict();

const TransitionInterrupted = z
  .object({
    to: z.literal("interrupted"),
    at: z.number(),
    partialOutput: z.string().optional(),
  })
  .strict();

export const PartTransition = z.discriminatedUnion("to", [
  TransitionRunning,
  TransitionCompleted,
  TransitionError,
  TransitionInterrupted,
]);
export type PartTransition = z.infer<typeof PartTransition>;

export const FinishReason = z.enum(["stop", "length", "error", "aborted"]);
export type FinishReason = z.infer<typeof FinishReason>;

const MessageCreatedFact = z
  .object({
    type: z.literal("message.created"),
    attemptId: Id,
    message: Message.Info,
  })
  .strict();

const PartAppendedFact = z
  .object({
    type: z.literal("part.appended"),
    attemptId: Id,
    messageId: Id,
    part: Message.Part,
  })
  .strict();

const PartAdvancedFact = z
  .object({
    type: z.literal("part.advanced"),
    attemptId: Id,
    messageId: Id,
    partId: Id,
    transition: PartTransition,
  })
  .strict();

/**
 * Terminal fact for an attempt's message: carries the finish reason and the
 * attempt's usage, replacing in-place info mutation. `at` (epoch ms) is the
 * completion instant — the only fact that needs its own timestamp because
 * neither the finish reason nor the usage carries one.
 */
const MessageFinishedFact = z
  .object({
    type: z.literal("message.finished"),
    attemptId: Id,
    messageId: Id,
    at: z.number(),
    finish: FinishReason,
    usage: Usage,
  })
  .strict();

export const Fact = z.discriminatedUnion("type", [
  MessageCreatedFact,
  PartAppendedFact,
  PartAdvancedFact,
  MessageFinishedFact,
]);
export type Fact = z.infer<typeof Fact>;
