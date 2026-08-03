import { z } from "zod";
import {
  JsonValueSchema,
  Sha256DigestSchema,
  freezeJson,
  hashCanonicalJson,
  snapshotFirstJsonSchema,
  type JsonValue,
} from "./verifier-conformance-canonical.js";
import { failReplayConformance } from "./verifier-conformance-replay.js";

const CommutativeEventContract = z
  .object({
    id: z.string().min(1).max(256),
    commutativeGroup: z.string().min(1).max(256).optional(),
    value: JsonValueSchema,
  })
  .strict();
export const CommutativeEventSchema = snapshotFirstJsonSchema(
  JsonValueSchema.pipe(CommutativeEventContract),
);
type CommutativeEventShape = z.infer<typeof CommutativeEventSchema>;
export type CommutativeEvent = Readonly<Omit<CommutativeEventShape, "value">> & {
  readonly value: JsonValue;
};

const InterleavingPlanContract = z
  .object({
    seed: z.number().int().safe(),
    iterations: z.number().int().safe().min(1).max(1_000),
    initialFold: JsonValueSchema,
    events: z.array(CommutativeEventSchema).max(256),
  })
  .strict()
  .refine(
    (plan) => new Set(plan.events.map((event) => event.id)).size === plan.events.length,
    "duplicate event id",
  );
export const InterleavingPlanSchema = snapshotFirstJsonSchema(
  JsonValueSchema.pipe(InterleavingPlanContract),
);
const InterleavingReportContract = z
  .object({
    seed: z.number().int().safe(),
    iterations: z.number().int().safe().positive().max(1_000),
    baselineHash: Sha256DigestSchema,
    interleavingHashes: z.array(Sha256DigestSchema).max(1_000),
  })
  .strict();
export const InterleavingReportSchema = snapshotFirstJsonSchema(
  JsonValueSchema.pipe(InterleavingReportContract),
);
type InterleavingPlanShape = z.infer<typeof InterleavingPlanSchema>;
type InterleavingReportShape = z.infer<typeof InterleavingReportSchema>;
export type InterleavingPlan = Readonly<Omit<InterleavingPlanShape, "initialFold" | "events">> & {
  readonly initialFold: JsonValue;
  readonly events: readonly CommutativeEvent[];
};
export type InterleavingReport = Readonly<Omit<InterleavingReportShape, "interleavingHashes">> & {
  readonly interleavingHashes: readonly string[];
};
export type FoldReducer = (state: JsonValue, event: CommutativeEvent) => JsonValue;
const MAX_INTERLEAVING_FOLD_NODES = 1_000_000;
type FoldBudget = { remainingNodes: number };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled(
  events: readonly CommutativeEvent[],
  random: () => number,
  iteration: number,
): CommutativeEvent[] {
  const result = [...events];
  for (let start = 0; start < result.length; ) {
    const group = result[start]?.commutativeGroup;
    if (group === undefined) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (result[end]?.commutativeGroup === group) end += 1;
    if (iteration === 0 && end - start > 1) {
      const reversed = result.slice(start, end).reverse();
      result.splice(start, reversed.length, ...reversed);
    } else {
      for (let index = end - 1; index > start; index -= 1) {
        const swapIndex = start + Math.floor(random() * (index - start + 1));
        const left = result[index];
        const right = result[swapIndex];
        if (left === undefined || right === undefined) throw new Error("invalid shuffle index");
        result[index] = right;
        result[swapIndex] = left;
      }
    }
    start = end;
  }
  return result;
}

function fold(
  initial: JsonValue,
  events: readonly CommutativeEvent[],
  reducer: FoldReducer,
  budget: FoldBudget,
): JsonValue {
  let state = initial;
  for (const event of events) {
    state = freezeJson(reducer(state, Object.freeze(event)));
    chargeFoldNodes(state, budget);
  }
  return state;
}

function chargeFoldNodes(value: JsonValue, budget: FoldBudget): void {
  budget.remainingNodes -= 1;
  if (budget.remainingNodes < 0) throw new Error("interleaving fold work budget exceeded");
  if (value === null || typeof value !== "object") return;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    chargeFoldNodes(nested, budget);
  }
}

export function fuzzCommutativeInterleavings(
  planInput: InterleavingPlan,
  reducer: FoldReducer,
): InterleavingReport {
  const plan = InterleavingPlanSchema.parse(planInput);
  const budget = { remainingNodes: MAX_INTERLEAVING_FOLD_NODES };
  const baselineHash = hashCanonicalJson(fold(plan.initialFold, plan.events, reducer, budget));
  const random = seededRandom(plan.seed);
  const interleavingHashes: string[] = [];
  for (let iteration = 0; iteration < plan.iterations; iteration += 1) {
    const actualHash = hashCanonicalJson(
      fold(plan.initialFold, shuffled(plan.events, random, iteration), reducer, budget),
    );
    interleavingHashes.push(actualHash);
    if (actualHash !== baselineHash) {
      failReplayConformance({
        version: "replay-divergence-v1",
        kind: "interleaving_mismatch",
        expectedHash: baselineHash,
        actualHash,
        seed: plan.seed,
        iteration,
      });
    }
  }
  const report = InterleavingReportSchema.parse({
    seed: plan.seed,
    iterations: plan.iterations,
    baselineHash,
    interleavingHashes,
  });
  Object.freeze(report.interleavingHashes);
  return Object.freeze(report);
}
