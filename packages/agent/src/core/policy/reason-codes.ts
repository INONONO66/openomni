/**
 * The reason codes the run loop branches on.
 *
 * These are not diagnostics. The loop reads them out of a decision to pick a
 * terminal `finishReason`, to decide whether an abort was a guard's doing, and
 * to emit budget telemetry — and the policies that produce them live in
 * another package (D5: opinions register from the product side). A bare string
 * on both ends of that boundary fails in the worst direction: rename the
 * producer's literal and nothing breaks the build, the loop just stops
 * reacting, and a stalled run records itself as an ordinary stop.
 *
 * So the vocabulary is closed and single-sourced. `script/lint-guards.ts`
 * rejects these values written as literals at producer (`reasonCodes:`) and
 * consumer (comparison / `.includes`) positions in shipped source; the test
 * pins asserting the raw strings are the layer that locks the values.
 */
export const RunReasonCode = {
  /** The run made no progress; the loop reports `stalled`, not a guard abort. */
  Stalled: "stalled",
  /** Budget is nearly spent; the loop emits `AgentExecution.BudgetWarning`. */
  BudgetWarning: "budget_warning",
  /** Budget is ample; the loop emits `AgentExecution.BudgetReassurance`. */
  BudgetReassurance: "budget_reassurance",
} as const;
