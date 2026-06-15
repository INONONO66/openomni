import type { QueryOptions } from "./query-contracts.js";

type SqlValue = string | number;

export function buildEventFilters(
  scopedColumn: "session_id" | "run_id",
  scopedValue: string,
  options: QueryOptions | undefined,
): { where: string; params: SqlValue[] } {
  const clauses = [`${scopedColumn} = ?`];
  const params: SqlValue[] = [scopedValue];

  if (options?.type !== undefined) {
    clauses.push("event_type = ?");
    params.push(options.type);
  }
  if (options?.category !== undefined) {
    clauses.push("category = ?");
    params.push(options.category);
  }
  if (options?.after !== undefined) {
    clauses.push("time_created > ?");
    params.push(options.after);
  }
  if (options?.before !== undefined) {
    clauses.push("time_created < ?");
    params.push(options.before);
  }
  if (options?.limit !== undefined) {
    params.push(options.limit);
  }

  return { where: clauses.join(" AND "), params };
}

export function limitClause(options: QueryOptions | undefined): string {
  return options?.limit === undefined ? "" : " LIMIT ?";
}
