export function requireSubAdapter<T>(adapter: T | null | undefined, message: string): T {
  if (!adapter) throw new Error(message);
  return adapter;
}

export function withStoreTimestamps<
  T extends { readonly createdAt?: number; readonly updatedAt?: number },
>(record: T, existing?: T, now = Date.now()): T {
  return {
    ...record,
    createdAt: record.createdAt ?? existing?.createdAt ?? now,
    updatedAt: existing === undefined ? (record.updatedAt ?? now) : now,
  };
}

export function withCreateTimestamps<
  T extends { readonly createdAt?: number; readonly updatedAt?: number },
>(record: T, now = Date.now()): T {
  return {
    ...record,
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? record.createdAt ?? now,
  };
}
