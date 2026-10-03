import { LedgerInvariant } from "../errors";

export function requireSubAdapter<T>(adapter: T | null | undefined, message: string): T {
  if (!adapter) throw new LedgerInvariant({ operation: "storage.subAdapter", message });
  return adapter;
}

export function withStoreTimestamps<
  T extends { readonly createdAt?: number; readonly updatedAt?: number },
>(record: T, existing: T | undefined, now: number): T {
  return {
    ...record,
    createdAt: record.createdAt ?? existing?.createdAt ?? now,
    updatedAt: existing === undefined ? (record.updatedAt ?? now) : now,
  };
}
