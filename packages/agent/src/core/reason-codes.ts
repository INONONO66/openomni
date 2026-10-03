/** Closed reason vocabulary shared by policy decisions and loop consumers. */
export const RunReasonCode = {
  /** The run made no progress; the loop reports `stalled`, not a guard abort. */
  Stalled: "stalled",
  /** Budget is nearly spent. */
  BudgetWarning: "budget_warning",
  /** Budget is ample. */
  BudgetReassurance: "budget_reassurance",
} as const;
