/**
 * #807 read-path normalization for delegation rows written before assigned
 * work needed a verified terminal.
 *
 * Pre-#807 an `assign` settled `completed` on the worker's own report. The
 * current `Record` contract refuses that shape, so a stored row must be
 * rewritten BEFORE parsing — the alternative is a parse error that takes the
 * whole delegation table down on boot. The rewrite is the honest reading of
 * what those rows always meant: the worker said it was done and nothing
 * checked it, i.e. `unverified` with reason `legacy_self_report`.
 *
 * Upcast on read, never a migration: the stored bytes stay untouched, so this
 * function must be pure and total. Anything that is not a legacy
 * assign+completed row is returned by identity, including malformed input —
 * rejecting bad rows is the parser's job, not this function's.
 */
export function normalizeLegacyRecord(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.operation !== "assign") return raw;
  const settled = record.settled;
  if (typeof settled !== "object" || settled === null || Array.isArray(settled)) return raw;
  const legacy = settled as Record<string, unknown>;
  if (legacy.status !== "completed") return raw;
  // Key order matters: the settlement's JSON bytes are the settlement identity
  // (kernel wake correlation) and the persisted `data` column, so the rewrite
  // emits the `unverified` arm's declaration order.
  return {
    ...record,
    settled: {
      status: "unverified",
      delegationId: legacy.delegationId,
      ...(legacy.workerRunId === undefined ? {} : { workerRunId: legacy.workerRunId }),
      output: legacy.output,
      at: legacy.at,
      ...(legacy.usage === undefined ? {} : { usage: legacy.usage }),
      reason: "legacy_self_report",
      factIds: [],
    },
  };
}
